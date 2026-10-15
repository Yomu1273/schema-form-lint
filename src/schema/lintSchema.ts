import { didYouMean } from "../suggest";
import type { Diagnostic, JsonObject } from "../types";
import { isObject, joinPointer } from "./json";
import { collectProperties, isOpenObject, requiredNames } from "./properties";

interface InheritedObject {
  names: Set<string>;
  open: boolean;
}

interface SchemaWalkContext {
  documentRoot: JsonObject;
  diagnostics: Diagnostic[];
  seen: Set<JsonObject>;
}

const BRANCH_LIST_KEYWORDS = ["allOf", "anyOf", "oneOf"] as const;
const BRANCH_KEYWORDS = ["then", "else"] as const;
const DEFINITION_KEYWORDS = ["$defs", "definitions"] as const;

const unknownRequired = (name: string, path: string, names: Set<string>): Diagnostic => ({
  ruleId: "schema/unknown-required",
  severity: "error",
  document: "schema",
  path,
  message: `\`${name}\` is listed in \`required\` but no property with that name is defined, so the form never renders a field for it and can't be submitted.`,
  suggestion: didYouMean(name, names) ?? `Define a \`${name}\` property or remove it from \`required\`.`,
});

const checkRequired = (node: JsonObject, path: string, names: Set<string>, context: SchemaWalkContext): void => {
  requiredNames(node).forEach((name, index) => {
    if (!names.has(name)) context.diagnostics.push(unknownRequired(name, joinPointer(path, "required", index), names));
  });
};

const checkDependencies = (node: JsonObject, path: string, names: Set<string>, context: SchemaWalkContext): void => {
  for (const keyword of ["dependentRequired", "dependencies"] as const) {
    const dependencies = node[keyword];
    if (!isObject(dependencies)) continue;

    for (const [trigger, dependents] of Object.entries(dependencies)) {
      const triggerPath = joinPointer(path, keyword, trigger);
      if (!names.has(trigger)) {
        context.diagnostics.push({
          ruleId: "schema/unknown-dependency",
          severity: "warning",
          document: "schema",
          path: triggerPath,
          message: `\`${keyword}\` is keyed on \`${trigger}\`, which isn't a defined property, so this dependency never triggers.`,
          suggestion: didYouMean(trigger, names) ?? `Use the name of an existing property.`,
        });
      }
      if (!Array.isArray(dependents)) continue;
      dependents.forEach((dependent, index) => {
        if (typeof dependent === "string" && !names.has(dependent)) {
          context.diagnostics.push(unknownRequired(dependent, joinPointer(triggerPath, index), names));
        }
      });
    }
  }
};

const walkSchema = (node: unknown, path: string, context: SchemaWalkContext, inherited?: InheritedObject): void => {
  if (!isObject(node) || context.seen.has(node)) return;
  context.seen.add(node);

  const names = new Set([...collectProperties(node, context.documentRoot).keys(), ...(inherited?.names ?? [])]);
  const open = isOpenObject(node) || (inherited?.open ?? false);
  const declaresProperties = isObject(node.properties) || inherited !== undefined;

  if (declaresProperties && !open) {
    checkRequired(node, path, names, context);
    checkDependencies(node, path, names, context);
  }

  if (isObject(node.properties)) {
    for (const [name, child] of Object.entries(node.properties)) walkSchema(child, joinPointer(path, "properties", name), context);
  }
  if (isObject(node.patternProperties)) {
    for (const [pattern, child] of Object.entries(node.patternProperties)) {
      walkSchema(child, joinPointer(path, "patternProperties", pattern), context);
    }
  }
  walkSchema(node.additionalProperties, joinPointer(path, "additionalProperties"), context);
  walkSchema(node.contains, joinPointer(path, "contains"), context);
  if (Array.isArray(node.items)) node.items.forEach((child, index) => walkSchema(child, joinPointer(path, "items", index), context));
  else walkSchema(node.items, joinPointer(path, "items"), context);
  if (Array.isArray(node.prefixItems)) {
    node.prefixItems.forEach((child, index) => walkSchema(child, joinPointer(path, "prefixItems", index), context));
  }

  const branchContext: InheritedObject = { names, open };
  for (const keyword of BRANCH_LIST_KEYWORDS) {
    const branches = node[keyword];
    if (Array.isArray(branches)) branches.forEach((branch, index) => walkSchema(branch, joinPointer(path, keyword, index), context, branchContext));
  }
  for (const keyword of BRANCH_KEYWORDS) walkSchema(node[keyword], joinPointer(path, keyword), context, branchContext);
  for (const keyword of ["dependentSchemas", "dependencies"] as const) {
    const dependencies = node[keyword];
    if (!isObject(dependencies)) continue;
    for (const [trigger, branch] of Object.entries(dependencies)) {
      walkSchema(branch, joinPointer(path, keyword, trigger), context, branchContext);
    }
  }

  for (const keyword of DEFINITION_KEYWORDS) {
    const definitions = node[keyword];
    if (!isObject(definitions)) continue;
    for (const [name, definition] of Object.entries(definitions)) walkSchema(definition, joinPointer(path, keyword, name), context);
  }
};

/**
 * Checks that apply to any schema-driven form: `required` and dependency entries that name
 * properties the form can never render. `if` and `not` subschemas are skipped because their
 * `required` lists are conditions, not requirements.
 */
export const lintSchema = (schema: unknown): Diagnostic[] => {
  if (!isObject(schema)) return [];
  const context: SchemaWalkContext = { documentRoot: schema, diagnostics: [], seen: new Set() };
  walkSchema(schema, "", context);
  return context.diagnostics;
};
