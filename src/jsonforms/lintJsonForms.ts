import { applyRuleLevels } from "../rules";
import type { RuleLevel } from "../rules";
import { findConditionImpossibilities, findNullConstPaths, isNonTrivialCondition } from "../schema/conditions";
import type { ConditionImpossibility } from "../schema/conditions";
import { allowedValues, asSchemaObject, decodePointerSegment, deepEqual, deref, formatValue, isObject, joinPointer } from "../schema/json";
import { lintSchema } from "../schema/lintSchema";
import { collectProperties, unconditionallyRequiredNames } from "../schema/properties";
import { resolveScope } from "../schema/scope";
import type { ResolvedScope } from "../schema/scope";
import { didYouMean } from "../suggest";
import type { Diagnostic, JsonObject } from "../types";

export interface JsonFormsInput {
  schema: unknown;
  uischema?: unknown;
  /**
   * Per-rule level. `off` drops the diagnostic. `warning` and `error` replace its severity.
   * Use `{ "jsonforms/required-hideable": "off" }` when the app already filters validation
   * errors for hidden fields. Unknown ids throw, so a typo cannot hide a finding.
   */
  rules?: Readonly<Record<string, RuleLevel>>;
}

type Effect = "SHOW" | "HIDE" | "ENABLE" | "DISABLE";

interface RuleInfo {
  effect: Effect;
  path: string;
  /** The condition can never be true, so the effect never applies. */
  never: boolean;
}

interface ConditionOutcome {
  never: boolean;
}

interface WalkContext {
  documentRoot: JsonObject;
  diagnostics: Diagnostic[];
}

const EFFECTS: readonly Effect[] = ["SHOW", "HIDE", "ENABLE", "DISABLE"];

const NEVER_CONSEQUENCE: Record<Effect, string> = {
  SHOW: "the element is always hidden",
  HIDE: "the element is never hidden",
  ENABLE: "the element is always disabled",
  DISABLE: "the element is never disabled",
};

const POSSIBLE: ConditionOutcome = { never: false };

const report = (context: WalkContext, diagnostic: Omit<Diagnostic, "document">): void => {
  context.diagnostics.push({ document: "uischema", ...diagnostic });
};

const scopeLabel = (scope: string, resolved: ResolvedScope): string =>
  resolved.propertyName === undefined ? `\`${scope}\`` : `\`${resolved.propertyName}\``;

const reportUnresolvedScope = (scope: string, path: string, scopeRoot: JsonObject, context: WalkContext): void => {
  const pointer = scope.startsWith("/") ? `#${scope}` : scope;
  const segments = pointer.startsWith("#/") ? pointer.slice(2).split("/").map(decodePointerSegment) : [];
  const missingName = segments.at(-1);
  const parentScope = segments.length >= 2 ? `#/${segments.slice(0, -2).join("/")}` : "#";
  const parent = resolveScope(scopeRoot, parentScope === "#/" ? "#" : parentScope, context.documentRoot);
  const candidates = parent ? collectProperties(parent.schema, context.documentRoot).keys() : [];

  report(context, {
    ruleId: "jsonforms/unresolved-scope",
    severity: "error",
    path,
    message: `Scope \`${scope}\` doesn't point at anything in the schema, so JSON Forms can't bind it.`,
    suggestion: (missingName && didYouMean(missingName, candidates)) ?? "Check the property path against the JSON Schema.",
  });
};

const reportImpossibility = (problem: ConditionImpossibility, effect: Effect, path: string, context: WalkContext): void => {
  const message = problem.passesWhenEmpty
    ? `This condition can only be true while ${problem.subject} is empty: ${problem.detail}. The ${effect} rule applies until the user fills it in, then never again.`
    : `This condition can never be true: ${problem.detail}. As a result, ${NEVER_CONSEQUENCE[effect]}.`;
  report(context, { ruleId: "jsonforms/impossible-condition", severity: "error", path, message });
};

