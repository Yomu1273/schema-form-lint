import { applyRuleLevels } from "../rules";
import type { RuleLevel } from "../rules";
import { asSchemaObject, deref, formatValue, isObject, joinPointer, schemaTypes } from "../schema/json";
import { lintSchema } from "../schema/lintSchema";
import { collectProperties, guaranteedPropertyNames, isOpenObject, unconditionallyRequiredNames } from "../schema/properties";
import { didYouMean } from "../suggest";
import type { Diagnostic, JsonObject } from "../types";

export interface RjsfInput {
  schema: unknown;
  uiSchema?: unknown;
  /** Widget names registered through the `widgets` prop. Registered names work for every type. */
  customWidgets?: string[];
  /**
   * Per-rule level. `off` drops the diagnostic. `warning` and `error` replace its severity.
   * Unknown ids throw, so a typo cannot hide a finding.
   */
  rules?: Readonly<Record<string, RuleLevel>>;
}

interface WalkContext {
  documentRoot: JsonObject;
  diagnostics: Diagnostic[];
  customWidgets: Set<string>;
}

interface FieldInfo {
  name: string | undefined;
  required: boolean;
}

/**
 * Built-in widget names per schema type, copied from `@rjsf/utils` 6.11.0 `getWidget` `widgetMap`.
 * A name in this map is a built-in. Any other string is treated as a custom widget, because the
 * linter cannot see the `widgets` prop unless the caller lists it in `customWidgets`.
 */
const BUILT_IN_WIDGETS: Record<string, readonly string[]> = {
  boolean: ["checkbox", "radio", "select", "hidden"],
  string: [
    "text", "password", "email", "hostname", "ipv4", "ipv6", "uri", "data-url", "radio", "select",
    "textarea", "hidden", "date", "datetime", "date-time", "alt-date", "alt-datetime", "time", "color", "file",
  ],
  number: ["text", "select", "updown", "range", "radio", "hidden"],
  integer: ["text", "select", "updown", "range", "radio", "hidden"],
  array: ["select", "checkboxes", "files", "hidden"],
};

const ALL_BUILT_IN_WIDGETS = new Set(Object.values(BUILT_IN_WIDGETS).flat());

const report = (context: WalkContext, diagnostic: Omit<Diagnostic, "document">): void => {
  context.diagnostics.push({ document: "uischema", ...diagnostic });
};

const orderLabel = (entry: unknown): string => (typeof entry === "string" ? `\`${entry}\`` : formatValue(entry));

/**
 * Mirrors `@rjsf/utils` 6.11.0 `orderProperties`.
 * Unknown names are filtered out before the throw, so they do not crash the form.
 * A missing guaranteed property with no `"*"` throws. More than one `"*"` throws.
 */
const checkOrder = (order: unknown, schema: JsonObject, path: string, context: WalkContext): void => {
  if (!Array.isArray(order)) return;
  const renderable = new Set(collectProperties(schema, context.documentRoot).keys());
  const open = isOpenObject(schema);
  let wildcardCount = 0;
  let secondWildcard = -1;

  order.forEach((entry, index) => {
    if (entry === "*") {
      wildcardCount += 1;
      if (wildcardCount === 2) secondWildcard = index;
      return;
    }
    if (typeof entry === "string" && (renderable.has(entry) || open)) return;
    report(context, {
      ruleId: "rjsf/unknown-order-entry",
      severity: "warning",
      path: joinPointer(path, index),
      message: `\`ui:order\` lists ${orderLabel(entry)}, which isn't a property of this object. RJSF drops that entry, so it has no effect on order and the form still renders.`,
      suggestion:
        (typeof entry === "string" ? didYouMean(entry, renderable) : undefined) ??
        "Remove the entry, or fix the name so it matches a schema property.",
    });
  });

  if (secondWildcard !== -1) {
    report(context, {
      ruleId: "rjsf/multiple-order-wildcards",
      severity: "error",
      path: joinPointer(path, secondWildcard),
      message:
        '`ui:order` contains more than one `"*"` wildcard. RJSF throws "uiSchema order list contains more than one wildcard item" and renders an error instead of the form.',
      suggestion: 'Keep a single `"*"` where the remaining properties should go.',
    });
  }

  if (wildcardCount > 0) return;
  const missing = [...new Set(guaranteedPropertyNames(schema, context.documentRoot))].filter((name) => !order.includes(name));
  if (missing.length === 0) return;
  report(context, {
    ruleId: "rjsf/incomplete-order",
    severity: "error",
    path,
    message: `\`ui:order\` doesn't include ${missing.map((name) => `\`${name}\``).join(", ")} and has no \`"*"\` wildcard. RJSF throws "uiSchema order list does not contain property" and renders an error instead of the form.`,
    suggestion: 'Add the missing properties, or add `"*"` where the remaining properties should go.',
  });
};

