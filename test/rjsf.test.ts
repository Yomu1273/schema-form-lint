import { describe, expect, it } from "vitest";
import { lintRjsf } from "../src";

const schema = {
  type: "object",
  properties: {
    firstName: { type: "string" },
    age: { type: "integer" },
    agree: { type: "boolean" },
    token: { type: "string" },
    tags: { type: "array", items: { type: "object", properties: { label: { type: "string" } } } },
  },
  required: ["firstName", "token"],
};

describe("lintRjsf", () => {
  it("returns nothing for a clean uiSchema", () => {
    const diagnostics = lintRjsf({
      schema,
      uiSchema: {
        "ui:order": ["firstName", "*"],
        firstName: { "ui:autofocus": true },
        agree: { "ui:widget": "radio" },
        tags: { items: { label: { "ui:placeholder": "Label" } } },
      },
    });
    expect(diagnostics).toEqual([]);
  });

  it("flags uiSchema keys that match no property", () => {
    const diagnostics = lintRjsf({ schema, uiSchema: { fristName: { "ui:autofocus": true } } });
    expect(diagnostics).toMatchObject([
      { ruleId: "rjsf/unknown-ui-key", path: "/fristName", suggestion: "Did you mean `firstName`?" },
    ]);
  });

  it("walks into array items", () => {
    const diagnostics = lintRjsf({ schema, uiSchema: { tags: { items: { lable: {} } } } });
    expect(diagnostics).toMatchObject([{ ruleId: "rjsf/unknown-ui-key", path: "/tags/items/lable" }]);
  });

  it("accepts keys for properties that only exist in dependency branches", () => {
    const diagnostics = lintRjsf({
      schema: {
        type: "object",
        properties: { hasPet: { type: "boolean" } },
        dependencies: {
          hasPet: { oneOf: [{ properties: { hasPet: { const: true }, petName: { type: "string" } } }] },
        },
      },
      uiSchema: { petName: { "ui:placeholder": "Rex" } },
    });
    expect(diagnostics).toEqual([]);
  });

  it("warns when ui:order names a property RJSF will drop, and errors when the list will throw", () => {
    const diagnostics = lintRjsf({ schema, uiSchema: { "ui:order": ["firstName", "lastName"] } });
    expect(diagnostics).toMatchObject([
      { ruleId: "rjsf/unknown-order-entry", severity: "warning", path: "/ui:order/1" },
      { ruleId: "rjsf/incomplete-order", severity: "error", path: "/ui:order" },
    ]);
    expect(diagnostics[0]?.message).toContain("drops that entry");
    expect(diagnostics[1]?.message).toContain("renders an error");
  });

  it("accepts an order entry that only exists on a conditional branch", () => {
    const diagnostics = lintRjsf({
      schema: {
        type: "object",
        properties: { kind: { type: "string" } },
        oneOf: [{ properties: { kind: { const: "pet" }, petName: { type: "string" } } }],
      },
      uiSchema: { "ui:order": ["petName", "*"] },
    });
    expect(diagnostics).toEqual([]);
  });

  it("requires properties contributed by allOf, because RJSF always renders them", () => {
    const diagnostics = lintRjsf({
      schema: {
        type: "object",
        properties: { kind: { type: "string" } },
        allOf: [{ properties: { note: { type: "string" } } }],
      },
      uiSchema: { "ui:order": ["kind"] },
    });
    expect(diagnostics).toMatchObject([{ ruleId: "rjsf/incomplete-order", message: expect.stringContaining("`note`") }]);
  });

  it("does not treat names on an open object as unknown order entries", () => {
    const diagnostics = lintRjsf({
      schema: { type: "object", properties: { kind: { type: "string" } }, additionalProperties: true },
      uiSchema: { "ui:order": ["kind", "extra"] },
    });
    expect(diagnostics).toEqual([]);
  });

  it("errors when ui:order has more than one wildcard", () => {
    const diagnostics = lintRjsf({ schema, uiSchema: { "ui:order": ["*", "firstName", "*"] } });
    expect(diagnostics).toMatchObject([{ ruleId: "rjsf/multiple-order-wildcards", severity: "error", path: "/ui:order/2" }]);
  });

  it("lints ui:definitions against the schema each key points at", () => {
    const diagnostics = lintRjsf({
      schema: {
        type: "object",
        $defs: { address: { type: "object", properties: { street: { type: "string" }, zip: { type: "integer" } }, required: ["zip"] } },
        properties: { home: { $ref: "#/$defs/address" } },
      },
      uiSchema: {
        "ui:definitions": {
          "#/$defs/address": { streat: {}, zip: { "ui:widget": "textarea" } },
          "#/$defs/adress": { street: {} },
        },
      },
    });
    expect(diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual([
      "rjsf/unknown-ui-key",
      "rjsf/widget-type-mismatch",
      "rjsf/unresolved-definition",
    ]);
    expect(diagnostics[0]?.suggestion).toContain("`street`");
    expect(diagnostics[2]?.suggestion).toContain("`#/$defs/address`");
  });

  it("flags a ui:definitions key that resolves but is not a $ref", () => {
    const diagnostics = lintRjsf({
      schema: {
        type: "object",
        $defs: { address: { type: "object", properties: { street: { type: "string" } } } },
        properties: { home: { $ref: "#/$defs/address" } },
      },
      uiSchema: { "ui:definitions": { "#/properties/home": { street: { "ui:widget": "textarea" } } } },
    });
    expect(diagnostics).toMatchObject([
      { ruleId: "rjsf/unresolved-definition", message: expect.stringContaining("No `$ref` in the schema equals") },
    ]);
  });

  it("flags a hidden required field whose requirement comes from allOf", () => {
    const diagnostics = lintRjsf({
      schema: {
        type: "object",
        properties: { token: { type: "string" } },
        allOf: [{ required: ["token"] }],
      },
      uiSchema: { token: { "ui:widget": "hidden" } },
    });
    expect(diagnostics).toMatchObject([{ ruleId: "rjsf/hidden-required" }]);
  });

  it("flags required fields hidden without a default", () => {
    const diagnostics = lintRjsf({ schema, uiSchema: { token: { "ui:widget": "hidden" } } });
    expect(diagnostics).toMatchObject([{ ruleId: "rjsf/hidden-required", path: "/token/ui:widget" }]);
  });

  it("allows hidden required fields that have a default", () => {
    const diagnostics = lintRjsf({
      schema: { ...schema, properties: { ...schema.properties, token: { type: "string", default: "abc" } } },
      uiSchema: { token: { "ui:widget": "hidden" } },
    });
    expect(diagnostics).toEqual([]);
  });

  it("flags built-in widgets used with the wrong type unless registered", () => {
    const uiSchema = { age: { "ui:widget": "textarea" } };
    expect(lintRjsf({ schema, uiSchema })).toMatchObject([{ ruleId: "rjsf/widget-type-mismatch" }]);
    expect(lintRjsf({ schema, uiSchema, customWidgets: ["textarea"] })).toEqual([]);
  });

  it("ignores unknown widget names, which are assumed to be registered", () => {
    expect(lintRjsf({ schema, uiSchema: { age: { "ui:widget": "StarRating" } } })).toEqual([]);
  });
});
