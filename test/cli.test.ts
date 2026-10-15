import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/cli";

const root = join(import.meta.dirname, "..");
const fixtureDir = join(tmpdir(), "schema-form-lint-cli");

const capture = () => vi.spyOn(process.stdout, "write").mockImplementation(() => true);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cli", () => {
  it("prints help and exits clean", () => {
    const stdout = capture();
    expect(run(["--help"])).toBe(0);
    expect(stdout.mock.calls[0]?.[0]).toContain("--rule");
  });

  it("exits 1 for the broken JSON Forms example", () => {
    capture();
    const code = run([
      "jsonforms",
      "--schema",
      join(root, "examples/jsonforms/schema.json"),
      "--uischema",
      join(root, "examples/jsonforms/uischema.json"),
    ]);
    expect(code).toBe(1);
  });

  it("exits 1 for the broken RJSF example", () => {
    capture();
    const code = run([
      "rjsf",
      "--schema",
      join(root, "examples/rjsf/schema.json"),
      "--ui-schema",
      join(root, "examples/rjsf/ui-schema.json"),
    ]);
    expect(code).toBe(1);
  });

  it("exits 0 when the only error is turned off", () => {
    mkdirSync(fixtureDir, { recursive: true });
    const schema = join(fixtureDir, "schema.json");
    const uischema = join(fixtureDir, "uischema.json");
    writeFileSync(
      schema,
      JSON.stringify({
        type: "object",
        properties: { reason: { type: "string" }, kind: { type: "string", enum: ["a", "b"] } },
        required: ["reason"],
      }),
    );
    writeFileSync(
      uischema,
      JSON.stringify({
        type: "Control",
        scope: "#/properties/reason",
        rule: { effect: "SHOW", condition: { scope: "#/properties/kind", schema: { const: "a" }, failWhenUndefined: true } },
      }),
    );
    capture();
    expect(run(["jsonforms", "--schema", schema, "--uischema", uischema])).toBe(1);
    expect(run(["jsonforms", "--schema", schema, "--uischema", uischema, "--rule", "jsonforms/required-hideable=off"])).toBe(0);
  });

  it("rejects an unknown rule level", () => {
    expect(() => run(["jsonforms", "--schema", join(root, "examples/jsonforms/schema.json"), "--rule", "jsonforms/required-hideable=loud"])).toThrow(
      /must be off, warning, or error/,
    );
  });
});