const checkWidget = (widget: unknown, schema: JsonObject, field: FieldInfo, path: string, context: WalkContext): void => {
  if (typeof widget !== "string" || context.customWidgets.has(widget)) return;

  if (ALL_BUILT_IN_WIDGETS.has(widget)) {
    const type = schemaTypes(schema)?.find((candidate) => candidate !== "null");
    const widgetsForType = type ? BUILT_IN_WIDGETS[type] : undefined;
    if (type && !widgetsForType?.includes(widget)) {
      const thrown = widgetsForType ? `No widget '${widget}' for type '${type}'` : `No widget for type '${type}'`;
      report(context, {
        ruleId: "rjsf/widget-type-mismatch",
        severity: "error",
        path,
        message: `The built-in ${formatValue(widget)} widget doesn't support type \`${type}\`. RJSF throws "${thrown}" at render time.`,
        suggestion: widgetsForType
          ? `Use one of: ${widgetsForType.join(", ")}. If you registered a custom widget with this name, pass it in \`customWidgets\`.`
          : "Remove `ui:widget`, or pass this name in `customWidgets` if you registered a widget for this type.",
      });
      return;
    }
  }

  if (widget === "hidden" && field.required && !("default" in schema)) {
    report(context, {
      ruleId: "rjsf/hidden-required",
      severity: "error",
      path,
      message: `\`${field.name ?? "This field"}\` is required but uses the hidden widget and has no default, so the user can never fill it in and the form can't be submitted.`,
      suggestion: "Give the property a default, or remove it from `required`.",
    });
  }
};

/** Every local `$ref` string in the schema. RJSF matches `ui:definitions` keys against these, not against arbitrary pointers. */
const collectSchemaRefs = (node: unknown, seen: Set<JsonObject> = new Set(), refs: Set<string> = new Set()): Set<string> => {
  if (Array.isArray(node)) {
    for (const item of node) collectSchemaRefs(item, seen, refs);
    return refs;
  }
  if (!isObject(node) || seen.has(node)) return refs;
  seen.add(node);
  if (typeof node.$ref === "string") refs.add(node.$ref);
  for (const value of Object.values(node)) collectSchemaRefs(value, seen, refs);
  return refs;
};

const resolveDefinition = (ref: string, root: JsonObject): JsonObject | undefined => {
  if (ref !== "#" && !ref.startsWith("#/")) return undefined;
  return asSchemaObject(deref(ref === "#" ? root : { $ref: ref }, root));
};

/** Lints uiSchema stored under root `ui:definitions`, keyed by the schema `$ref` it applies to. */
const walkDefinitions = (definitions: unknown, path: string, context: WalkContext): void => {
  if (!isObject(definitions)) return;
  const usedRefs = collectSchemaRefs(context.documentRoot);
  for (const [ref, uiSchema] of Object.entries(definitions)) {
    const childPath = joinPointer(path, ref);
    const resolved = resolveDefinition(ref, context.documentRoot);
    const used = usedRefs.has(ref);
    if (!resolved || !used) {
      report(context, {
        ruleId: "rjsf/unresolved-definition",
        severity: "error",
        path: childPath,
        message: !resolved
          ? `\`ui:definitions\` key \`${ref}\` doesn't resolve in the schema, so RJSF never applies this uiSchema.`
          : `No \`$ref\` in the schema equals \`${ref}\`, so RJSF never applies this uiSchema.`,
        suggestion: didYouMean(ref, usedRefs) ?? "Use the exact `$ref`, such as `#/$defs/address` or `#/definitions/address`.",
      });
    }
    if (!resolved) continue;
    walkUiSchema(uiSchema, resolved, childPath, { name: undefined, required: false }, context);
  }
};

const walkUiSchema = (uiNode: unknown, rawSchema: unknown, path: string, field: FieldInfo, context: WalkContext): void => {
  const schema = asSchemaObject(deref(rawSchema, context.documentRoot));
  if (!isObject(uiNode) || !schema) return;

  const properties = collectProperties(schema, context.documentRoot);
  const required = new Set(unconditionallyRequiredNames(schema, context.documentRoot));
  const isArray = schemaTypes(schema)?.includes("array") ?? "items" in schema;

  for (const [key, value] of Object.entries(uiNode)) {
    const childPath = joinPointer(path, key);
    if (key === "ui:order") {
      checkOrder(value, schema, childPath, context);
      continue;
    }
    if (key === "ui:widget") {
      checkWidget(value, schema, field, childPath, context);
      continue;
    }
    if (key === "ui:definitions") {
      if (path === "") walkDefinitions(value, childPath, context);
      continue;
    }
    if (key.startsWith("ui:")) continue;

    const property = properties.get(key);
    if (property) {
      walkUiSchema(value, property, childPath, { name: key, required: required.has(key) }, context);
      continue;
    }
    if (key === "items" && isArray) {
      if (!Array.isArray(schema.items)) walkUiSchema(value, schema.items, childPath, { name: undefined, required: false }, context);
      continue;
    }
    if (key === "additionalProperties" || key === "additionalItems" || isOpenObject(schema)) continue;

    report(context, {
      ruleId: "rjsf/unknown-ui-key",
      severity: "error",
      path: childPath,
      message: `uiSchema key \`${key}\` doesn't match any property in the schema, so its settings are silently ignored.`,
      suggestion: didYouMean(key, properties.keys()) ?? "Rename it to match a schema property or remove it.",
    });
  }
};

/** Lints a react-jsonschema-form schema + uiSchema pair. Throws when `schema` isn't a JSON object. */
export const lintRjsf = ({ schema, uiSchema, customWidgets = [], rules }: RjsfInput): Diagnostic[] => {
  if (!isObject(schema)) throw new TypeError("schema must be a JSON object");
  const context: WalkContext = {
    documentRoot: schema,
    diagnostics: lintSchema(schema),
    customWidgets: new Set(customWidgets),
  };
  walkUiSchema(uiSchema, schema, "", { name: undefined, required: false }, context);
  return applyRuleLevels(context.diagnostics, rules);
};
