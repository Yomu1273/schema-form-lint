import type { JsonObject } from "../types";
import { allowedValues, asSchemaObject, deepEqual, deref, formatValue, isObject, joinPointer, schemaTypes, typeAccepts } from "./json";
import { requiredNames } from "./properties";

export interface ConditionImpossibility {
  /** Human-readable name of the value the impossible check applies to. */
  subject: string;
  detail: string;
  /**
   * JSON Schema skips checks on absent values, so most "impossible" conditions still pass
   * while the field is empty. When true, the condition passes only in that state;
   * when false, it never passes at all.
   */
  passesWhenEmpty: boolean;
}

interface AnalysisContext {
  documentRoot: unknown;
  subject: string;
  passesWhenEmpty: boolean;
}

const describeValues = (values: unknown[]): string => values.map(formatValue).join(", ");

const checkConst = (condition: JsonObject, target: JsonObject | undefined): string | undefined => {
  if (!("const" in condition)) return undefined;
  const value = condition.const;

  if (Array.isArray(condition.enum) && !condition.enum.some((option) => deepEqual(option, value))) {
    return `const ${formatValue(value)} is not in the condition's own enum`;
  }
  const conditionTypes = schemaTypes(condition);
  if (conditionTypes && !typeAccepts(conditionTypes, value)) {
    return `const ${formatValue(value)} contradicts the condition's own type ${conditionTypes.join(" | ")}`;
  }
  if (!target) return undefined;

  const allowed = allowedValues(target);
  if (allowed && !allowed.some((option) => deepEqual(option, value))) {
    return `${formatValue(value)} is not one of the values the field allows (${describeValues(allowed)})`;
  }
  const targetTypes = schemaTypes(target);
  if (targetTypes && !typeAccepts(targetTypes, value)) {
    return `${formatValue(value)} can't be a value of a field typed ${targetTypes.join(" | ")}`;
  }
  return undefined;
};

const checkEnum = (condition: JsonObject, target: JsonObject | undefined): string | undefined => {
  if (!Array.isArray(condition.enum)) return undefined;
  if (condition.enum.length === 0) return "the condition's enum is empty";
  if (!target) return undefined;

  const allowed = allowedValues(target);
  if (allowed && !condition.enum.some((value) => allowed.some((option) => deepEqual(option, value)))) {
    return `none of ${describeValues(condition.enum)} are values the field allows (${describeValues(allowed)})`;
  }
  const targetTypes = schemaTypes(target);
  if (targetTypes && !condition.enum.some((value) => typeAccepts(targetTypes, value))) {
    return `none of ${describeValues(condition.enum)} can be values of a field typed ${targetTypes.join(" | ")}`;
  }
  return undefined;
};

const RANGE_PAIRS: Array<[lower: string, upper: string, strict: boolean]> = [
  ["minimum", "maximum", false],
  ["exclusiveMinimum", "exclusiveMaximum", true],
  ["minLength", "maxLength", false],
  ["minItems", "maxItems", false],
];

const checkRanges = (condition: JsonObject): string | undefined => {
  for (const [lowerKey, upperKey, strict] of RANGE_PAIRS) {
    const lower = condition[lowerKey];
    const upper = condition[upperKey];
    if (typeof lower !== "number" || typeof upper !== "number") continue;
    if (lower > upper || (strict && lower === upper)) return `${lowerKey} ${lower} is above ${upperKey} ${upper}`;
  }
  return undefined;
};

const checkTypeOverlap = (condition: JsonObject, target: JsonObject | undefined): string | undefined => {
  const conditionTypes = schemaTypes(condition);
  const targetTypes = target ? schemaTypes(target) : undefined;
  if (!conditionTypes || !targetTypes) return undefined;
  const overlaps = conditionTypes.some(
    (type) =>
      targetTypes.includes(type) ||
      (type === "number" && targetTypes.includes("integer")) ||
      (type === "integer" && targetTypes.includes("number")),
  );
  return overlaps ? undefined : `the condition expects ${conditionTypes.join(" | ")} but the field is ${targetTypes.join(" | ")}`;
};

const analyze = (condition: unknown, target: JsonObject | undefined, context: AnalysisContext): ConditionImpossibility[] => {
  if (condition === false) {
    return [{ subject: context.subject, detail: "the condition schema is `false`", passesWhenEmpty: false }];
  }
  const resolved = asSchemaObject(deref(condition, context.documentRoot));
  if (!resolved) return [];

  const ownProblem =
    checkConst(resolved, target) ?? checkEnum(resolved, target) ?? checkRanges(resolved) ?? checkTypeOverlap(resolved, target);
  const problems: ConditionImpossibility[] = ownProblem
    ? [{ subject: context.subject, detail: ownProblem, passesWhenEmpty: context.passesWhenEmpty }]
    : [];

  if (isObject(resolved.properties)) {
    const required = requiredNames(resolved);
    const targetProperties = target && isObject(target.properties) ? target.properties : undefined;
    for (const [name, subCondition] of Object.entries(resolved.properties)) {
      const subTarget = targetProperties ? asSchemaObject(deref(targetProperties[name], context.documentRoot)) : undefined;
      problems.push(
        ...analyze(subCondition, subTarget, {
          documentRoot: context.documentRoot,
          subject: context.subject === "the value" ? `\`${name}\`` : `${context.subject}.${name}`,
          passesWhenEmpty: !required.includes(name),
        }),
      );
    }
  }

  if (Array.isArray(resolved.allOf)) {
    for (const branch of resolved.allOf) problems.push(...analyze(branch, target, context));
  }
  return problems;
};

/**
 * Finds reasons a rule condition can never match real input. Conservative by design:
 * it only reports contradictions it can prove from const/enum/type/range keywords.
 */
export const findConditionImpossibilities = (
  condition: unknown,
  target: JsonObject | undefined,
  options: { documentRoot: unknown; subject: string; passesWhenEmpty: boolean },
): ConditionImpossibility[] => analyze(condition, target, options);

/** Finds `const: null` checks, which match an explicit null but never an empty (absent) field. */
export const findNullConstPaths = (condition: unknown, path = ""): string[] => {
  if (!isObject(condition)) return [];
  const found: string[] = [];
  const enumIsOnlyNull = Array.isArray(condition.enum) && condition.enum.length > 0 && condition.enum.every((value) => value === null);
  if (("const" in condition && condition.const === null) || enumIsOnlyNull) found.push(path);

  if (isObject(condition.properties)) {
    for (const [name, sub] of Object.entries(condition.properties)) {
      found.push(...findNullConstPaths(sub, joinPointer(path, "properties", name)));
    }
  }
  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const branches = condition[keyword];
    if (!Array.isArray(branches)) continue;
    branches.forEach((branch, index) => found.push(...findNullConstPaths(branch, joinPointer(path, keyword, index))));
  }
  if ("not" in condition) found.push(...findNullConstPaths(condition.not, joinPointer(path, "not")));
  return found;
};

/** True when a condition schema actually constrains anything. `{}` and `true` always pass. */
export const isNonTrivialCondition = (condition: unknown): boolean =>
  condition === false || (isObject(condition) && Object.keys(condition).length > 0);
