import { describe, expect, it } from "vitest";
import { lintSchema } from "../src";

describe("lintSchema", () => {
  it("flags required names that are not defined", () => {
    const diagnostics = lintSchema({
      type: "object",
      properties: { email: { type: "string" } },
      required: ["emial"],
    });
    expect(diagnostics).toMatchObject([
      { ruleId: "schema/unknown-required", path: "/required/0", suggestion: "Did you mean `email`?" },
    ]);
  });

  it("checks then/else branches against the parent's properties", () => {
    const diagnostics = lintSchema({
      type: "object",
      properties: { country: { type: "string" }, zip: { type: "string" } },
      if: { properties: { country: { const: "US" } }, required: ["country"] },
      then: { required: ["zip"] },
      else: { required: ["postcode"] },
    });
    expect(diagnostics).toMatchObject([{ ruleId: "schema/unknown-required", path: "/else/required/0" }]);
  });

  it("does not treat required inside if as a requirement", () => {
    const diagnostics = lintSchema({
      type: "object",
      properties: { a: { type: "string" } },
      if: { required: ["somethingElse"] },
      then: {},
    });
    expect(diagnostics).toEqual([]);
  });

  it("skips open objects", () => {
    const diagnostics = lintSchema({
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: true,
      required: ["b"],
    });
    expect(diagnostics).toEqual([]);
  });

  it("checks dependentRequired keys and values", () => {
    const diagnostics = lintSchema({
      type: "object",
      properties: { card: { type: "string" }, billing: { type: "string" } },
      dependentRequired: { card: ["biling"], cvv: ["card"] },
    });
    expect(diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual(["schema/unknown-required", "schema/unknown-dependency"]);
  });

  it("walks nested objects and definitions without looping on recursive refs", () => {
    const diagnostics = lintSchema({
      type: "object",
      definitions: {
        node: { type: "object", properties: { child: { $ref: "#/definitions/node" } }, required: ["chlid"] },
      },
      properties: { root: { $ref: "#/definitions/node" } },
    });
    expect(diagnostics).toMatchObject([{ ruleId: "schema/unknown-required", path: "/definitions/node/required/0" }]);
  });
});
