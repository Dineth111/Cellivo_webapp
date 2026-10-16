import { badRequest } from '../../../core/errors.js';

const COLOMBO_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000;

/**
 * Parses and validates a date range aligned with Asia/Colombo (UTC+5:30) boundaries.
 * Enforces a maximum range of 366 days.
 *
 * @param {string} [startDateStr] - 'YYYY-MM-DD' or ISO timestamp
 * @param {string} [endDateStr] - 'YYYY-MM-DD' or ISO timestamp
 * @returns {{ start: Date, end: Date }}
 */
export function parseColomboDateRange(startDateStr, endDateStr) {
  let start;
  let end;

  if (startDateStr) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(startDateStr)) {
      start = new Date(`${startDateStr}T00:00:00+05:30`);
    } else {
      start = new Date(startDateStr);
    }
  } else {
    // Default start date = 30 days ago in Colombo
    const nowColombo = new Date(Date.now() + COLOMBO_OFFSET_MS);
    const d = new Date(nowColombo);
    d.setUTCDate(d.getUTCDate() - 30);
    d.setUTCHours(0, 0, 0, 0);
    start = new Date(d.getTime() - COLOMBO_OFFSET_MS);
  }

  if (endDateStr) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(endDateStr)) {
      end = new Date(`${endDateStr}T23:59:59.999+05:30`);
    } else {
      end = new Date(endDateStr);
    }
  } else {
    const nowColombo = new Date(Date.now() + COLOMBO_OFFSET_MS);
    const d = new Date(nowColombo);
    d.setUTCHours(23, 59, 59, 999);
    end = new Date(d.getTime() - COLOMBO_OFFSET_MS);
  }

  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    throw badRequest('Invalid date format', 'INVALID_DATE');
  }

  if (start > end) {
    throw badRequest('Start date cannot be after end date', 'INVALID_DATE_RANGE');
  }

  const diffMs = end.getTime() - start.getTime();
  if (diffMs > MAX_RANGE_MS) {
    throw badRequest('Date range cannot exceed 366 days', 'DATE_RANGE_EXCEEDED');
  }

  return { start, end };
}
