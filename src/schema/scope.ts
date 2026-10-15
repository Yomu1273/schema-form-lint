import type { JsonObject } from "../types";
import { asSchemaObject, decodePointerSegment, deref, isObject } from "./json";

export interface ResolvedScope {
  schema: JsonObject;
  /** The object schema that declares the property, when the scope ends in `/properties/<name>`. */
  parent?: JsonObject;
  propertyName?: string;
}

/**
 * Resolves a JSON Forms scope such as `#/properties/address/properties/street`.
 * `scopeRoot` is the schema scopes are relative to (the item schema inside array details);
 * `documentRoot` is the full document used for `$ref` resolution.
 */
export const resolveScope = (
  scopeRoot: JsonObject,
  scope: string,
  documentRoot: unknown = scopeRoot,
): ResolvedScope | undefined => {
  // JSON Forms skips empty segments and `#`, so `/properties/name` resolves the same as `#/properties/name`.
  const pointer = scope.startsWith("/") ? `#${scope}` : scope;
  if (pointer === "#") return { schema: scopeRoot };
  if (!pointer.startsWith("#/")) return undefined;

  const segments = pointer.slice(2).split("/").map(decodePointerSegment);
  const visited: JsonObject[] = [];
  let current: unknown = scopeRoot;

  for (const segment of segments) {
    const node = deref(current, documentRoot);
    if (!isObject(node)) return undefined;
    visited.push(node);
    current = node[segment];
  }

  const schema = asSchemaObject(deref(current, documentRoot));
  if (!schema) return undefined;

  const propertyName = segments.at(-1);
  const declaresProperty = segments.length >= 2 && segments.at(-2) === "properties";
  const parent = visited.at(-2);
  if (!declaresProperty || !parent || propertyName === undefined) return { schema };
  return { schema, parent, propertyName };
};
