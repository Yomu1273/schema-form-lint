import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { formatJson, formatText, summarize } from "./format";
import { lintJsonForms } from "./jsonforms/lintJsonForms";
import { parseRuleAssignment } from "./rules";
import type { RuleLevel } from "./rules";
import { lintRjsf } from "./rjsf/lintRjsf";
import type { Diagnostic } from "./types";

const USAGE = `Usage:
  schema-form-lint jsonforms --schema <file> [--uischema <file>] [options]
  schema-form-lint rjsf      --schema <file> [--ui-schema <file>] [options]

Options:
  --format <text|json>       Output format (default: text)
  --custom-widgets <a,b>     RJSF widget names registered through the widgets prop
  --rule <id>=<level>        Set a rule to off, warning, or error. Repeatable.
  --max-warnings <n>         Fail when there are more than n warnings
  -h, --help                 Show this help

Exit codes: 0 = clean, 1 = problems found, 2 = usage or input error.
`;

class UsageError extends Error {}

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new UsageError(`Could not read ${file}: ${reason}`);
  }
};

export const run = (argv: string[]): number => {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      schema: { type: "string" },
      uischema: { type: "string" },
      "ui-schema": { type: "string" },
      format: { type: "string", default: "text" },
      "custom-widgets": { type: "string" },
      rule: { type: "string", multiple: true },
      "max-warnings": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const [target] = positionals;
  if (target !== "jsonforms" && target !== "rjsf") throw new UsageError("Choose a target: jsonforms or rjsf.");
  if (!values.schema) throw new UsageError("--schema is required.");
  if (values.format !== "text" && values.format !== "json") throw new UsageError("--format must be text or json.");

  const maxWarnings = values["max-warnings"] === undefined ? Number.POSITIVE_INFINITY : Number(values["max-warnings"]);
  if (Number.isNaN(maxWarnings) || maxWarnings < 0) throw new UsageError("--max-warnings must be a non-negative number.");

  const rules: Record<string, RuleLevel> = {};
  for (const assignment of values.rule ?? []) {
    try {
      const parsed = parseRuleAssignment(assignment);
      rules[parsed.id] = parsed.level;
    } catch (error) {
      throw new UsageError(error instanceof Error ? error.message : String(error));
    }
  }

  const uiFile = values.uischema ?? values["ui-schema"];
  const schema = readJson(values.schema);
  const uiSchema = uiFile ? readJson(uiFile) : undefined;

  let diagnostics: Diagnostic[];
  try {
    diagnostics =
      target === "jsonforms"
        ? lintJsonForms({ schema, uischema: uiSchema, rules })
        : lintRjsf({
            schema,
            uiSchema,
            rules,
            customWidgets: values["custom-widgets"]?.split(",").map((name) => name.trim()).filter(Boolean) ?? [],
          });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }

  const documentNames = uiFile ? { schema: values.schema, uischema: uiFile } : { schema: values.schema };
  process.stdout.write(values.format === "json" ? formatJson(diagnostics) : formatText(diagnostics, documentNames));

  const { errors, warnings } = summarize(diagnostics);
  return errors > 0 || warnings > maxWarnings ? 1 : 0;
};

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n\n${USAGE}`);
    process.exitCode = 2;
  }
}
