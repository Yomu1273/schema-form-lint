import { describe, expect, it } from "vitest";
import { lintJsonForms } from "../src";

const ruleIds = (diagnostics: Array<{ ruleId: string }>) => diagnostics.map((diagnostic) => diagnostic.ruleId);

const baseSchema = {
  type: "object",
  properties: {
    hasAllergies: { type: "string", enum: ["yes", "no"] },
    allergyDetails: { type: "string" },
    subscribed: { type: "boolean" },
    email: { type: "string" },
  },
  required: ["allergyDetails"],
};

const showWhen = (scope: string, schema: unknown, extra: Record<string, unknown> = {}) => ({
  effect: "SHOW",
  condition: { scope, schema, ...extra },
});

describe("lintJsonForms", () => {
  it("returns nothing for a clean form", () => {
    const diagnostics = lintJsonForms({
      schema: { ...baseSchema, required: [] },
      uischema: {
        type: "VerticalLayout",
        elements: [
          { type: "Control", scope: "#/properties/hasAllergies" },
          {
            type: "Control",
            scope: "#/properties/allergyDetails",
            rule: showWhen("#/properties/hasAllergies", { const: "yes" }, { failWhenUndefined: true }),
          },
        ],
      },
    });
    expect(diagnostics).toEqual([]);
  });

  it("flags unresolved scopes with a suggestion", () => {
    const [diagnostic] = lintJsonForms({
      schema: baseSchema,
      uischema: { type: "Control", scope: "#/properties/emial" },
    });
    expect(diagnostic).toMatchObject({ ruleId: "jsonforms/unresolved-scope", path: "/scope" });
    expect(diagnostic?.suggestion).toContain("`email`");
  });

  it("flags required fields that a rule can hide", () => {
    const diagnostics = lintJsonForms({
      schema: baseSchema,
      uischema: {
        type: "VerticalLayout",
        elements: [
          {
            type: "Control",
            scope: "#/properties/allergyDetails",
            rule: showWhen("#/properties/hasAllergies", { const: "yes" }, { failWhenUndefined: true }),
          },
        ],
      },
    });
    expect(ruleIds(diagnostics)).toEqual(["jsonforms/required-hideable"]);
    expect(diagnostics[0]?.path).toBe("/elements/0");
  });

  it("flags required fields hidden through an ancestor layout", () => {
    const diagnostics = lintJsonForms({
      schema: baseSchema,
      uischema: {
        type: "Group",
        rule: { effect: "HIDE", condition: { scope: "#/properties/subscribed", schema: { const: false }, failWhenUndefined: true } },
        elements: [{ type: "Control", scope: "#/properties/allergyDetails" }],
      },
    });
    expect(ruleIds(diagnostics)).toEqual(["jsonforms/required-hideable"]);
    expect(diagnostics[0]?.message).toContain("at `/rule`");
  });

  it("does not flag required fields that have a default", () => {
    const schema = {
      ...baseSchema,
      properties: { ...baseSchema.properties, allergyDetails: { type: "string", default: "none" } },
    };
    const diagnostics = lintJsonForms({
      schema,
      uischema: {
        type: "Control",
        scope: "#/properties/allergyDetails",
        rule: showWhen("#/properties/hasAllergies", { const: "yes" }, { failWhenUndefined: true }),
      },
    });
    expect(diagnostics).toEqual([]);
  });

  it("warns when a required field can be disabled", () => {
    const diagnostics = lintJsonForms({
      schema: baseSchema,
      uischema: {
        type: "Control",
        scope: "#/properties/allergyDetails",
        rule: { effect: "DISABLE", condition: { scope: "#/properties/subscribed", schema: { const: true }, failWhenUndefined: true } },
      },
    });
    expect(diagnostics).toMatchObject([{ ruleId: "jsonforms/required-disableable", severity: "warning" }]);
  });

  it("flags conditions comparing against values outside the enum", () => {
    const diagnostics = lintJsonForms({
      schema: { ...baseSchema, required: [] },
      uischema: {
        type: "Control",
        scope: "#/properties/allergyDetails",
        rule: showWhen("#/properties/hasAllergies", { const: "Yes" }, { failWhenUndefined: true }),
      },
    });
    expect(diagnostics).toMatchObject([{ ruleId: "jsonforms/impossible-condition", path: "/rule/condition/schema" }]);
    expect(diagnostics[0]?.message).toContain("can never be true");
    expect(diagnostics[0]?.message).toContain("always hidden");
  });

  it("explains that impossible conditions still pass while the field is empty", () => {
    const diagnostics = lintJsonForms({
      schema: { ...baseSchema, required: [] },
      uischema: {
        type: "Control",
        scope: "#/properties/email",
        rule: showWhen("#/properties/subscribed", { const: "true" }),
      },
    });
    expect(ruleIds(diagnostics)).toEqual(["jsonforms/impossible-condition"]);
    expect(diagnostics[0]?.message).toContain("only be true while `subscribed` is empty");
  });

  it("checks nested properties in root-scoped conditions", () => {
    const diagnostics = lintJsonForms({
      schema: { ...baseSchema, required: [] },
      uischema: {
        type: "Control",
        scope: "#/properties/email",
        rule: showWhen("#", { properties: { hasAllergies: { const: "maybe" } }, required: ["hasAllergies"] }),
      },
    });
    expect(diagnostics).toMatchObject([{ ruleId: "jsonforms/impossible-condition" }]);
    expect(diagnostics[0]?.message).toContain("can never be true");
  });

  it("warns about conditions that pass while the field is empty", () => {
    const diagnostics = lintJsonForms({
      schema: { ...baseSchema, required: [] },
      uischema: {
        type: "Control",
        scope: "#/properties/allergyDetails",
        rule: showWhen("#/properties/hasAllergies", { const: "yes" }),
      },
    });
    expect(diagnostics).toMatchObject([{ ruleId: "jsonforms/empty-field-passes", severity: "warning" }]);
  });

  it("warns that const null does not match an empty field", () => {
    const diagnostics = lintJsonForms({
      schema: { ...baseSchema, required: [] },
      uischema: {
        type: "Control",
        scope: "#/properties/email",
        rule: { effect: "DISABLE", condition: { scope: "#", schema: { properties: { hasAllergies: { const: null } } } } },
      },
    });
    expect(ruleIds(diagnostics)).toContain("jsonforms/null-means-absent");
    expect(diagnostics.find((d) => d.ruleId === "jsonforms/null-means-absent")?.path).toBe(
      "/rule/condition/schema/properties/hasAllergies",
    );
  });

  it("flags unknown rule effects and duplicate controls", () => {
    const diagnostics = lintJsonForms({
      schema: { ...baseSchema, required: [] },
      uischema: {
        type: "VerticalLayout",
        elements: [
          { type: "Control", scope: "#/properties/email", rule: { effect: "HIDDEN", condition: {} } },
          { type: "Control", scope: "#/properties/email" },
        ],
      },
    });
    expect(ruleIds(diagnostics)).toEqual(["jsonforms/unknown-effect", "jsonforms/duplicate-control"]);
  });

  it("resolves scopes inside array detail layouts against the item schema", () => {
    const diagnostics = lintJsonForms({
      schema: {
        type: "object",
        definitions: { person: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
        properties: { people: { type: "array", items: { $ref: "#/definitions/person" } } },
      },
      uischema: {
        type: "Control",
        scope: "#/properties/people",
        options: {
          detail: {
            type: "VerticalLayout",
            elements: [
              { type: "Control", scope: "#/properties/name" },
              { type: "Control", scope: "#/properties/nmae" },
            ],
          },
        },
      },
    });
    expect(diagnostics).toMatchObject([
      { ruleId: "jsonforms/unresolved-scope", path: "/options/detail/elements/1/scope", suggestion: "Did you mean `name`?" },
    ]);
  });

  it("treats OR conditions as impossible only when every branch is", () => {
    const diagnostics = lintJsonForms({
      schema: baseSchema,
      uischema: {
        type: "Control",
        scope: "#/properties/allergyDetails",
        rule: {
          effect: "HIDE",
          condition: {
            type: "OR",
            conditions: [
              { scope: "#/properties/hasAllergies", schema: { const: "never" }, failWhenUndefined: true },
              { scope: "#/properties/subscribed", schema: { const: true }, failWhenUndefined: true },
            ],
          },
        },
      },
    });
    expect(ruleIds(diagnostics)).toEqual(["jsonforms/impossible-condition", "jsonforms/required-hideable"]);
  });

  it("throws when the schema is not an object", () => {
    expect(() => lintJsonForms({ schema: "nope" })).toThrow(TypeError);
  });

  it("treats a name required through allOf as required, and ignores a name required only in then", () => {
    const showNote = {
      type: "Control",
      scope: "#/properties/note",
      rule: showWhen("#/properties/kind", { const: "a" }, { failWhenUndefined: true }),
    };
    const always = lintJsonForms({
      schema: {
        type: "object",
        properties: { kind: { type: "string", enum: ["a", "b"] }, note: { type: "string" } },
        allOf: [{ required: ["note"] }],
      },
      uischema: showNote,
    });
    expect(ruleIds(always)).toEqual(["jsonforms/required-hideable"]);

    const sometimes = lintJsonForms({
      schema: {
        type: "object",
        properties: { kind: { type: "string", enum: ["a", "b"] }, note: { type: "string" } },
        if: { properties: { kind: { const: "a" } }, required: ["kind"] },
        then: { required: ["note"] },
      },
      uischema: showNote,
    });
    expect(sometimes).toEqual([]);
  });

  it("lets callers turn required-hideable off when they already filter hidden errors", () => {
    const input = {
      schema: baseSchema,
      uischema: {
        type: "Control",
        scope: "#/properties/allergyDetails",
        rule: showWhen("#/properties/hasAllergies", { const: "yes" }, { failWhenUndefined: true }),
      },
    };
    expect(lintJsonForms({ ...input, rules: { "jsonforms/required-hideable": "off" } })).toEqual([]);
    expect(lintJsonForms({ ...input, rules: { "jsonforms/required-hideable": "warning" } })).toMatchObject([
      { ruleId: "jsonforms/required-hideable", severity: "warning" },
    ]);
  });

  it("resolves a scope that omits the hash, matching JSON Forms", () => {
    const diagnostics = lintJsonForms({
      schema: { type: "object", properties: { enableArray: { type: "boolean" } } },
      uischema: {
        type: "Control",
        scope: "#/properties/enableArray",
        rule: {
          effect: "SHOW",
          condition: { scope: "/properties/enableArray", schema: { const: true }, failWhenUndefined: true },
        },
      },
    });
    expect(diagnostics).toEqual([]);
  });

  it("rejects a rule id it does not emit", () => {
    expect(() => lintJsonForms({ schema: baseSchema, rules: { "jsonforms/not-a-rule": "off" } })).toThrow(/Unknown rule/);
  });
});
