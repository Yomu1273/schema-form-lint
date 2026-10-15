import type { Diagnostic, Severity } from "./types";

/** Every rule id the linter can emit. Used to reject typos in rule configuration. */
export const RULE_IDS = [
  "schema/unknown-required",
  "schema/unknown-dependency",
  "jsonforms/unresolved-scope",
  "jsonforms/required-hideable",
  "jsonforms/required-disableable",
  "jsonforms/impossible-condition",
  "jsonforms/empty-field-passes",
  "jsonforms/null-means-absent",
  "jsonforms/unknown-effect",
  "jsonforms/duplicate-control",
  "rjsf/unknown-ui-key",
  "rjsf/unknown-order-entry",
  "rjsf/incomplete-order",
  "rjsf/multiple-order-wildcards",
  "rjsf/unresolved-definition",
  "rjsf/hidden-required",
  "rjsf/widget-type-mismatch",
] as const;

export type RuleId = (typeof RULE_IDS)[number];

export type RuleLevel = "off" | Severity;

const KNOWN_RULES = new Set<string>(RULE_IDS);

const assertLevel = (id: string, level: string): RuleLevel => {
  if (level === "off" || level === "warning" || level === "error") return level;
  throw new TypeError(`Rule \`${id}\` must be off, warning, or error.`);
};

/** Parses `ruleId=off|warning|error`. Throws when the id or level is not one this package knows. */
export const parseRuleAssignment = (assignment: string): { id: RuleId; level: RuleLevel } => {
  const separator = assignment.lastIndexOf("=");
  if (separator <= 0) throw new TypeError(`Expected <ruleId>=<off|warning|error>, got \`${assignment}\`.`);
  const id = assignment.slice(0, separator);
  const level = assignment.slice(separator + 1);
  if (!KNOWN_RULES.has(id)) throw new TypeError(`Unknown rule \`${id}\`.`);
  return { id: id as RuleId, level: assertLevel(id, level) };
};

/**
 * Drops rules set to `off` and replaces the severity of the rest.
 * Throws when `rules` names an id this package does not emit, so a typo cannot hide a finding.
 */
export const applyRuleLevels = (
  diagnostics: Diagnostic[],
  rules?: Readonly<Record<string, RuleLevel>>,
): Diagnostic[] => {
  if (!rules) return diagnostics;
  for (const [id, level] of Object.entries(rules)) {
    if (!KNOWN_RULES.has(id)) throw new TypeError(`Unknown rule \`${id}\`.`);
    assertLevel(id, level);
  }
  return diagnostics.flatMap((diagnostic) => {
    const level = rules[diagnostic.ruleId];
    if (level === undefined) return [diagnostic];
    if (level === "off") return [];
    return [{ ...diagnostic, severity: level }];
  });
};