const analyzeLeafCondition = (condition: JsonObject, effect: Effect, path: string, scopeRoot: JsonObject, context: WalkContext): ConditionOutcome => {
  if (typeof condition.scope !== "string") return POSSIBLE;
  const resolved = resolveScope(scopeRoot, condition.scope, context.documentRoot);
  if (!resolved) {
    reportUnresolvedScope(condition.scope, joinPointer(path, "scope"), scopeRoot, context);
    return POSSIBLE;
  }
  const allowed = allowedValues(resolved.schema);
  if (!allowed || allowed.some((value) => deepEqual(value, condition.expectedValue))) return POSSIBLE;

  reportImpossibility(
    {
      subject: scopeLabel(condition.scope, resolved),
      detail: `${formatValue(condition.expectedValue)} is not one of the values the field allows`,
      passesWhenEmpty: false,
    },
    effect,
    joinPointer(path, "expectedValue"),
    context,
  );
  return { never: true };
};

const analyzeSchemaCondition = (condition: JsonObject, effect: Effect, path: string, scopeRoot: JsonObject, context: WalkContext): ConditionOutcome => {
  if (typeof condition.scope !== "string") return POSSIBLE;
  const { scope } = condition;
  const resolved = resolveScope(scopeRoot, scope, context.documentRoot);
  if (!resolved) {
    reportUnresolvedScope(scope, joinPointer(path, "scope"), scopeRoot, context);
    return POSSIBLE;
  }

  const schemaPath = joinPointer(path, "schema");
  const failWhenUndefined = condition.failWhenUndefined === true;
  const problems = findConditionImpossibilities(condition.schema, resolved.schema, {
    documentRoot: context.documentRoot,
    subject: scope === "#" ? "the value" : scopeLabel(scope, resolved),
    passesWhenEmpty: scope !== "#" && !failWhenUndefined,
  });
  problems.forEach((problem) => reportImpossibility(problem, effect, schemaPath, context));

  for (const nullPath of findNullConstPaths(condition.schema)) {
    report(context, {
      ruleId: "jsonforms/null-means-absent",
      severity: "warning",
      path: `${schemaPath}${nullPath}`,
      message: "`const: null` matches an explicit null, not an empty field. JSON Forms leaves unanswered fields undefined, so this check won't match them.",
      suggestion: 'To react to an empty field, scope the condition to the parent object and use `not: { required: ["<field>"] }`.',
    });
  }

  const emptyPassesSilently = scope !== "#" && !failWhenUndefined && problems.length === 0 && isNonTrivialCondition(condition.schema);
  if (emptyPassesSilently) {
    report(context, {
      ruleId: "jsonforms/empty-field-passes",
      severity: "warning",
      path,
      message: `While ${scopeLabel(scope, resolved)} is empty, this condition passes because JSON Schema ignores missing values, so the ${effect} rule applies before the user has answered.`,
      suggestion: "Add `failWhenUndefined: true` to the condition if the rule should wait for an answer.",
    });
  }

  return { never: problems.some((problem) => !problem.passesWhenEmpty) };
};

const analyzeCondition = (condition: unknown, effect: Effect, path: string, scopeRoot: JsonObject, context: WalkContext): ConditionOutcome => {
  if (!isObject(condition)) return POSSIBLE;

  if ((condition.type === "OR" || condition.type === "AND") && Array.isArray(condition.conditions)) {
    const outcomes = condition.conditions.map((child, index) =>
      analyzeCondition(child, effect, joinPointer(path, "conditions", index), scopeRoot, context),
    );
    const never = condition.type === "OR" ? outcomes.every((outcome) => outcome.never) : outcomes.some((outcome) => outcome.never);
    return { never };
  }
  if (condition.type === "LEAF") return analyzeLeafCondition(condition, effect, path, scopeRoot, context);
  return analyzeSchemaCondition(condition, effect, path, scopeRoot, context);
};

const analyzeRule = (rule: unknown, path: string, scopeRoot: JsonObject, context: WalkContext): RuleInfo | undefined => {
  if (!isObject(rule)) return undefined;
  const effect = EFFECTS.find((candidate) => candidate === rule.effect);
  if (!effect) {
    report(context, {
      ruleId: "jsonforms/unknown-effect",
      severity: "error",
      path: joinPointer(path, "effect"),
      message: `Rule effect ${formatValue(rule.effect)} isn't one of ${EFFECTS.join(", ")}, so the rule does nothing.`,
    });
    return undefined;
  }
  const { never } = analyzeCondition(rule.condition, effect, joinPointer(path, "condition"), scopeRoot, context);
  return { effect, path, never };
};

