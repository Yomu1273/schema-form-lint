import type { JsonObject } from "../types";

const MAX_REF_DEPTH = 32;

export const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const encodePointerSegment = (segment: string): string =>
  segment.replace(/~/g, "~0").replace(/\//g, "~1");

export const decodePointerSegment = (segment: string): string =>
  segment.replace(/~1/g, "/").replace(/~0/g, "~");

export const joinPointer = (base: string, ...segments: Array<string | number>): string =>
  segments.reduce<string>((pointer, segment) => `${pointer}/${encodePointerSegment(String(segment))}`, base);

const walkPointer = (root: unknown, segments: string[]): unknown =>
  segments.reduce<unknown>((current, segment) => {
    if (Array.isArray(current)) return current[Number(segment)];
    return isObject(current) ? current[segment] : undefined;
  }, root);

/** Follows local `$ref`s ("#/..."). Returns undefined for cycles or refs that don't resolve. */
export const deref = (value: unknown, documentRoot: unknown): unknown => {
  let current = value;
  for (let depth = 0; depth < MAX_REF_DEPTH; depth += 1) {
    if (!isObject(current) || typeof current.$ref !== "string") return current;
    const ref = current.$ref;
    if (ref === "#") {
      current = documentRoot;
      continue;
    }
    if (!ref.startsWith("#/")) return current;
    current = walkPointer(documentRoot, ref.slice(2).split("/").map(decodePointerSegment));
  }
  return undefined;
};

/** Normalises boolean schemas so callers can treat every schema as an object. */
export const asSchemaObject = (value: unknown): JsonObject | undefined => {
  if (value === true) return {};
  if (value === false) return { not: {} };
  return isObject(value) ? value : undefined;
};

export const schemaTypes = (schema: JsonObject): string[] | undefined => {
  if (typeof schema.type === "string") return [schema.type];
  if (Array.isArray(schema.type)) return schema.type.filter((type): type is string => typeof type === "string");
  return undefined;
};

export const jsonTypeOf = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
};

export const typeAccepts = (types: string[], value: unknown): boolean => {
  const valueType = jsonTypeOf(value);
  if (types.includes(valueType)) return true;
  return valueType === "integer" && types.includes("number");
};

export const deepEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]));
  }
  if (isObject(left) && isObject(right)) {
    const leftKeys = Object.keys(left);
    if (leftKeys.length !== Object.keys(right).length) return false;
    return leftKeys.every((key) => key in right && deepEqual(left[key], right[key]));
  }
  return false;
};

/** The finite set of values a schema allows, when it declares one via const, enum, or oneOf/anyOf of consts. */
export const allowedValues = (schema: JsonObject): unknown[] | undefined => {
  if ("const" in schema) return [schema.const];
  if (Array.isArray(schema.enum)) return schema.enum;
  for (const keyword of ["oneOf", "anyOf"] as const) {
    const branches = schema[keyword];
    if (!Array.isArray(branches) || branches.length === 0) continue;
    if (branches.every((branch) => isObject(branch) && "const" in branch)) {
      return branches.map((branch) => (branch as JsonObject).const);
    }
  }
  return undefined;
};

export const formatValue = (value: unknown): string => JSON.stringify(value) ?? String(value);
