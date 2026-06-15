/*---------------------------------------------------------------------------------------------
 * Dependency-free CSV utilities used by the "bring your own data" ingestion feature.
 *   - parseCsv: tolerant parser (RFC-4180-ish): quoted fields, escaped quotes (""), embedded
 *     commas/newlines inside quotes, CRLF or LF, trimmed headers, skipped fully-blank lines.
 *   - toCsv: serialize rows back to CSV (used for "Download template" / download-current).
 * No external deps (scope constraint). Pure functions — unit-testable without a DOM.
 *--------------------------------------------------------------------------------------------*/

export interface ParsedCsv {
  /** Header names, in column order, trimmed. */
  columns: string[];
  /** One object per data row, keyed by column name (string values, trimmed). */
  rows: Record<string, string>[];
}

/** Split raw CSV text into a 2-D array of cells, honoring quoted fields. */
function tokenize(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let started = false; // any non-newline char seen on the current physical row?

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    out.push(row);
    row = [];
    started = false;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++; // skip the escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      started = true;
      continue;
    }
    if (c === ",") {
      pushField();
      started = true;
      continue;
    }
    if (c === "\n" || c === "\r") {
      // Normalize CRLF: a \r followed by \n counts as one line break.
      if (c === "\r" && text[i + 1] === "\n") i++;
      if (started || field.length > 0 || row.length > 0) pushRow();
      continue;
    }
    field += c;
    started = true;
  }
  // Flush trailing field/row (no terminating newline).
  if (started || field.length > 0 || row.length > 0) pushRow();
  return out;
}

/** Parse CSV text into { columns, rows }. Throws a friendly Error if there is no header row. */
export function parseCsv(text: string): ParsedCsv {
  const cells = tokenize(text ?? "");
  // Drop rows that are entirely empty (e.g. blank trailing lines).
  const nonEmpty = cells.filter((r) => r.some((c) => c.trim() !== ""));
  if (nonEmpty.length === 0) {
    throw new Error("The file is empty — expected a header row and at least one data row.");
  }
  const columns = nonEmpty[0].map((h) => h.trim());
  if (columns.every((c) => c === "")) {
    throw new Error("Could not read a header row from the file.");
  }
  const rows: Record<string, string>[] = [];
  for (let r = 1; r < nonEmpty.length; r++) {
    const cs = nonEmpty[r];
    const obj: Record<string, string> = {};
    columns.forEach((col, ci) => {
      if (col === "") return;
      obj[col] = (cs[ci] ?? "").trim();
    });
    rows.push(obj);
  }
  return { columns, rows };
}

/** Quote a single CSV cell if it contains a comma, quote, or newline. */
function quoteCell(value: string | number | boolean): string {
  const s = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Serialize rows (objects) to CSV text with the given column order. */
export function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const header = columns.map(quoteCell).join(",");
  const body = rows.map((row) =>
    columns.map((c) => quoteCell((row[c] as string | number | boolean) ?? "")).join(",")
  );
  return `${[header, ...body].join("\r\n")}\r\n`;
}

/** Tolerant numeric parse: strips thousands separators / stray spaces; returns fallback on NaN. */
export function num(value: string | undefined, fallback = 0): number {
  if (value === undefined) return fallback;
  const cleaned = value.replace(/[,\s]/g, "");
  if (cleaned === "") return fallback;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : fallback;
}

/** Tolerant boolean parse: "true/1/yes/y/eol" => true. */
export function bool(value: string | undefined): boolean {
  if (!value) return false;
  return /^(1|true|yes|y|t|eol)$/i.test(value.trim());
}
