/**
 * Money utilities for POS calculations.
 * STRICT RULE: All amounts are stored and calculated in exact integer minor units (cents).
 * No floating-point amounts are ever returned.
 */

/**
 * Rounds to nearest integer cent.
 */
export function round(cents) {
  if (cents == null || isNaN(cents)) return 0;
  return Math.round(Number(cents));
}

/**
 * Adds multiple amounts in cents.
 */
export function add(...amounts) {
  return amounts.reduce((sum, a) => sum + round(a), 0);
}

/**
 * Subtracts amount b from a.
 */
export function subtract(a, b) {
  return round(a) - round(b);
}

/**
 * Multiplies unit price in cents by quantity.
 */
export function multiplyByQty(unitPriceCents, qty) {
  return Math.round(round(unitPriceCents) * (Number(qty) || 0));
}

/**
 * Calculates a percentage discount on an amount in cents.
 */
export function percentDiscount(amountCents, percent) {
  if (!percent || percent <= 0) return 0;
  return Math.round((round(amountCents) * Number(percent)) / 100);
}

/**
 * Calculates tax on an amount in cents given a tax rate percentage.
 */
export function calculateTax(amountCents, taxRatePercent) {
  if (!taxRatePercent || taxRatePercent <= 0) return 0;
  return Math.round((round(amountCents) * Number(taxRatePercent)) / 100);
}

/**
 * Calculates line-level pricing, discounts, and taxes.
 *
 * @param {{
 *   unitPriceCents: number,
 *   qty?: number,
 *   discountPercent?: number,
 *   discountAmountCents?: number,
 *   taxRatePercent?: number
 * }} params
 * @returns {{
 *   grossCents: number,
 *   discountCents: number,
 *   netCents: number,
 *   taxCents: number,
 *   lineTotalCents: number
 * }}
 */
export function calculateLine({
  unitPriceCents,
  qty = 1,
  discountPercent = 0,
  discountAmountCents = 0,
  taxRatePercent = 0,
}) {
  const grossCents = multiplyByQty(unitPriceCents, qty);

  let discountCents = 0;
  if (discountAmountCents > 0) {
    discountCents = Math.min(round(discountAmountCents), grossCents);
  } else if (discountPercent > 0) {
    discountCents = Math.min(percentDiscount(grossCents, discountPercent), grossCents);
  }

  const netCents = subtract(grossCents, discountCents);
  const taxCents = calculateTax(netCents, taxRatePercent);
  const lineTotalCents = add(netCents, taxCents);

  return {
    grossCents,
    discountCents,
    netCents,
    taxCents,
    lineTotalCents,
  };
}

/**
 * Calculates invoice totals across all lines, discounts, taxes, and trade-in deductions.
 *
 * FRS Test Case:
 * Subtotal 395,400, discount 490, trade-in 45,000 => Grand Total = 349,910
 *
 * @param {{
 *   lines?: Array<any>,
 *   subtotalCents?: number,
 *   totalLineDiscountsCents?: number,
 *   invoiceDiscountPercent?: number,
 *   invoiceDiscountAmountCents?: number,
 *   tradeInValueCents?: number,
 *   taxRatePercent?: number
 * }} params
 * @returns {{
 *   subtotalCents: number,
 *   totalLineDiscountsCents: number,
 *   invoiceDiscountCents: number,
 *   totalDiscountCents: number,
 *   taxCents: number,
 *   tradeInValueCents: number,
 *   grandTotalCents: number
 * }}
 */
export function calculateInvoiceTotals({
  lines = [],
  subtotalCents: directSubtotal,
  totalLineDiscountsCents: directLineDiscounts,
  invoiceDiscountPercent = 0,
  invoiceDiscountAmountCents = 0,
  tradeInValueCents = 0,
  taxRatePercent = 0,
} = {}) {
  let subtotalCents = 0;
  let totalLineDiscountsCents = 0;
  let lineTaxCents = 0;

  if (Array.isArray(lines) && lines.length > 0) {
    for (const line of lines) {
      const lineCalc = line.grossCents !== undefined && line.discountCents !== undefined
        ? line
        : calculateLine({
            unitPriceCents: line.unitPriceCents ?? line.priceCents ?? 0,
            qty: line.qty ?? 1,
            discountPercent: line.discountPercent ?? 0,
            discountAmountCents: line.discountAmountCents ?? 0,
            taxRatePercent: line.taxRatePercent ?? 0,
          });

      subtotalCents = add(subtotalCents, lineCalc.grossCents);
      totalLineDiscountsCents = add(totalLineDiscountsCents, lineCalc.discountCents);
      lineTaxCents = add(lineTaxCents, lineCalc.taxCents);
    }
  } else {
    subtotalCents = round(directSubtotal || 0);
    totalLineDiscountsCents = round(directLineDiscounts || 0);
  }

  const netBeforeInvoiceDiscount = Math.max(0, subtract(subtotalCents, totalLineDiscountsCents));

  let invoiceDiscountCents = 0;
  if (invoiceDiscountAmountCents > 0) {
    invoiceDiscountCents = Math.min(round(invoiceDiscountAmountCents), netBeforeInvoiceDiscount);
  } else if (invoiceDiscountPercent > 0) {
    invoiceDiscountCents = Math.min(percentDiscount(netBeforeInvoiceDiscount, invoiceDiscountPercent), netBeforeInvoiceDiscount);
  }

  const totalDiscountCents = add(totalLineDiscountsCents, invoiceDiscountCents);
  const netAfterAllDiscounts = Math.max(0, subtract(subtotalCents, totalDiscountCents));

  let taxCents = 0;
  if (lineTaxCents > 0) {
    taxCents = lineTaxCents;
  } else if (taxRatePercent > 0) {
    taxCents = calculateTax(netAfterAllDiscounts, taxRatePercent);
  }

  const tradeInCents = round(tradeInValueCents || 0);
  const grandTotalCents = Math.max(0, subtract(add(netAfterAllDiscounts, taxCents), tradeInCents));

  return {
    subtotalCents,
    totalLineDiscountsCents,
    invoiceDiscountCents,
    totalDiscountCents,
    taxCents,
    tradeInValueCents: tradeInCents,
    grandTotalCents,
  };
}

export default {
  round,
  add,
  subtract,
  multiplyByQty,
  percentDiscount,
  calculateTax,
  calculateLine,
  calculateInvoiceTotals,
};
