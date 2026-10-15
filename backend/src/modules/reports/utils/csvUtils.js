/**
 * Escapes a single CSV cell value according to formula injection prevention
 * and RFC 4180 CSV standard.
 *
 * If a cell is non-numeric and starts with '=', '+', '-', '@', '\t', or '\r',
 * prepends a single quote "'" to prevent spreadsheet formula execution upon export.
 *
 * @param {any} val
 * @param {{ numeric?: boolean }} [options]
 * @returns {string}
 */
export function escapeCsvCell(val, { numeric = false } = {}) {
  if (val === null || val === undefined) return '';

  if (numeric || typeof val === 'number' || typeof val === 'boolean') {
    return String(val);
  }

  const str = String(val);
  let sanitized = str;
  // Formula prefix sanitization applies only to string cells
  if (/^[=+\-@\t\r]/.test(str)) {
    sanitized = `'${str}`;
  }

  // RFC 4180 escaping if contains delimiter, quote, or newline
  if (/[",\r\n]/.test(sanitized)) {
    sanitized = `"${sanitized.replace(/"/g, '""')}"`;
  }

  return sanitized;
}

/**
 * Builds a CSV string from an array of column definitions and row objects.
 *
 * @param {Array<{ key: string, label: string, numeric?: boolean, format?: (val: any, row: any) => any }>} columns
 * @param {Array<object>} rows
 * @returns {string}
 */
export function buildCsv(columns, rows) {
  const header = columns.map((col) => escapeCsvCell(col.label || col.key)).join(',');
  const lines = rows.map((row) =>
    columns
      .map((col) => {
        let rawVal = row[col.key];
        if (typeof col.format === 'function') {
          rawVal = col.format(rawVal, row);
        }
        const isNum = col.numeric === true || typeof rawVal === 'number';
        return escapeCsvCell(rawVal, { numeric: isNum });
      })
      .join(',')
  );

  return [header, ...lines].join('\r\n');
}
