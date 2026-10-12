import { normalizePhone } from './phone.js';

export const MAX_CSV_ROWS = 5000;
export const MAX_CSV_BYTES = 2 * 1024 * 1024; // 2MB

/**
 * Parses RFC 4180 CSV string into rows of fields.
 */
export function parseCsvRows(text) {
  if (typeof text !== 'string') return [];
  const rows = [];
  let currentRow = [];
  let currentField = '';
  let inQuotes = false;
  let i = 0;

  const input = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  while (i < input.length) {
    const char = input[i];

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < input.length && input[i + 1] === '"') {
          currentField += '"';
          i += 2;
          continue;
        } else {
          inQuotes = false;
          i++;
          continue;
        }
      } else {
        currentField += char;
        i++;
        continue;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
        i++;
        continue;
      } else if (char === ',') {
        currentRow.push(currentField.trim());
        currentField = '';
        i++;
        continue;
      } else if (char === '\n') {
        currentRow.push(currentField.trim());
        if (currentRow.some((f) => f.length > 0)) {
          rows.push(currentRow);
        }
        currentRow = [];
        currentField = '';
        i++;
        continue;
      } else {
        currentField += char;
        i++;
        continue;
      }
    }
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField.trim());
    if (currentRow.some((f) => f.length > 0)) {
      rows.push(currentRow);
    }
  }

  return rows;
}

/**
 * Validates and converts parsed CSV rows into customer documents.
 * Returns { validCustomers, errors: [{ row, field, message }] }
 */
export function validateCustomerCsvRows(rows) {
  const errors = [];
  if (!rows || rows.length < 2) {
    return {
      validCustomers: [],
      errors: [{ row: 1, field: 'header', message: 'CSV must contain a header row and at least one data row' }],
    };
  }

  if (rows.length - 1 > MAX_CSV_ROWS) {
    return {
      validCustomers: [],
      errors: [{ row: 1, field: 'file', message: `CSV contains ${rows.length - 1} rows. Maximum allowed is ${MAX_CSV_ROWS}.` }],
    };
  }

  const rawHeaders = rows[0].map((h) => String(h).trim().toLowerCase().replace(/[\s-]/g, '_'));
  const headerMap = {};
  rawHeaders.forEach((h, idx) => {
    headerMap[h] = idx;
  });

  if (headerMap.name === undefined || headerMap.phone === undefined) {
    return {
      validCustomers: [],
      errors: [{ row: 1, field: 'header', message: 'CSV header must include at least "name" and "phone"' }],
    };
  }

  const seenPhones = new Map(); // normalizedPhone -> row number
  const validCustomers = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const rowNumber = r + 1; // 1-indexed (row 1 is header, row 2 is first data row)

    const getField = (name) => {
      const idx = headerMap[name];
      return idx !== undefined && row[idx] !== undefined ? String(row[idx]).trim() : '';
    };

    const name = getField('name');
    const rawPhone = getField('phone');
    const email = getField('email').toLowerCase();
    const nic = getField('nic');
    const address = getField('address');
    const rawType = getField('type').toLowerCase() || 'retail';
    const rawTags = getField('tags');
    const notes = getField('notes');
    const rawOptIn = getField('marketing_opt_in').toLowerCase();

    // 1. Validate name
    if (!name) {
      errors.push({ row: rowNumber, field: 'name', message: 'Customer name is required' });
    } else if (name.length > 100) {
      errors.push({ row: rowNumber, field: 'name', message: 'Customer name must not exceed 100 characters' });
    }

    // 2. Validate phone
    if (!rawPhone) {
      errors.push({ row: rowNumber, field: 'phone', message: 'Phone number is required' });
    }
    const normalizedPhone = normalizePhone(rawPhone);
    if (rawPhone && !normalizedPhone) {
      errors.push({ row: rowNumber, field: 'phone', message: 'Invalid phone number format' });
    } else if (normalizedPhone) {
      if (seenPhones.has(normalizedPhone)) {
        errors.push({
          row: rowNumber,
          field: 'phone',
          message: `Duplicate phone number "${rawPhone}" in file (first seen on row ${seenPhones.get(normalizedPhone)})`,
        });
      } else {
        seenPhones.set(normalizedPhone, rowNumber);
      }
    }

    // 3. Validate email
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.push({ row: rowNumber, field: 'email', message: 'Invalid email address format' });
    }

    // 4. Validate type
    let type = 'retail';
    if (rawType) {
      if (['retail', 'wholesale'].includes(rawType)) {
        type = rawType;
      } else {
        errors.push({ row: rowNumber, field: 'type', message: 'Customer type must be "retail" or "wholesale"' });
      }
    }

    // 5. Parse tags
    const tags = rawTags
      ? rawTags
          .split(/[,;]/)
          .map((t) => t.trim())
          .filter((t) => t.length > 0 && t.length <= 50)
      : [];

    // 6. Marketing opt-in
    const marketingOptIn = ['true', '1', 'yes', 'y'].includes(rawOptIn);

    validCustomers.push({
      rowNumber,
      customerData: {
        name,
        phone: normalizedPhone || rawPhone,
        email,
        nic,
        address,
        type,
        tags,
        notes,
        marketingOptIn,
      },
    });
  }

  return { validCustomers, errors };
}
