// Spec §8.4: "Every report renders on screen and exports to CSV." First
// CSV feature in this codebase — deliberately minimal (RFC 4198-ish, no
// dependency): a field is quoted whenever it contains a comma, quote, or
// newline, with embedded quotes doubled. Good enough for the flat,
// single-level report rows this module produces; not a general-purpose
// CSV library.
function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function toCsv(columns: { key: string; label: string }[], rows: Record<string, unknown>[]): string {
  const header = columns.map((c) => csvField(c.label)).join(',');
  const lines = rows.map((row) => columns.map((c) => csvField(row[c.key])).join(','));
  return [header, ...lines].join('\r\n') + '\r\n';
}
