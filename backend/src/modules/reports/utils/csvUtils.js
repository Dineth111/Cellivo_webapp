/**
 * Escapes a single CSV cell value according to formula injection prevention
 * and RFC 4180 CSV standard.
 *
 * If a cell starts with '=', '+', '-', or '@', prepends a single quote "'"
 * to prevent spreadsheet formula execution upon export.
 *
 * @param {any} val
 * @returns {string}
 */
export function escapeCsvCell(val) {
  if (val === null || val === undefined) return '';
  let str = String(val);

  // Formula prefix sanitization
  if (/^[=+\-@]/.test(str)) {
    str = `'${str}`;
  }

  // RFC 4180 escaping if contains delimiter, quote, or newline
  if (/[",\r\n]/.test(str)) {
    str = `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}

/**
 * Builds a CSV string from an array of column definitions and row objects.
 *
 * @param {Array<{ key: string, label: string, format?: (val: any, row: any) => any }>} columns
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
        return escapeCsvCell(rawVal);
      })
      .join(',')
  );

  return [header, ...lines].join('\r\n');
}
