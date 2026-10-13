import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { startDb, stopDb, resetDb } from './helpers.js';
import { api, signup, addStaff } from './api.js';
import { runWithContext, runAsPlatform } from '../src/core/tenantContext.js';
import RepairTicket from '../src/modules/repairs/models/RepairTicket.model.js';
import RepairSequence from '../src/modules/repairs/models/RepairSequence.model.js';
import LedgerEntry from '../src/modules/pos/models/LedgerEntry.model.js';
import Tenant from '../src/modules/tenants/Tenant.model.js';
import AuditLog from '../src/modules/audit/AuditLog.model.js';
import { validateImei } from '../src/modules/repairs/utils/imei.js';
import { encryptPasscode, decryptPasscode } from '../src/modules/repairs/utils/passcode.js';

beforeAll(startDb);
afterAll(stopDb);
beforeEach(resetDb);

async function setupShop(email = 'owner@cellivo.lk', shopName = 'Cellivo Repairs') {
  const shop = await signup(email, shopName);
  const me = await api('get', '/api/auth/me', shop.token);
  const tenantId = me.body.data.tenant._id;
  const branchId = me.body.data.tenant.mainBranchId || me.body.data.branchIds?.[0];
  return { ...shop, tenantId, branchId };
}

describe('Repairs Module (F-12 Phase 3)', () => {
  describe('Luhn IMEI Validation', () => {
    it('validates 15-digit IMEI with Luhn checksum; rejects invalid and accepts null', () => {
      // Valid Luhn IMEIs
      expect(validateImei('352099001761481')).toBe(true);
      expect(validateImei('864019041234563')).toBe(true);
      expect(validateImei('35 2099 00 176148 1')).toBe(true); // handles spaces

      // Invalid Luhn checksum
      expect(validateImei('352099001761482')).toBe(false);
      expect(validateImei('123456789012345')).toBe(false);

      // Invalid length / characters
      expect(validateImei('12345')).toBe(false);
      expect(validateImei('35209900176148A')).toBe(false);

      // Optional / null
      expect(validateImei(null)).toBe(false);
      expect(validateImei('')).toBe(false);
    });
  });

  describe('Passcode Encryption & Audited Reveal', () => {
    it('encrypts passcode in database, excludes from list, and audits reveal on single GET', async () => {
      process.env.REPAIR_PASSCODE_KEY = 'secret-encryption-key-for-repairs-32b';
      const shop = await setupShop();

      const created = await api('post', '/api/repairs', shop.token).send({
        customer: { name: 'Saman Perera', phone: '0771234567' },
        device: { brand: 'Apple', model: 'iPhone 13', imei: '352099001761481' },
        faultDescription: 'Broken OLED screen',
        passcode: '123456',
      });

      expect(created.status).toBe(201);
      const ticketId = created.body.data._id;

      // 1. In list: passcode is null / never returned
      const listRes = await api('get', '/api/repairs', shop.token);
      expect(listRes.status).toBe(200);
      expect(listRes.body.data[0].passcode).toBe(null);
      expect(listRes.body.data[0].passcodeEncrypted).toBeUndefined();

      // In database directly: passcode is encrypted
      const rawDoc = await runWithContext({ tenantId: shop.tenantId }, async () => {
        return await RepairTicket.findById(ticketId).lean();
      });
      expect(rawDoc.passcodeEncrypted).toBeDefined();
      expect(rawDoc.passcodeEncrypted.encrypted).toBeDefined();
      expect(rawDoc.passcodeEncrypted.iv).toBeDefined();
      expect(rawDoc.passcodeEncrypted.tag).toBeDefined();

      // 2. Single GET without revealPasscode: null
      const getNorm = await api('get', `/api/repairs/${ticketId}`, shop.token);
      expect(getNorm.body.data.passcode).toBe(null);

      // 3. Single GET with revealPasscode=true: reveals and audits
      const getReveal = await api('get', `/api/repairs/${ticketId}?revealPasscode=true`, shop.token);
      expect(getReveal.status).toBe(200);
      expect(getReveal.body.data.passcode).toBe('123456');

      const audits = await runWithContext({ tenantId: shop.tenantId }, async () => {
        return await AuditLog.find({ action: 'repair.passcode_revealed', entityId: String(ticketId) }).lean();
      });
      expect(audits).toHaveLength(1);
    });
  });

  describe('Atomic Ticket Numbering Under Concurrency', () => {
    it('generates sequential JOB-000001, JOB-000002 without collision under parallel creates', async () => {
      const shop = await setupShop();

      // 5 concurrent ticket creations
      const creates = Array.from({ length: 5 }, (_, i) =>
        api('post', '/api/repairs', shop.token).send({
          customer: { name: `Customer ${i}`, phone: `077111111${i}` },
          device: { brand: 'Samsung', model: 'Galaxy S21' },
          faultDescription: `Fault ${i}`,
        })
      );

      const responses = await Promise.all(creates);
      responses.forEach((res) => expect(res.status).toBe(201));

      const ticketNos = responses.map((r) => r.body.data.ticketNo);
      expect(ticketNos).toHaveLength(5);
      const uniqueNos = new Set(ticketNos);
      expect(uniqueNos.size).toBe(5);

      ticketNos.sort();
      expect(ticketNos).toEqual([
        'JOB-000001',
        'JOB-000002',
        'JOB-000003',
        'JOB-000004',
        'JOB-000005',
      ]);
    });
  });

  describe('State Transitions & Approval Gate', () => {
    it('enforces allowed stage transitions and rejects invalid moves with 400', async () => {
      const shop = await setupShop();
      const res = await api('post', '/api/repairs', shop.token).send({
        customer: { name: 'Kamal Silva', phone: '0772222222' },
        device: { brand: 'Xiaomi', model: 'Redmi Note 10' },
        faultDescription: 'Battery drain',
      });
      const tid = res.body.data._id;

      // Initial stage: Received
      expect(res.body.data.stage).toBe('Received');

      // Invalid move directly to Delivered or In repair
      const badMove = await api('post', `/api/repairs/${tid}/stage`, shop.token).send({ to: 'Delivered' });
      expect(badMove.status).toBe(400);
      expect(badMove.body.code).toBe('INVALID_STAGE_TRANSITION');

      // Move Received -> Diagnosing: OK
      const toDiag = await api('post', `/api/repairs/${tid}/stage`, shop.token).send({ to: 'Diagnosing' });
      expect(toDiag.status).toBe(200);
      expect(toDiag.body.data.stage).toBe('Diagnosing');

      // Move Diagnosing -> Waiting approval: OK
      const toWait = await api('post', `/api/repairs/${tid}/stage`, shop.token).send({ to: 'Waiting approval' });
      expect(toWait.status).toBe(200);
      expect(toWait.body.data.stage).toBe('Waiting approval');
    });

    it('requires customer approval or authorized waiver before moving to In repair; waiver persists', async () => {
      const shop = await setupShop();
      const res = await api('post', '/api/repairs', shop.token).send({
        customer: { name: 'Sunil Perera', phone: '0773333333' },
        device: { brand: 'Apple', model: 'iPhone 11' },
        faultDescription: 'Charging port issue',
      });
      const tid = res.body.data._id;

      await api('post', `/api/repairs/${tid}/stage`, shop.token).send({ to: 'Diagnosing' });

      // Move Diagnosing -> In repair without approval: fails 400
      const unapproved = await api('post', `/api/repairs/${tid}/stage`, shop.token).send({ to: 'In repair' });
      expect(unapproved.status).toBe(400);
      expect(unapproved.body.code).toBe('APPROVAL_REQUIRED');

      // Waived by owner / repairs.approve: succeeds and sets waived status
      const waived = await api('post', `/api/repairs/${tid}/stage`, shop.token).send({
        to: 'In repair',
        waiveApproval: true,
      });
      expect(waived.status).toBe(200);
      expect(waived.body.data.stage).toBe('In repair');
      expect(waived.body.data.approval.status).toBe('waived');

      // Move In repair -> Waiting parts -> In repair: waiver persists so no second check needed
      await api('post', `/api/repairs/${tid}/stage`, shop.token).send({ to: 'Waiting parts' });
      const backToRepair = await api('post', `/api/repairs/${tid}/stage`, shop.token).send({ to: 'In repair' });
      expect(backToRepair.status).toBe(200);
      expect(backToRepair.body.data.stage).toBe('In repair');
    });

    it('records complete history timeline on every action', async () => {
      const shop = await setupShop();
      const res = await api('post', '/api/repairs', shop.token).send({
        customer: { name: 'Anura Dias', phone: '0774444444' },
        device: { brand: 'OnePlus', model: '9 Pro' },
        faultDescription: 'Camera blurry',
      });
      const tid = res.body.data._id;

      await api('post', `/api/repairs/${tid}/stage`, shop.token).send({ to: 'Diagnosing', note: 'Inspecting lens' });
      await api('post', `/api/repairs/${tid}/approval`, shop.token).send({ decision: 'approved', by: 'in_person' });
      await api('post', `/api/repairs/${tid}/stage`, shop.token).send({ to: 'In repair', note: 'Lens replacement' });

      const finalTicket = await api('get', `/api/repairs/${tid}`, shop.token);
      const history = finalTicket.body.data.history;
      expect(history.length).toBeGreaterThanOrEqual(4);
      expect(history[0].to).toBe('Received');
      expect(history[1].to).toBe('Diagnosing');
      expect(history[1].note).toBe('Inspecting lens');
      expect(history[history.length - 1].to).toBe('In repair');
    });
  });

  describe('Technician Scoping & Workload', () => {
    it('restricts technician to only their assigned tickets in list, board, and single GET', async () => {
      const shop = await setupShop();

      // Invite technician staff (has repairs.view and repairs.edit, but NOT repairs.create)
      const techUser = await addStaff(shop, 'technician', 'tech1@shop.lk');

      // Create ticket 1 assigned to techUser
      const t1 = await api('post', '/api/repairs', shop.token).send({
        customer: { name: 'Customer A', phone: '0775555551' },
        device: { brand: 'Apple', model: 'iPhone 12' },
        faultDescription: 'Fault A',
        technicianId: techUser.id,
      });

      // Create ticket 2 unassigned (or assigned to someone else)
      const t2 = await api('post', '/api/repairs', shop.token).send({
        customer: { name: 'Customer B', phone: '0775555552' },
        device: { brand: 'Samsung', model: 'S20' },
        faultDescription: 'Fault B',
      });

      // 1. Technician lists tickets: sees only ticket 1
      const techList = await api('get', '/api/repairs', techUser.token);
      expect(techList.status).toBe(200);
      expect(techList.body.data).toHaveLength(1);
      expect(techList.body.data[0]._id).toBe(t1.body.data._id);

      // 2. Technician views board: only ticket 1 in items
      const techBoard = await api('get', '/api/repairs/board', techUser.token);
      expect(techBoard.status).toBe(200);
      expect(techBoard.body.data.Received.count).toBe(1);

      // 3. Technician views ticket 1: OK (200)
      const getT1 = await api('get', `/api/repairs/${t1.body.data._id}`, techUser.token);
      expect(getT1.status).toBe(200);

      // 4. Technician views ticket 2: 404 Not Found
      const getT2 = await api('get', `/api/repairs/${t2.body.data._id}`, techUser.token);
      expect(getT2.status).toBe(404);

      // 5. Technicians workload endpoint reports active count
      const workload = await api('get', '/api/repairs/technicians/workload', shop.token);
      expect(workload.status).toBe(200);
      const techWl = workload.body.data.find((w) => w._id === techUser.id);
      expect(techWl).toBeDefined();
      expect(techWl.activeTicketsCount).toBe(1);
    });
  });

  describe('Invoice Settlement & Accounting Entries', () => {
    it('Case A: due > 0 (posts balanced Dr cash, Dr 2020 deposit, Cr 4020 revenue, no COGS/Inventory)', async () => {
      const shop = await setupShop();

      // Intake with Rs 1,000 (100,000 cents) advance
      const res = await api('post', '/api/repairs', shop.token).send({
        customer: { name: 'Kasun Bandara', phone: '0776666661' },
        device: { brand: 'Huawei', model: 'Nova 7i' },
        faultDescription: 'Screen & battery replacement',
        advanceCents: 100_000,
        advancePaymentMethod: 'cash',
      });
      const tid = res.body.data._id;

      // Add a part: unit price Rs 2,500 (250,000 cents), cost Rs 1,500 (150,000 cents)
      await api('post', `/api/repairs/${tid}/parts`, shop.token).send({
        name: 'OLED Assembly',
        qty: 1,
        unitPriceCents: 250_000,
        unitCostCents: 150_000,
      });

      // Settle invoice with Rs 1,500 labour (150,000 cents). Total = 250k + 150k = 400k (Rs 4,000). Due = 300k (Rs 3,000).
      const invRes = await api('post', `/api/repairs/${tid}/invoice`, shop.token).send({
        paymentMethod: 'cash',
        labourCents: 150_000,
      });
      expect(invRes.status).toBe(200);
      expect(invRes.body.data.isInvoiceSettled).toBe(true);
      expect(invRes.body.data.invoiceTotalCents).toBe(400_000);

      // Check ledger journal entries
      const entries = await runWithContext({ tenantId: shop.tenantId }, async () => {
        return await LedgerEntry.find({ referenceId: invRes.body.data.ticketNo, isVoided: false }).lean();
      });
      // Advance deposit + final invoice = 2 entries
      expect(entries).toHaveLength(2);

      const invEntry = entries.find((e) => e.description.includes('invoice'));
      expect(invEntry).toBeDefined();
      expect(invEntry.referenceType).toBe('manual');

      // Verify lines: Dr 1010 (300k), Dr 2020 (100k), Cr 4020 (400k)
      const debit1010 = invEntry.lines.find((l) => l.accountCode === '1010');
      const debit2020 = invEntry.lines.find((l) => l.accountCode === '2020');
      const credit4020 = invEntry.lines.find((l) => l.accountCode === '4020');

      expect(debit1010.debit).toBe(300_000);
      expect(debit2020.debit).toBe(100_000);
      expect(credit4020.credit).toBe(400_000);

      // Verify NO 5010 or 1050 lines posted
      expect(invEntry.lines.some((l) => l.accountCode === '5010')).toBe(false);
      expect(invEntry.lines.some((l) => l.accountCode === '1050')).toBe(false);

      // Invoicing second time rejected (idempotent)
      const dupInv = await api('post', `/api/repairs/${tid}/invoice`, shop.token).send({ paymentMethod: 'cash' });
      expect(dupInv.status).toBe(400);
      expect(dupInv.body.code).toBe('ALREADY_INVOICED');
    });

    it('Case B: due == 0 (advance == total: Dr 2020, Cr 4020; payment line omitted)', async () => {
      const shop = await setupShop();

      // Intake with advance Rs 2,000 (200,000 cents)
      const res = await api('post', '/api/repairs', shop.token).send({
        customer: { name: 'Ruwan Kumara', phone: '0776666662' },
        device: { brand: 'Sony', model: 'Xperia 1' },
        faultDescription: 'Software reflash',
        advanceCents: 200_000,
        advancePaymentMethod: 'cash',
      });
      const tid = res.body.data._id;

      // Invoice with exactly Rs 2,000 labour (200,000 cents)
      const invRes = await api('post', `/api/repairs/${tid}/invoice`, shop.token).send({
        paymentMethod: 'cash',
        labourCents: 200_000,
      });
      expect(invRes.status).toBe(200);

      const entries = await runWithContext({ tenantId: shop.tenantId }, async () => {
        return await LedgerEntry.find({ referenceId: invRes.body.data.ticketNo, isVoided: false }).lean();
      });
      const invEntry = entries.find((e) => e.description.includes('invoice'));

      // Lines must be exactly 2: Dr 2020 (200k), Cr 4020 (200k). No 0-value lines.
      expect(invEntry.lines).toHaveLength(2);
      expect(invEntry.lines[0].accountCode).toBe('2020');
      expect(invEntry.lines[0].debit).toBe(200_000);
      expect(invEntry.lines[1].accountCode).toBe('4020');
      expect(invEntry.lines[1].credit).toBe(200_000);
    });

    it('Case C: advance > total (refunds excess: Dr 2020, Cr 4020, Cr cash refund)', async () => {
      const shop = await setupShop();

      // Intake with advance Rs 3,000 (300,000 cents)
      const res = await api('post', '/api/repairs', shop.token).send({
        customer: { name: 'Chathura Fernando', phone: '0776666663' },
        device: { brand: 'Nokia', model: 'G20' },
        faultDescription: 'Charging port cleaning',
        advanceCents: 300_000,
        advancePaymentMethod: 'cash',
      });
      const tid = res.body.data._id;

      // Final job total Rs 1,000 (100,000 cents). Excess Rs 2,000 (200,000 cents) refunded.
      const invRes = await api('post', `/api/repairs/${tid}/invoice`, shop.token).send({
        paymentMethod: 'cash',
        labourCents: 100_000,
      });
      expect(invRes.status).toBe(200);

      const entries = await runWithContext({ tenantId: shop.tenantId }, async () => {
        return await LedgerEntry.find({ referenceId: invRes.body.data.ticketNo, isVoided: false }).lean();
      });
      const invEntry = entries.find((e) => e.description.includes('invoice'));

      // Dr 2020 (300k), Cr 4020 (100k), Cr 1010 (200k refund)
      const debit2020 = invEntry.lines.find((l) => l.accountCode === '2020');
      const credit4020 = invEntry.lines.find((l) => l.accountCode === '4020');
      const credit1010 = invEntry.lines.find((l) => l.accountCode === '1010');

      expect(debit2020.debit).toBe(300_000);
      expect(credit4020.credit).toBe(100_000);
      expect(credit1010.credit).toBe(200_000);
    });
  });

  describe('Advance on Cancelled / Unrepairable & Reopening', () => {
    it('requires advanceDecision (refund | keep_fee) and repairs.approve permission; posts journal and stays idempotent', async () => {
      const shop = await setupShop();
      const cashier = await addStaff(shop, 'cashier', 'cashier1@shop.lk');

      const res = await api('post', '/api/repairs', shop.token).send({
        customer: { name: 'Lalith Gamage', phone: '0777777771' },
        device: { brand: 'Oppo', model: 'A54' },
        faultDescription: 'Water damaged',
        advanceCents: 150_000, // Rs 1,500
        advancePaymentMethod: 'cash',
      });
      const tid = res.body.data._id;
      await api('post', `/api/repairs/${tid}/stage`, shop.token).send({ to: 'Diagnosing' });

      // 1. Cashier attempts to cancel ticket with advance without permission: fails 403
      const cashierCancel = await api('post', `/api/repairs/${tid}/stage`, cashier.token).send({
        to: 'Cancelled',
        advanceDecision: 'refund',
      });
      expect(cashierCancel.status).toBe(403);

      // 2. Owner cancels with keep_fee of Rs 500 (50,000 cents) and refunds remainder Rs 1,000 (100,000 cents)
      const cancelRes = await api('post', `/api/repairs/${tid}/stage`, shop.token).send({
        to: 'Cancelled',
        advanceDecision: 'keep_fee',
        feeCents: 50_000,
        paymentMethod: 'cash',
        note: 'Board unrepairable, kept inspection fee',
      });
      expect(cancelRes.status).toBe(200);
      expect(cancelRes.body.data.stage).toBe('Cancelled');
      expect(cancelRes.body.data.advanceSettled).toBe(true);

      // Verify journal entry: Dr 2020 (150k), Cr 4020 (50k fee), Cr 1010 (100k refund)
      const entries = await runWithContext({ tenantId: shop.tenantId }, async () => {
        return await LedgerEntry.find({ referenceId: cancelRes.body.data.ticketNo, isVoided: false }).lean();
      });
      const cancelEntry = entries.find((e) => e.description.includes('Cancelled') || e.description.includes('keep_fee'));
      expect(cancelEntry).toBeDefined();

      const l2020 = cancelEntry.lines.find((l) => l.accountCode === '2020');
      const l4020 = cancelEntry.lines.find((l) => l.accountCode === '4020');
      const l1010 = cancelEntry.lines.find((l) => l.accountCode === '1010');

      expect(l2020.debit).toBe(150_000);
      expect(l4020.credit).toBe(50_000);
      expect(l1010.credit).toBe(100_000);

      // 3. Reopen: only owner can reopen terminal stage to Diagnosing
      const nonOwnerReopen = await api('post', `/api/repairs/${tid}/stage`, cashier.token).send({ to: 'Diagnosing' });
      expect(nonOwnerReopen.status).toBe(403);

      const ownerReopen = await api('post', `/api/repairs/${tid}/stage`, shop.token).send({ to: 'Diagnosing' });
      expect(ownerReopen.status).toBe(200);
      expect(ownerReopen.body.data.stage).toBe('Diagnosing');

      // Verify reopen was audited
      const reopenAudits = await runWithContext({ tenantId: shop.tenantId }, async () => {
        return await AuditLog.find({ action: 'repair.reopened', entityId: String(tid) }).lean();
      });
      expect(reopenAudits).toHaveLength(1);

      // Verify advance was NOT re-settled or double refunded
      const entriesAfterReopen = await runWithContext({ tenantId: shop.tenantId }, async () => {
        return await LedgerEntry.find({ referenceId: cancelRes.body.data.ticketNo, isVoided: false }).lean();
      });
      expect(entriesAfterReopen).toHaveLength(entries.length); // no new ledger entry
    });
  });

  describe('Cost Margin Protection (view_cost_margin)', () => {
    it('masks partsCostCents and part unitCostCents for staff without view_cost_margin', async () => {
      const shop = await setupShop();
      const cashier = await addStaff(shop, 'cashier', 'cashier2@shop.lk');

      const res = await api('post', '/api/repairs', shop.token).send({
        customer: { name: 'Customer Cost', phone: '0778888881' },
        device: { brand: 'Vivo', model: 'V21' },
        faultDescription: 'Microphone replacement',
      });
      const tid = res.body.data._id;

      await api('post', `/api/repairs/${tid}/parts`, shop.token).send({
        name: 'Mic Flex Cable',
        qty: 1,
        unitPriceCents: 100_000,
        unitCostCents: 40_000,
      });

      // 1. Cashier view: cost fields are omitted
      const cashierView = await api('get', `/api/repairs/${tid}`, cashier.token);
      expect(cashierView.status).toBe(200);
      expect(cashierView.body.data.partsCostCents).toBeUndefined();
      expect(cashierView.body.data.parts[0].unitCostCents).toBeUndefined();
      expect(cashierView.body.data.parts[0].unitPriceCents).toBe(100_000);

      // 2. Owner view: cost fields are visible
      const ownerView = await api('get', `/api/repairs/${tid}`, shop.token);
      expect(ownerView.status).toBe(200);
      expect(ownerView.body.data.partsCostCents).toBe(40_000);
      expect(ownerView.body.data.parts[0].unitCostCents).toBe(40_000);
    });
  });

  describe('Plan Limits & Overdue Filtering', () => {
    it('rejects access with 403 FEATURE_NOT_IN_PLAN for tenants on plan without repairs feature', async () => {
      const shop = await setupShop('lite@shop.lk', 'Lite Shop');

      // Downgrade tenant to 'lite' plan (which only has features: ['pos'])
      await runAsPlatform(async () => {
        await Tenant.findByIdAndUpdate(shop.tenantId, { planCode: 'lite' });
      });

      const res = await api('get', '/api/repairs', shop.token);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FEATURE_NOT_IN_PLAN');
    });

    it('returns overdue tickets correctly in GET /api/repairs/overdue', async () => {
      const shop = await setupShop();

      // Create an overdue ticket (promisedDate in past)
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      await api('post', '/api/repairs', shop.token).send({
        customer: { name: 'Late Customer', phone: '0779999991' },
        device: { brand: 'Apple', model: 'iPad Air' },
        faultDescription: 'Battery swap',
        promisedDate: yesterday,
      });

      // Create a future ticket
      const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      await api('post', '/api/repairs', shop.token).send({
        customer: { name: 'Future Customer', phone: '0779999992' },
        device: { brand: 'Apple', model: 'iPad Mini' },
        faultDescription: 'Screen replacement',
        promisedDate: nextWeek,
      });

      const overdueRes = await api('get', '/api/repairs/overdue', shop.token);
      expect(overdueRes.status).toBe(200);
      expect(overdueRes.body.count).toBe(1);
      expect(overdueRes.body.data[0].faultDescription).toBe('Battery swap');
    });
  });

  describe('Job Card & Printable Payload', () => {
    it('returns formatted job card with QR placeholder and wa.me link', async () => {
      const shop = await setupShop();

      const res = await api('post', '/api/repairs', shop.token).send({
        customer: { name: 'Priyashan Perera', phone: '0771234999' },
        device: { brand: 'Google', model: 'Pixel 6' },
        faultDescription: 'Rear glass shattered',
        estimateCents: 120_000,
        advanceCents: 40_000,
      });
      const tid = res.body.data._id;

      const cardRes = await api('get', `/api/repairs/${tid}/jobcard`, shop.token);
      expect(cardRes.status).toBe(200);
      const card = cardRes.body.data;

      expect(card.ticketNo).toMatch(/^JOB-\d{6}$/);
      expect(card.financials.estimateCents).toBe(120_000);
      expect(card.financials.advanceCents).toBe(40_000);
      expect(card.financials.remainingDueCents).toBe(80_000);
      expect(card.whatsappLink).toContain('https://wa.me/94771234999');
      expect(card.qrPayloadPlaceholder).toContain(`/status/${card.ticketNo}`);
    });
  });
});
