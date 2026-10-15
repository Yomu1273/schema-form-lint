export type Severity = "error" | "warning";

export type DocumentKind = "schema" | "uischema";

export interface Diagnostic {
  ruleId: string;
  severity: Severity;
  document: DocumentKind;
  /** JSON Pointer into the document the diagnostic belongs to ("" is the root). */
  path: string;
  message: string;
  suggestion?: string;
}

export type JsonObject = Record<string, unknown>;
