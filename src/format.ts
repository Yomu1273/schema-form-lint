import type { Diagnostic, DocumentKind } from "./types";

export type DocumentNames = Partial<Record<DocumentKind, string>>;

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

export const summarize = (diagnostics: Diagnostic[]): { errors: number; warnings: number } => ({
  errors: diagnostics.filter((diagnostic) => diagnostic.severity === "error").length,
  warnings: diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length,
});

export const formatText = (diagnostics: Diagnostic[], documentNames: DocumentNames = {}): string => {
  if (diagnostics.length === 0) return "No problems found.\n";

  const lines = diagnostics.flatMap((diagnostic) => {
    const location = `${documentNames[diagnostic.document] ?? diagnostic.document}#${diagnostic.path}`;
    const entry = [`${diagnostic.severity.padEnd(7)} ${diagnostic.ruleId}  ${location}`, `        ${diagnostic.message}`];
    if (diagnostic.suggestion) entry.push(`        fix: ${diagnostic.suggestion}`);
    return [...entry, ""];
  });

  const { errors, warnings } = summarize(diagnostics);
  lines.push(`${plural(diagnostics.length, "problem")} (${plural(errors, "error")}, ${plural(warnings, "warning")})`);
  return `${lines.join("\n")}\n`;
};

export const formatJson = (diagnostics: Diagnostic[]): string => `${JSON.stringify(diagnostics, null, 2)}\n`;
