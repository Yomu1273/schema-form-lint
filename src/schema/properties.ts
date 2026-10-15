import type { JsonObject } from "../types";
import { asSchemaObject, deref, isObject } from "./json";

const BRANCH_LIST_KEYWORDS = ["allOf", "anyOf", "oneOf"] as const;
const BRANCH_KEYWORDS = ["then", "else"] as const;

/** Subschemas that can contribute properties to the same object: allOf/anyOf/oneOf, then/else, dependencies. */
export const propertyBranches = (schema: JsonObject, documentRoot: unknown): JsonObject[] => {
  const branches: unknown[] = [];
  for (const keyword of BRANCH_LIST_KEYWORDS) {
    const value = schema[keyword];
    if (Array.isArray(value)) branches.push(...value);
  }
  for (const keyword of BRANCH_KEYWORDS) {
    if (keyword in schema) branches.push(schema[keyword]);
  }
  for (const keyword of ["dependentSchemas", "dependencies"] as const) {
    const value = schema[keyword];
    if (isObject(value)) branches.push(...Object.values(value).filter((entry) => !Array.isArray(entry)));
  }
  return branches
    .map((branch) => asSchemaObject(deref(branch, documentRoot)))
    .filter((branch): branch is JsonObject => branch !== undefined);
};

/**
 * Every property name a form could render for this object, mapped to its schema.
 * Includes properties that only appear in conditional branches, because both
 * JSON Forms and RJSF can render those when the branch applies.
 */
export const collectProperties = (
  schema: JsonObject,
  documentRoot: unknown,
  seen: Set<JsonObject> = new Set(),
): Map<string, JsonObject> => {
  const properties = new Map<string, JsonObject>();
  if (seen.has(schema)) return properties;
  seen.add(schema);

  if (isObject(schema.properties)) {
    for (const [name, value] of Object.entries(schema.properties)) {
      properties.set(name, asSchemaObject(deref(value, documentRoot)) ?? {});
    }
  }
  for (const branch of propertyBranches(schema, documentRoot)) {
    for (const [name, value] of collectProperties(branch, documentRoot, seen)) {
      if (!properties.has(name)) properties.set(name, value);
    }
  }
  return properties;
};

/** True when the object accepts properties beyond the declared ones, so unknown names aren't necessarily mistakes. */
export const isOpenObject = (schema: JsonObject): boolean => {
  const { additionalProperties, patternProperties } = schema;
  if (additionalProperties === true || isObject(additionalProperties)) return true;
  return isObject(patternProperties) && Object.keys(patternProperties).length > 0;
};

export const requiredNames = (schema: JsonObject): string[] =>
  Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : [];

const allOfBranches = (schema: JsonObject, documentRoot: unknown): JsonObject[] =>
  Array.isArray(schema.allOf)
    ? schema.allOf
        .map((branch) => asSchemaObject(deref(branch, documentRoot)))
        .filter((branch): branch is JsonObject => branch !== undefined)
    : [];

/**
 * Property names that are part of the object for every input.
 * `allOf` always applies. `oneOf`, `anyOf`, `then`/`else`, and dependencies do not.
 */
export const guaranteedPropertyNames = (
  schema: JsonObject,
  documentRoot: unknown,
  seen: Set<JsonObject> = new Set(),
): string[] => {
  if (seen.has(schema)) return [];
  seen.add(schema);
  const names = isObject(schema.properties) ? Object.keys(schema.properties) : [];
  for (const branch of allOfBranches(schema, documentRoot)) names.push(...guaranteedPropertyNames(branch, documentRoot, seen));
  return names;
};

/**
 * Names that are required no matter what else is in the data.
 * A name required only inside `then`, `oneOf`, or `dependentRequired` is not included.
 */
export const unconditionallyRequiredNames = (
  schema: JsonObject,
  documentRoot: unknown,
  seen: Set<JsonObject> = new Set(),
): string[] => {
  if (seen.has(schema)) return [];
  seen.add(schema);
  const names = [...requiredNames(schema)];
  for (const branch of allOfBranches(schema, documentRoot)) names.push(...unconditionallyRequiredNames(branch, documentRoot, seen));
  return names;
};