const describeRuleLocation = (rule: RuleInfo, controlPath: string): string =>
  rule.path === joinPointer(controlPath, "rule") ? "on this control" : `at \`${rule.path}\``;

const checkRequiredVisibility = (resolved: ResolvedScope, rules: RuleInfo[], path: string, context: WalkContext): void => {
  const { parent, propertyName, schema } = resolved;
  if (!parent || propertyName === undefined) return;
  if (!unconditionallyRequiredNames(parent, context.documentRoot).includes(propertyName) || "default" in schema) return;

  const hidingRule = rules.find((rule) => rule.effect === "SHOW" || (rule.effect === "HIDE" && !rule.never));
  if (hidingRule) {
    report(context, {
      ruleId: "jsonforms/required-hideable",
      severity: "error",
      path,
      message: `\`${propertyName}\` is required, but a ${hidingRule.effect} rule ${describeRuleLocation(hidingRule, path)} can hide it. JSON Forms still validates hidden fields, so the form can't be submitted while this field is hidden and empty.`,
      suggestion: "Require it only when it's visible (an if/then in the JSON Schema that mirrors the rule), give it a default, or filter validation errors for hidden fields.",
    });
    return;
  }

  const disablingRule = rules.find((rule) => rule.effect === "ENABLE" || (rule.effect === "DISABLE" && !rule.never));
  if (!disablingRule) return;
  report(context, {
    ruleId: "jsonforms/required-disableable",
    severity: "warning",
    path,
    message: `\`${propertyName}\` is required, but a ${disablingRule.effect} rule ${describeRuleLocation(disablingRule, path)} can disable it. If it's disabled while empty, the user can't fill it in and the form can't be submitted.`,
    suggestion: "Require it only when it's enabled, or give it a default.",
  });
};

const walkElement = (
  element: unknown,
  path: string,
  scopeRoot: JsonObject,
  ancestorRules: RuleInfo[],
  boundScopes: Map<string, string>,
  context: WalkContext,
): void => {
  if (!isObject(element)) return;

  const ownRule = analyzeRule(element.rule, joinPointer(path, "rule"), scopeRoot, context);
  const rules = ownRule ? [...ancestorRules, ownRule] : ancestorRules;

  if (typeof element.scope === "string") {
    const { scope } = element;
    const resolved = resolveScope(scopeRoot, scope, context.documentRoot);
    if (!resolved) {
      reportUnresolvedScope(scope, joinPointer(path, "scope"), scopeRoot, context);
    } else {
      const firstBinding = boundScopes.get(scope);
      if (firstBinding !== undefined) {
        report(context, {
          ruleId: "jsonforms/duplicate-control",
          severity: "warning",
          path,
          message: `Scope \`${scope}\` is already bound at \`${firstBinding || "/"}\`. Both controls edit the same value.`,
        });
      } else {
        boundScopes.set(scope, path);
      }
      checkRequiredVisibility(resolved, rules, path, context);

      const detail = isObject(element.options) ? element.options.detail : undefined;
      const itemSchema = asSchemaObject(deref(resolved.schema.items, context.documentRoot));
      if (isObject(detail) && itemSchema) {
        walkElement(detail, joinPointer(path, "options", "detail"), itemSchema, rules, new Map(), context);
      }
    }
  }

  if (Array.isArray(element.elements)) {
    element.elements.forEach((child, index) =>
      walkElement(child, joinPointer(path, "elements", index), scopeRoot, rules, boundScopes, context),
    );
  }
};

/** Lints a JSON Forms schema + UI schema pair. Throws when `schema` isn't a JSON object. */
export const lintJsonForms = ({ schema, uischema, rules }: JsonFormsInput): Diagnostic[] => {
  if (!isObject(schema)) throw new TypeError("schema must be a JSON object");
  const context: WalkContext = { documentRoot: schema, diagnostics: lintSchema(schema) };
  walkElement(uischema, "", schema, [], new Map(), context);
  return applyRuleLevels(context.diagnostics, rules);
};
