import { describe, it, expect } from 'vitest';
import {
  round,
  add,
  subtract,
  multiplyByQty,
  percentDiscount,
  calculateTax,
  calculateLine,
  calculateInvoiceTotals,
} from '../src/modules/pos/money.js';

describe('POS Money Utility', () => {
  describe('Basic operations (Integer cents)', () => {
    it('round handles integers, nulls, and decimal values safely', () => {
      expect(round(100)).toBe(100);
      expect(round(100.4)).toBe(100);
      expect(round(100.6)).toBe(101);
      expect(round(null)).toBe(0);
      expect(round(undefined)).toBe(0);
      expect(round(NaN)).toBe(0);
    });

    it('add calculates exact sum without float drift', () => {
      expect(add(100, 200, 300)).toBe(600);
      expect(add(10, 20)).toBe(30);
      expect(add()).toBe(0);
    });

    it('subtract computes exact difference', () => {
      expect(subtract(500, 200)).toBe(300);
      expect(subtract(100, 150)).toBe(-50);
    });

    it('multiplyByQty calculates exact integer product', () => {
      expect(multiplyByQty(1500, 3)).toBe(4500);
      expect(multiplyByQty(1599, 0)).toBe(0);
      expect(multiplyByQty(999, 1)).toBe(999);
    });

    it('percentDiscount computes rounded discount', () => {
      // 10% on 10,000 cents = 1,000
      expect(percentDiscount(10000, 10)).toBe(1000);
      // 5% on 499 = 24.95 => 25 cents
      expect(percentDiscount(499, 5)).toBe(25);
      // 0% or negative percent returns 0
      expect(percentDiscount(1000, 0)).toBe(0);
      expect(percentDiscount(1000, -5)).toBe(0);
    });

    it('calculateTax computes exact rounded tax', () => {
      // 15% on 20,000 = 3,000
      expect(calculateTax(20000, 15)).toBe(3000);
      // 8% on 125 cents = 10 cents
      expect(calculateTax(125, 8)).toBe(10);
      // 0 tax rate
      expect(calculateTax(5000, 0)).toBe(0);
    });
  });

  describe('calculateLine', () => {
    it('computes gross, discount, net, tax, and lineTotal for single item', () => {
      const line = calculateLine({
        unitPriceCents: 10000, // 100.00
        qty: 2,
        discountPercent: 10, // 10% off
        taxRatePercent: 5,   // 5% tax
      });

      expect(line.grossCents).toBe(20000);
      expect(line.discountCents).toBe(2000);
      expect(line.netCents).toBe(18000);
      expect(line.taxCents).toBe(900);
      expect(line.lineTotalCents).toBe(18900);
    });

    it('supports fixed amount discount on line', () => {
      const line = calculateLine({
        unitPriceCents: 5000,
        qty: 1,
        discountAmountCents: 500,
        taxRatePercent: 0,
      });

      expect(line.grossCents).toBe(5000);
      expect(line.discountCents).toBe(500);
      expect(line.netCents).toBe(4500);
      expect(line.taxCents).toBe(0);
      expect(line.lineTotalCents).toBe(4500);
    });

    it('caps discount amount to gross amount', () => {
      const line = calculateLine({
        unitPriceCents: 1000,
        qty: 1,
        discountAmountCents: 1500,
      });

      expect(line.discountCents).toBe(1000);
      expect(line.netCents).toBe(0);
      expect(line.lineTotalCents).toBe(0);
    });
  });

  describe('calculateInvoiceTotals & FRS Verification', () => {
    it('accurately solves the FRS test case: Subtotal 395,400, discount 490, trade-in 45,000 => Grand Total = 349,910', () => {
      const result = calculateInvoiceTotals({
        subtotalCents: 395400,
        invoiceDiscountAmountCents: 490,
        tradeInValueCents: 45000,
        taxRatePercent: 0,
      });

      expect(result.subtotalCents).toBe(395400);
      expect(result.totalDiscountCents).toBe(490);
      expect(result.invoiceDiscountCents).toBe(490);
      expect(result.tradeInValueCents).toBe(45000);
      expect(result.grandTotalCents).toBe(349910);
    });

    it('solves FRS test case with line breakdown', () => {
      const lines = [
        { unitPriceCents: 395400, qty: 1, discountAmountCents: 0 },
      ];

      const result = calculateInvoiceTotals({
        lines,
        invoiceDiscountAmountCents: 490,
        tradeInValueCents: 45000,
      });

      expect(result.subtotalCents).toBe(395400);
      expect(result.invoiceDiscountCents).toBe(490);
      expect(result.totalDiscountCents).toBe(490);
      expect(result.tradeInValueCents).toBe(45000);
      expect(result.grandTotalCents).toBe(349910);
    });

    it('handles multiple lines with taxes and invoice discounts', () => {
      const lines = [
        { unitPriceCents: 10000, qty: 2, discountPercent: 10 }, // gross 20,000, disc 2,000, net 18,000
        { unitPriceCents: 5000, qty: 1, discountAmountCents: 500 }, // gross 5,000, disc 500, net 4,500
      ];

      const result = calculateInvoiceTotals({
        lines,
        invoiceDiscountAmountCents: 500, // additional 500 invoice discount
        taxRatePercent: 10,              // 10% tax on net after all discounts (22,000 * 10% = 2,200)
        tradeInValueCents: 2000,
      });

      expect(result.subtotalCents).toBe(25000);
      expect(result.totalLineDiscountsCents).toBe(2500);
      expect(result.invoiceDiscountCents).toBe(500);
      expect(result.totalDiscountCents).toBe(3000);
      // Net after discounts: 22,000. Tax 10%: 2,200. Grand Total: 22,000 + 2,200 - 2,000 = 22,200
      expect(result.taxCents).toBe(2200);
      expect(result.tradeInValueCents).toBe(2000);
      expect(result.grandTotalCents).toBe(22200);
    });
  });
});
