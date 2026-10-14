import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { startDb, stopDb, resetDb } from './helpers.js';
import { api, signup, addStaff, addBranch } from './api.js';
import { runWithContext, runAsPlatform } from '../src/core/tenantContext.js';
import RepairTicket from '../src/modules/repairs/models/RepairTicket.model.js';
import RepairSequence from '../src/modules/repairs/models/RepairSequence.model.js';
import LedgerEntry from '../src/modules/pos/models/LedgerEntry.model.js';
import Tenant from '../src/modules/tenants/Tenant.model.js';
import AuditLog from '../src/modules/audit/AuditLog.model.js';
import Branch from '../src/modules/branches/Branch.model.js';
import User from '../src/modules/users/User.model.js';
import * as notificationsService from '../src/modules/notifications/services/notifications.service.js';
import * as ledgerService from '../src/modules/pos/services/ledger.service.js';
import repairsService from '../src/modules/repairs/services/repairs.service.js';
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

async function advanceToReady(ticketId, token) {
  await api('post', `/api/repairs/${ticketId}/stage`, token).send({ to: 'Diagnosing' });
  await api('post', `/api/repairs/${ticketId}/stage`, token).send({ to: 'In repair', waiveApproval: true });
  await api('post', `/api/repairs/${ticketId}/stage`, token).send({ to: 'Quality check' });
  await api('post', `/api/repairs/${ticketId}/stage`, token).send({ to: 'Ready' });
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

      await advanceToReady(tid, shop.token);

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
      await advanceToReady(tid, shop.token);

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
      await advanceToReady(tid, shop.token);

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
      expect(card.qrPayloadPlaceholder).toBe(card.ticketNo);
    });
  });

  describe('Resilience, Idempotency, Reopen, and Security Isolation', () => {
    // 1.a: stage change still succeeds when notify() throws (mock it)
    it('stage change still succeeds when notify() throws (mock it)', async () => {
      const shop = await setupShop();
      const res = await api('post', '/api/repairs', shop.token).send({
        customer: { name: 'Sunil Silva', phone: '0771234111' },
        device: { brand: 'Samsung', model: 'A52' },
        faultDescription: 'Microphone muffled',
      });
      const tid = res.body.data._id;

      const spy = vi.spyOn(notificationsService, 'notify').mockRejectedValueOnce(new Error('SMS Gateway timeout'));

      const moveRes = await api('post', `/api/repairs/${tid}/stage`, shop.token).send({
        to: 'Diagnosing',
        note: 'Starting diagnostics despite SMS failure',
      });

      expect(moveRes.status).toBe(200);
      expect(moveRes.body.data.stage).toBe('Diagnosing');
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    // 1.b: invoice or advance journal failure rolls back the ticket update too (mock postJournal to throw, then check the ticket and ledger are unchanged)
    it('invoice journal failure rolls back ticket update and leaves ledger unchanged', async () => {
      const shop = await setupShop();
      const res = await api('post', '/api/repairs', shop.token).send({
        customer: { name: 'Nimal Bandara', phone: '0771234222' },
        device: { brand: 'Xiaomi', model: 'Redmi 9' },
        faultDescription: 'Charging issue',
      });
      const tid = res.body.data._id;
      await advanceToReady(tid, shop.token);

      const spy = vi.spyOn(ledgerService, 'postJournal').mockRejectedValueOnce(new Error('Ledger storage error'));

      const invRes = await api('post', `/api/repairs/${tid}/invoice`, shop.token).send({
        paymentMethod: 'cash',
        labourCents: 150_000,
      });

      expect(invRes.status).toBe(500);
      spy.mockRestore();

      // Check that ticket was rolled back: isInvoiceSettled is still false
      const ticketDoc = await runWithContext({ tenantId: shop.tenantId }, async () => {
        return await RepairTicket.findById(tid).lean();
      });
      expect(ticketDoc.isInvoiceSettled).toBe(false);
      expect(ticketDoc.invoiceId).toBeNull();
      expect(ticketDoc.history.some((h) => h.note?.includes('Invoice settled'))).toBe(false);

      // Check ledger has 0 entries
      const entries = await runWithContext({ tenantId: shop.tenantId }, async () => {
        return await LedgerEntry.find({ referenceId: ticketDoc.ticketNo }).lean();
      });
      expect(entries).toHaveLength(0);
    });

    it('advance journal failure rolls back ticket creation and leaves ledger unchanged', async () => {
      const shop = await setupShop();

      const spy = vi.spyOn(ledgerService, 'postJournal').mockRejectedValueOnce(new Error('Ledger failure'));

      const createRes = await api('post', '/api/repairs', shop.token).send({
        customer: { name: 'Anura Kumara', phone: '0771234333' },
        device: { brand: 'OnePlus', model: 'Nord' },
        faultDescription: 'Camera blurry',
        advanceCents: 50_000,
        advancePaymentMethod: 'cash',
      });

      expect(createRes.status).toBe(500);
      spy.mockRestore();

      // Check that no ticket was saved in DB
      const tickets = await runWithContext({ tenantId: shop.tenantId }, async () => {
        return await RepairTicket.find({ faultDescription: 'Camera blurry' }).lean();
      });
      expect(tickets).toHaveLength(0);

      // Check that no ledger entries were created
      const entries = await runWithContext({ tenantId: shop.tenantId }, async () => {
        return await LedgerEntry.find({}).lean();
      });
      expect(entries).toHaveLength(0);
    });

    // 1.c: invoicing the same ticket twice posts one journal only
    it('invoicing the same ticket twice posts one journal only', async () => {
      const shop = await setupShop();
      const res = await api('post', '/api/repairs', shop.token).send({
        customer: { name: 'Kasun Wickrama', phone: '0771234444' },
        device: { brand: 'Vivo', model: 'Y20' },
        faultDescription: 'Speaker distortion',
      });
      const tid = res.body.data._id;
      await advanceToReady(tid, shop.token);

      // First invoice succeeds
      const inv1 = await api('post', `/api/repairs/${tid}/invoice`, shop.token).send({
        paymentMethod: 'cash',
        labourCents: 60_000,
      });
      expect(inv1.status).toBe(200);
      expect(inv1.body.data.isInvoiceSettled).toBe(true);

      // Second invoice rejected with 400 ALREADY_INVOICED
      const inv2 = await api('post', `/api/repairs/${tid}/invoice`, shop.token).send({
        paymentMethod: 'cash',
        labourCents: 60_000,
      });
      expect(inv2.status).toBe(400);
      expect(inv2.body.code).toBe('ALREADY_INVOICED');

      // Check ledger journal entries: exactly 1 journal entry exists
      const entries = await runWithContext({ tenantId: shop.tenantId }, async () => {
        return await LedgerEntry.find({ referenceId: inv1.body.data.ticketNo, isVoided: false }).lean();
      });
      expect(entries).toHaveLength(1);
    });

    // 1.d: reopen from Delivered / Cancelled / Unrepairable: owner only, no notify(), invoice not re-posted, advance not refunded or kept a second time
    it('reopen from Delivered / Cancelled / Unrepairable: owner only, no notify(), invoice not re-posted, advance not refunded or kept a second time', async () => {
      const shop = await setupShop();
      const tech = await addStaff(shop, 'technician', 'tech_reopen@shop.lk');

      // --- Ticket 1: Reopen from Delivered ---
      const t1Res = await api('post', '/api/repairs', shop.token).send({
        customer: { name: 'Customer D1', phone: '0771234551' },
        device: { brand: 'Samsung', model: 'S20' },
        faultDescription: 'Screen crack',
      });
      const t1Id = t1Res.body.data._id;
      await api('post', `/api/repairs/${t1Id}/stage`, shop.token).send({ to: 'Diagnosing' });
      await api('post', `/api/repairs/${t1Id}/stage`, shop.token).send({ to: 'In repair', waiveApproval: true });
      await api('post', `/api/repairs/${t1Id}/stage`, shop.token).send({ to: 'Quality check' });
      await api('post', `/api/repairs/${t1Id}/stage`, shop.token).send({ to: 'Ready' });
      await api('post', `/api/repairs/${t1Id}/invoice`, shop.token).send({ paymentMethod: 'cash', labourCents: 100_000 });
      await api('post', `/api/repairs/${t1Id}/stage`, shop.token).send({ to: 'Delivered' });

      // Non-owner (technician with repairs.edit) cannot reopen Delivered
      const techReopen1 = await api('post', `/api/repairs/${t1Id}/stage`, tech.token).send({ to: 'Diagnosing' });
      expect(techReopen1.status).toBe(403);
      expect(techReopen1.body.code).toBe('OWNER_ONLY');

      // Owner reopens: no notify() called
      const notifySpy = vi.spyOn(notificationsService, 'notify');
      const ownerReopen1 = await api('post', `/api/repairs/${t1Id}/stage`, shop.token).send({ to: 'Diagnosing' });
      expect(ownerReopen1.status).toBe(200);
      expect(ownerReopen1.body.data.stage).toBe('Diagnosing');
      expect(notifySpy).not.toHaveBeenCalled();
      notifySpy.mockRestore();

      // Invoice cannot be re-posted on reopened ticket
      const reInvoice = await api('post', `/api/repairs/${t1Id}/invoice`, shop.token).send({ paymentMethod: 'cash', labourCents: 50_000 });
      expect(reInvoice.status).toBe(400);
      expect(reInvoice.body.code).toBe('ALREADY_INVOICED');

      // --- Ticket 2: Reopen from Cancelled (with advance) ---
      const t2Res = await api('post', '/api/repairs', shop.token).send({
        customer: { name: 'Customer D2', phone: '0771234552' },
        device: { brand: 'Xiaomi', model: 'Mi 11' },
        faultDescription: 'Water damage',
        advanceCents: 80_000,
        advancePaymentMethod: 'cash',
      });
      const t2Id = t2Res.body.data._id;
      await api('post', `/api/repairs/${t2Id}/stage`, shop.token).send({
        to: 'Cancelled',
        note: 'Customer changed mind',
        advanceDecision: 'refund',
      });

      const entriesAfterCancel = await runWithContext({ tenantId: shop.tenantId }, async () => {
        return await LedgerEntry.find({ referenceId: t2Res.body.data.ticketNo, isVoided: false }).lean();
      });
      expect(entriesAfterCancel).toHaveLength(2);

      // Non-owner cannot reopen
      const techReopen2 = await api('post', `/api/repairs/${t2Id}/stage`, tech.token).send({ to: 'Diagnosing' });
      expect(techReopen2.status).toBe(403);
      expect(techReopen2.body.code).toBe('OWNER_ONLY');

      // Owner reopens
      const ownerReopen2 = await api('post', `/api/repairs/${t2Id}/stage`, shop.token).send({ to: 'Diagnosing' });
      expect(ownerReopen2.status).toBe(200);

      // Move to Cancelled again: advance is already settled, so does NOT refund or keep second time
      await api('post', `/api/repairs/${t2Id}/stage`, shop.token).send({
        to: 'Cancelled',
        note: 'Cancelled again after reopen',
      });
      const entriesAfterSecondCancel = await runWithContext({ tenantId: shop.tenantId }, async () => {
        return await LedgerEntry.find({ referenceId: t2Res.body.data.ticketNo, isVoided: false }).lean();
      });
      expect(entriesAfterSecondCancel).toHaveLength(entriesAfterCancel.length);

      // --- Ticket 3: Reopen from Unrepairable ---
      const t3Res = await api('post', '/api/repairs', shop.token).send({
        customer: { name: 'Customer D3', phone: '0771234553' },
        device: { brand: 'Oppo', model: 'Reno 5' },
        faultDescription: 'Dead motherboard',
        advanceCents: 60_000,
        advancePaymentMethod: 'cash',
      });
      const t3Id = t3Res.body.data._id;
      await api('post', `/api/repairs/${t3Id}/stage`, shop.token).send({ to: 'Diagnosing' });
      await api('post', `/api/repairs/${t3Id}/stage`, shop.token).send({
        to: 'Unrepairable',
        note: 'Board unrepairable',
        advanceDecision: 'keep_fee',
        feeCents: 20_000,
      });

      const entriesAfterUnrep = await runWithContext({ tenantId: shop.tenantId }, async () => {
        return await LedgerEntry.find({ referenceId: t3Res.body.data.ticketNo, isVoided: false }).lean();
      });
      expect(entriesAfterUnrep).toHaveLength(2);

      // Non-owner cannot reopen
      const techReopen3 = await api('post', `/api/repairs/${t3Id}/stage`, tech.token).send({ to: 'Diagnosing' });
      expect(techReopen3.status).toBe(403);
      expect(techReopen3.body.code).toBe('OWNER_ONLY');

      // Owner reopens
      const ownerReopen3 = await api('post', `/api/repairs/${t3Id}/stage`, shop.token).send({ to: 'Diagnosing' });
      expect(ownerReopen3.status).toBe(200);

      // Advance not refunded or kept second time
      const entriesAfterReopenUnrep = await runWithContext({ tenantId: shop.tenantId }, async () => {
        return await LedgerEntry.find({ referenceId: t3Res.body.data.ticketNo, isVoided: false }).lean();
      });
      expect(entriesAfterReopenUnrep).toHaveLength(entriesAfterUnrep.length);
    });

    // 1.e: cancel from In repair, Quality check and Ready needs repairs.approve or owner, a note, and advanceDecision when advance > 0
    it('cancel from In repair, Quality check and Ready needs repairs.approve or owner, a note, and advanceDecision when advance > 0', async () => {
      const shop = await setupShop();
      const tech = await addStaff(shop, 'technician', 'tech_cancel@shop.lk');

      async function setupTicketAtStage(targetStage) {
        const createRes = await api('post', '/api/repairs', shop.token).send({
          customer: { name: 'Customer E', phone: '0771234661' },
          device: { brand: 'Apple', model: 'iPhone 11' },
          faultDescription: 'Speaker repair',
          advanceCents: 50_000,
          advancePaymentMethod: 'cash',
        });
        const tid = createRes.body.data._id;
        await api('post', `/api/repairs/${tid}/stage`, shop.token).send({ to: 'Diagnosing' });
        await api('post', `/api/repairs/${tid}/stage`, shop.token).send({ to: 'In repair', waiveApproval: true });
        if (targetStage === 'Quality check' || targetStage === 'Ready') {
          await api('post', `/api/repairs/${tid}/stage`, shop.token).send({ to: 'Quality check' });
        }
        if (targetStage === 'Ready') {
          await api('post', `/api/repairs/${tid}/stage`, shop.token).send({ to: 'Ready' });
        }
        return tid;
      }

      for (const stg of ['In repair', 'Quality check', 'Ready']) {
        // Test 1: Non-approver technician (has edit but not approve) blocked with 403 APPROVAL_REQUIRED
        const tid1 = await setupTicketAtStage(stg);
        const nonApproveRes = await api('post', `/api/repairs/${tid1}/stage`, tech.token).send({
          to: 'Cancelled',
          note: 'Customer wants to cancel',
          advanceDecision: 'refund',
        });
        expect(nonApproveRes.status).toBe(403);
        expect(nonApproveRes.body.code).toBe('APPROVAL_REQUIRED');

        // Test 2: Missing note blocked with 400
        const tid2 = await setupTicketAtStage(stg);
        const noNoteRes = await api('post', `/api/repairs/${tid2}/stage`, shop.token).send({
          to: 'Cancelled',
          note: '',
          advanceDecision: 'refund',
        });
        expect(noNoteRes.status).toBe(400);
        expect(noNoteRes.body.code).toBe('NOTE_REQUIRED');

        // Test 3: Missing advanceDecision when advance > 0 blocked with 400
        const tid3 = await setupTicketAtStage(stg);
        const noAdvDecisionRes = await api('post', `/api/repairs/${tid3}/stage`, shop.token).send({
          to: 'Cancelled',
          note: 'Valid cancellation note',
        });
        expect(noAdvDecisionRes.status).toBe(400);
        expect(noAdvDecisionRes.body.code).toBe('ADVANCE_DECISION_REQUIRED');

        // Test 4: Authorized owner with note and advanceDecision succeeds
        const tid4 = await setupTicketAtStage(stg);
        const okRes = await api('post', `/api/repairs/${tid4}/stage`, shop.token).send({
          to: 'Cancelled',
          note: 'Valid cancellation note by owner',
          advanceDecision: 'refund',
        });
        expect(okRes.status).toBe(200);
        expect(okRes.body.data.stage).toBe('Cancelled');
      }
    });

    // 1.f: cross-tenant ticket id returns 404 over HTTP for GET, PUT, stage, assign, parts, invoice
    it('cross-tenant ticket id returns 404 over HTTP for GET, PUT, stage, assign, parts, invoice', async () => {
      const shopA = await setupShop('shopA@cellivo.lk', 'Shop A');
      const shopB = await setupShop('shopB@cellivo.lk', 'Shop B');

      // Create ticket in Shop A
      const created = await api('post', '/api/repairs', shopA.token).send({
        customer: { name: 'Customer A', phone: '0771111111' },
        device: { brand: 'Apple', model: 'iPhone 12' },
        faultDescription: 'Screen issue',
      });
      const ticketIdA = created.body.data._id;

      // 1. GET /api/repairs/:id
      const getRes = await api('get', `/api/repairs/${ticketIdA}`, shopB.token);
      expect(getRes.status).toBe(404);

      // 2. PUT /api/repairs/:id
      const putRes = await api('put', `/api/repairs/${ticketIdA}`, shopB.token).send({
        conditionNotes: 'Cross tenant tampering',
      });
      expect(putRes.status).toBe(404);

      // 3. POST /api/repairs/:id/stage
      const stageRes = await api('post', `/api/repairs/${ticketIdA}/stage`, shopB.token).send({
        to: 'Diagnosing',
      });
      expect(stageRes.status).toBe(404);

      // 4. POST /api/repairs/:id/assign
      const assignRes = await api('post', `/api/repairs/${ticketIdA}/assign`, shopB.token).send({
        technicianId: shopB.tenantId,
      });
      expect(assignRes.status).toBe(404);

      // 5. POST /api/repairs/:id/parts
      const partsRes = await api('post', `/api/repairs/${ticketIdA}/parts`, shopB.token).send({
        name: 'Screen Part',
        qty: 1,
        unitPriceCents: 150_000,
      });
      expect(partsRes.status).toBe(404);

      // 6. POST /api/repairs/:id/invoice
      const invRes = await api('post', `/api/repairs/${ticketIdA}/invoice`, shopB.token).send({
        paymentMethod: 'cash',
        labourCents: 50_000,
      });
      expect(invRes.status).toBe(404);
    });

    // 1.g: assign: technician must belong to same tenant and branch; workload endpoint counts
    it('assign: technician must belong to same tenant and branch; workload endpoint counts', async () => {
      const shopA = await setupShop('shopTechA@cellivo.lk', 'Shop A');
      const shopB = await setupShop('shopTechB@cellivo.lk', 'Shop B');

      // Create a second branch in shopA
      const branchA2 = await addBranch(shopA.tenantId, { name: 'Shop A Branch 2', invoicePrefix: 'B2' });

      // Staff users:
      // techA1: assigned to mainBranch
      const techA1 = await addStaff(shopA, 'technician', 'techA1@shop.lk');
      // techA2: assigned only to branchA2
      const techA2 = await addStaff(shopA, 'technician', 'techA2@shop.lk');
      await runAsPlatform(async () => {
        await User.findByIdAndUpdate(techA2.user._id, { branchIds: [branchA2._id] });
      });
      // techB: belongs to shopB
      const techB = await addStaff(shopB, 'technician', 'techB@shop.lk');

      // Create ticket on shopA mainBranch
      const res = await api('post', '/api/repairs', shopA.token).send({
        customer: { name: 'Customer Tech', phone: '0771234771' },
        device: { brand: 'Samsung', model: 'Galaxy S21' },
        faultDescription: 'No power',
      });
      const tid = res.body.data._id;

      // 1. Assign techB (cross tenant) -> 400 INVALID_TECHNICIAN
      const crossTenantAssign = await api('post', `/api/repairs/${tid}/assign`, shopA.token).send({
        technicianId: techB.user._id,
      });
      expect(crossTenantAssign.status).toBe(400);
      expect(crossTenantAssign.body.code).toBe('INVALID_TECHNICIAN');

      // 2. Assign techA2 (same tenant, different branch) -> 400 INVALID_TECHNICIAN
      const diffBranchAssign = await api('post', `/api/repairs/${tid}/assign`, shopA.token).send({
        technicianId: techA2.user._id,
      });
      expect(diffBranchAssign.status).toBe(400);
      expect(diffBranchAssign.body.code).toBe('INVALID_TECHNICIAN');

      // 3. Assign techA1 (same tenant and branch) -> 200 OK
      const sameBranchAssign = await api('post', `/api/repairs/${tid}/assign`, shopA.token).send({
        technicianId: techA1.user._id,
      });
      expect(sameBranchAssign.status).toBe(200);
      expect(sameBranchAssign.body.data.technicianId).toBe(String(techA1.user._id));

      // 4. Workload endpoint counts active tickets
      const workloadRes = await api('get', `/api/repairs/technicians/workload?branchId=${shopA.branchId}`, shopA.token);
      expect(workloadRes.status).toBe(200);
      const tech1Workload = workloadRes.body.data.find((w) => String(w._id) === String(techA1.user._id));
      expect(tech1Workload).toBeDefined();
      expect(tech1Workload.activeTicketsCount).toBe(1);
    });

    // 1.h: checkWarrantyExpiry(tenantId) finds only tickets expiring within the window
    it('checkWarrantyExpiry(tenantId) finds only tickets expiring within the window', async () => {
      const shop = await setupShop();

      const baseDate = new Date();

      // 1. Ticket expiring in 12 hours (within 24h window)
      const tExpiring = await api('post', '/api/repairs', shop.token).send({
        customer: { name: 'Customer Expiring', phone: '0771234881' },
        device: { brand: 'Google', model: 'Pixel 5' },
        faultDescription: 'Battery replacement',
      });
      const tExpiringId = tExpiring.body.data._id;
      await runWithContext({ tenantId: shop.tenantId }, async () => {
        await RepairTicket.findByIdAndUpdate(tExpiringId, {
          warrantyDays: 30,
          warrantyExpiresAt: new Date(baseDate.getTime() + 12 * 60 * 60 * 1000),
        });
      });

      // 2. Ticket expiring in 48 hours (outside 24h window)
      const tFuture = await api('post', '/api/repairs', shop.token).send({
        customer: { name: 'Customer Future', phone: '0771234882' },
        device: { brand: 'Google', model: 'Pixel 6' },
        faultDescription: 'Screen replacement',
      });
      const tFutureId = tFuture.body.data._id;
      await runWithContext({ tenantId: shop.tenantId }, async () => {
        await RepairTicket.findByIdAndUpdate(tFutureId, {
          warrantyDays: 30,
          warrantyExpiresAt: new Date(baseDate.getTime() + 48 * 60 * 60 * 1000),
        });
      });

      // 3. Ticket already expired yesterday (in the past)
      const tPast = await api('post', '/api/repairs', shop.token).send({
        customer: { name: 'Customer Past', phone: '0771234883' },
        device: { brand: 'Google', model: 'Pixel 4' },
        faultDescription: 'Port replacement',
      });
      const tPastId = tPast.body.data._id;
      await runWithContext({ tenantId: shop.tenantId }, async () => {
        await RepairTicket.findByIdAndUpdate(tPastId, {
          warrantyDays: 30,
          warrantyExpiresAt: new Date(baseDate.getTime() - 24 * 60 * 60 * 1000),
        });
      });

      // 4. Ticket with no warranty
      await api('post', '/api/repairs', shop.token).send({
        customer: { name: 'Customer No Warranty', phone: '0771234884' },
        device: { brand: 'Google', model: 'Pixel 3' },
        faultDescription: 'Inspection only',
      });

      // Call checkWarrantyExpiry
      const results = await repairsService.checkWarrantyExpiry(shop.tenantId);
      expect(results).toHaveLength(1);
      expect(results[0].ticketNo).toBe(tExpiring.body.data.ticketNo);
      expect(results[0].sent).toBe(true);
    });
  });

  describe('Review Fixes (Ledger, Stage, Warranty, and Invoicing)', () => {
    // Item 1: settleInvoice: held advance = ticket.advanceSettled ? 0 : ticket.advanceCents
    it('Item 1: cancel with refund -> reopen -> move to Ready -> invoice; journal has no 2020 debit for old advance and is balanced; 2020 nets to zero', async () => {
      const shop = await setupShop();

      // Intake with advance Rs 1,000 (100,000 cents) cash
      const res = await api('post', '/api/repairs', shop.token).send({
        customer: { name: 'Reopen Invoicing Customer', phone: '0779990001' },
        device: { brand: 'Samsung', model: 'A52' },
        faultDescription: 'Screen issue',
        advanceCents: 100_000,
        advancePaymentMethod: 'cash',
      });
      const tid = res.body.data._id;
      const tNo = res.body.data.ticketNo;

      // Cancel with refund
      const cancelRes = await api('post', `/api/repairs/${tid}/stage`, shop.token).send({
        to: 'Cancelled',
        note: 'Customer changed mind',
        advanceDecision: 'refund',
      });
      expect(cancelRes.status).toBe(200);
      expect(cancelRes.body.data.advanceSettled).toBe(true);

      // Reopen to Diagnosing by owner
      const reopenRes = await api('post', `/api/repairs/${tid}/stage`, shop.token).send({
        to: 'Diagnosing',
        note: 'Customer returned to proceed',
      });
      expect(reopenRes.status).toBe(200);
      expect(reopenRes.body.data.stage).toBe('Diagnosing');

      // Move to Ready
      await api('post', `/api/repairs/${tid}/stage`, shop.token).send({ to: 'In repair', waiveApproval: true });
      await api('post', `/api/repairs/${tid}/stage`, shop.token).send({ to: 'Quality check' });
      await api('post', `/api/repairs/${tid}/stage`, shop.token).send({ to: 'Ready' });

      // Invoice for Rs 1,500 labour (150,000 cents) cash
      const invRes = await api('post', `/api/repairs/${tid}/invoice`, shop.token).send({
        paymentMethod: 'cash',
        labourCents: 150_000,
      });
      expect(invRes.status).toBe(200);
      expect(invRes.body.data.isInvoiceSettled).toBe(true);

      // Check all ledger entries for this ticket
      const entries = await runWithContext({ tenantId: shop.tenantId }, async () => {
        return await LedgerEntry.find({ referenceId: tNo, isVoided: false }).lean();
      });
      // 1. Advance intake, 2. Cancel refund, 3. Final invoice
      expect(entries).toHaveLength(3);

      const invEntry = entries.find((e) => e.description.includes('invoice'));
      expect(invEntry).toBeDefined();

      // Assert the invoice journal has NO 2020 debit for the old advance
      const inv2020Debit = invEntry.lines.find((l) => l.accountCode === '2020');
      expect(inv2020Debit).toBeUndefined();

      // Assert invoice entry is balanced: Dr 1010 (150k), Cr 4020 (150k)
      const debit1010 = invEntry.lines.find((l) => l.accountCode === '1010');
      const credit4020 = invEntry.lines.find((l) => l.accountCode === '4020');
      expect(debit1010.debit).toBe(150_000);
      expect(credit4020.credit).toBe(150_000);

      // Assert account 2020 nets to zero across all entries for this ticket
      let total2020Debit = 0;
      let total2020Credit = 0;
      for (const entry of entries) {
        for (const line of entry.lines) {
          if (line.accountCode === '2020') {
            total2020Debit += line.debit || 0;
            total2020Credit += line.credit || 0;
          }
        }
      }
      expect(total2020Debit).toBe(100_000);
      expect(total2020Credit).toBe(100_000);
      expect(total2020Debit - total2020Credit).toBe(0); // 2020 nets to zero!
    });

    // Item 2: settleInvoice only when stage === 'Ready' (400 INVOICE_STAGE_INVALID otherwise)
    it('Item 2: settleInvoice only when stage === Ready (400 INVOICE_STAGE_INVALID otherwise)', async () => {
      const shop = await setupShop();

      const res = await api('post', '/api/repairs', shop.token).send({
        customer: { name: 'Stage Invoicing Customer', phone: '0779990002' },
        device: { brand: 'Xiaomi', model: '11T' },
        faultDescription: 'Battery swap',
      });
      const tid = res.body.data._id;

      // In Received stage -> 400 INVOICE_STAGE_INVALID
      const invReceived = await api('post', `/api/repairs/${tid}/invoice`, shop.token).send({
        paymentMethod: 'cash',
        labourCents: 50_000,
      });
      expect(invReceived.status).toBe(400);
      expect(invReceived.body.code).toBe('INVOICE_STAGE_INVALID');

      // Move to Diagnosing -> 400 INVOICE_STAGE_INVALID
      await api('post', `/api/repairs/${tid}/stage`, shop.token).send({ to: 'Diagnosing' });
      const invDiag = await api('post', `/api/repairs/${tid}/invoice`, shop.token).send({
        paymentMethod: 'cash',
        labourCents: 50_000,
      });
      expect(invDiag.status).toBe(400);
      expect(invDiag.body.code).toBe('INVOICE_STAGE_INVALID');

      // Move to In repair -> 400 INVOICE_STAGE_INVALID
      await api('post', `/api/repairs/${tid}/stage`, shop.token).send({ to: 'In repair', waiveApproval: true });
      const invInRepair = await api('post', `/api/repairs/${tid}/invoice`, shop.token).send({
        paymentMethod: 'cash',
        labourCents: 50_000,
      });
      expect(invInRepair.status).toBe(400);
      expect(invInRepair.body.code).toBe('INVOICE_STAGE_INVALID');

      // Move to Quality check -> 400 INVOICE_STAGE_INVALID
      await api('post', `/api/repairs/${tid}/stage`, shop.token).send({ to: 'Quality check' });
      const invQC = await api('post', `/api/repairs/${tid}/invoice`, shop.token).send({
        paymentMethod: 'cash',
        labourCents: 50_000,
      });
      expect(invQC.status).toBe(400);
      expect(invQC.body.code).toBe('INVOICE_STAGE_INVALID');

      // Move to Ready -> 200 OK
      await api('post', `/api/repairs/${tid}/stage`, shop.token).send({ to: 'Ready' });
      const invReady = await api('post', `/api/repairs/${tid}/invoice`, shop.token).send({
        paymentMethod: 'cash',
        labourCents: 50_000,
      });
      expect(invReady.status).toBe(200);
      expect(invReady.body.data.isInvoiceSettled).toBe(true);
    });

    // Item 3: changeStage to Cancelled when ticket.isInvoiceSettled -> 400 INVOICE_SETTLED
    it('Item 3: changeStage to Cancelled when ticket.isInvoiceSettled -> 400 INVOICE_SETTLED', async () => {
      const shop = await setupShop();

      const res = await api('post', '/api/repairs', shop.token).send({
        customer: { name: 'Cancel Invoiced Customer', phone: '0779990003' },
        device: { brand: 'OnePlus', model: '9 Pro' },
        faultDescription: 'Camera repair',
      });
      const tid = res.body.data._id;

      await advanceToReady(tid, shop.token);

      const inv = await api('post', `/api/repairs/${tid}/invoice`, shop.token).send({
        paymentMethod: 'cash',
        labourCents: 80_000,
      });
      expect(inv.status).toBe(200);

      // Attempt to cancel an already-invoiced ticket
      const cancelRes = await api('post', `/api/repairs/${tid}/stage`, shop.token).send({
        to: 'Cancelled',
        note: 'Customer wants to cancel after invoice',
      });
      expect(cancelRes.status).toBe(400);
      expect(cancelRes.body.code).toBe('INVOICE_SETTLED');
    });

    // Item 4: addPart, removePart, recordApproval: reject (400) when ticket.isInvoiceSettled or stage is Delivered / Unrepairable / Cancelled. recordApproval must not overwrite a waived approval.
    it('Item 4: addPart, removePart, recordApproval: reject (400) when ticket.isInvoiceSettled or terminal; recordApproval cannot overwrite waived approval', async () => {
      const shop = await setupShop();

      // Case 4A: isInvoiceSettled rejects addPart and recordApproval
      const resA = await api('post', '/api/repairs', shop.token).send({
        customer: { name: 'Test Invoiced Parts', phone: '0779990004' },
        device: { brand: 'Apple', model: 'iPhone 12' },
        faultDescription: 'Speaker replacement',
      });
      const tidA = resA.body.data._id;
      await advanceToReady(tidA, shop.token);
      await api('post', `/api/repairs/${tidA}/invoice`, shop.token).send({
        paymentMethod: 'cash',
        labourCents: 50_000,
      });

      const addPartInv = await api('post', `/api/repairs/${tidA}/parts`, shop.token).send({
        name: 'Ear Speaker',
        qty: 1,
        unitPriceCents: 30_000,
        unitCostCents: 15_000,
      });
      expect(addPartInv.status).toBe(400);
      expect(addPartInv.body.code).toBe('INVOICE_SETTLED');

      const approvalInv = await api('post', `/api/repairs/${tidA}/approval`, shop.token).send({
        decision: 'approved',
      });
      expect(approvalInv.status).toBe(400);
      expect(approvalInv.body.code).toBe('INVOICE_SETTLED');

      // Case 4B: Terminal stage Delivered rejects addPart
      await api('post', `/api/repairs/${tidA}/stage`, shop.token).send({ to: 'Delivered' });
      const addPartDelivered = await api('post', `/api/repairs/${tidA}/parts`, shop.token).send({
        name: 'Ear Speaker',
        qty: 1,
        unitPriceCents: 30_000,
        unitCostCents: 15_000,
      });
      expect(addPartDelivered.status).toBe(400);

      // Case 4C: Terminal stage Cancelled rejects addPart, removePart, recordApproval
      const resC = await api('post', '/api/repairs', shop.token).send({
        customer: { name: 'Cancelled Ticket', phone: '0779990005' },
        device: { brand: 'Samsung', model: 'S10' },
        faultDescription: 'No power',
      });
      const tidC = resC.body.data._id;
      await api('post', `/api/repairs/${tidC}/parts`, shop.token).send({
        name: 'IC Chip',
        qty: 1,
        unitPriceCents: 20_000,
        unitCostCents: 10_000,
      });
      const partId = (await api('get', `/api/repairs/${tidC}`, shop.token)).body.data.parts[0]._id;

      await api('post', `/api/repairs/${tidC}/stage`, shop.token).send({
        to: 'Cancelled',
        note: 'Customer cancelled early',
      });

      const addPartCancel = await api('post', `/api/repairs/${tidC}/parts`, shop.token).send({
        name: 'Another Part',
        qty: 1,
        unitPriceCents: 10_000,
        unitCostCents: 5_000,
      });
      expect(addPartCancel.status).toBe(400);
      expect(addPartCancel.body.code).toBe('TERMINAL_STAGE');

      const removePartCancel = await api('delete', `/api/repairs/${tidC}/parts/${partId}`, shop.token);
      expect(removePartCancel.status).toBe(400);
      expect(removePartCancel.body.code).toBe('TERMINAL_STAGE');

      const approvalCancel = await api('post', `/api/repairs/${tidC}/approval`, shop.token).send({
        decision: 'approved',
      });
      expect(approvalCancel.status).toBe(400);
      expect(approvalCancel.body.code).toBe('TERMINAL_STAGE');

      // Case 4D: recordApproval must not overwrite a waived approval
      const resD = await api('post', '/api/repairs', shop.token).send({
        customer: { name: 'Waived Approval Ticket', phone: '0779990006' },
        device: { brand: 'Motorola', model: 'Edge' },
        faultDescription: 'Broken back glass',
      });
      const tidD = resD.body.data._id;
      await api('post', `/api/repairs/${tidD}/stage`, shop.token).send({ to: 'Diagnosing' });
      await api('post', `/api/repairs/${tidD}/stage`, shop.token).send({ to: 'In repair', waiveApproval: true });

      const overwriteApproval = await api('post', `/api/repairs/${tidD}/approval`, shop.token).send({
        decision: 'approved',
      });
      expect(overwriteApproval.status).toBe(400);
      expect(overwriteApproval.body.code).toBe('APPROVAL_ALREADY_WAIVED');
    });

    // Item 7: postAdvanceCancellation: default paymentMethod to ticket.advancePaymentMethod
    it('Item 7: postAdvanceCancellation defaults paymentMethod to ticket.advancePaymentMethod', async () => {
      const shop = await setupShop();

      // Intake with card advance Rs 800 (80,000 cents)
      const res = await api('post', '/api/repairs', shop.token).send({
        customer: { name: 'Card Advance Customer', phone: '0779990007' },
        device: { brand: 'Google', model: 'Pixel 5' },
        faultDescription: 'Battery drain',
        advanceCents: 80_000,
        advancePaymentMethod: 'card',
      });
      const tid = res.body.data._id;
      const tNo = res.body.data.ticketNo;

      // Cancel ticket without passing paymentMethod in request body
      const cancelRes = await api('post', `/api/repairs/${tid}/stage`, shop.token).send({
        to: 'Cancelled',
        note: 'Customer wants card refund',
        advanceDecision: 'refund',
      });
      expect(cancelRes.status).toBe(200);

      // Verify that the cancellation ledger refund credited card account 1020 (not cash 1010)
      const entries = await runWithContext({ tenantId: shop.tenantId }, async () => {
        return await LedgerEntry.find({ referenceId: tNo, isVoided: false }).lean();
      });
      expect(entries).toHaveLength(2);

      const refundEntry = entries.find((e) => e.description.includes('refund'));
      expect(refundEntry).toBeDefined();

      // Dr 2020 (80k), Cr 1020 (80k card account)
      const debit2020 = refundEntry.lines.find((l) => l.accountCode === '2020');
      const credit1020 = refundEntry.lines.find((l) => l.accountCode === '1020');
      expect(debit2020).toBeDefined();
      expect(debit2020.debit).toBe(80_000);
      expect(credit1020).toBeDefined();
      expect(credit1020.credit).toBe(80_000);
    });

    // Item 8: Warranty: store deliveredAt when a ticket reaches Delivered. warrantyExpiresAt = deliveredAt + warrantyDays (set it when delivered if warrantyDays already exists, or when warranty is set after delivery). Before delivery, store only warrantyDays.
    it('Item 8: Warranty sets deliveredAt upon delivery; warrantyExpiresAt calculated on delivery or when set post-delivery', async () => {
      const shop = await setupShop();

      // Case 8A: warrantyDays set before delivery
      const resA = await api('post', '/api/repairs', shop.token).send({
        customer: { name: 'Warranty Pre-Delivery', phone: '0779990008' },
        device: { brand: 'Apple', model: 'iPhone 11' },
        faultDescription: 'Battery replacement',
      });
      const tidA = resA.body.data._id;

      // Set warranty to 30 days before delivery
      const setW = await api('post', `/api/repairs/${tidA}/warranty`, shop.token).send({ days: 30 });
      expect(setW.status).toBe(200);
      expect(setW.body.data.warrantyDays).toBe(30);
      expect(setW.body.data.warrantyExpiresAt).toBeNull();
      expect(setW.body.data.deliveredAt).toBeNull();

      // Advance to Ready, invoice, and deliver
      await advanceToReady(tidA, shop.token);
      await api('post', `/api/repairs/${tidA}/invoice`, shop.token).send({ paymentMethod: 'cash', labourCents: 50_000 });
      const delivResA = await api('post', `/api/repairs/${tidA}/stage`, shop.token).send({ to: 'Delivered' });
      expect(delivResA.status).toBe(200);
      expect(delivResA.body.data.deliveredAt).toBeTruthy();
      expect(delivResA.body.data.warrantyExpiresAt).toBeTruthy();

      const deliveredAtA = new Date(delivResA.body.data.deliveredAt);
      const expiresAtA = new Date(delivResA.body.data.warrantyExpiresAt);
      const diffDaysA = Math.round((expiresAtA.getTime() - deliveredAtA.getTime()) / (24 * 60 * 60 * 1000));
      expect(diffDaysA).toBe(30);

      // Case 8B: warrantyDays set after delivery
      const resB = await api('post', '/api/repairs', shop.token).send({
        customer: { name: 'Warranty Post-Delivery', phone: '0779990009' },
        device: { brand: 'Apple', model: 'iPhone XR' },
        faultDescription: 'Screen replacement',
      });
      const tidB = resB.body.data._id;
      await advanceToReady(tidB, shop.token);
      await api('post', `/api/repairs/${tidB}/invoice`, shop.token).send({ paymentMethod: 'cash', labourCents: 60_000 });
      const delivResB = await api('post', `/api/repairs/${tidB}/stage`, shop.token).send({ to: 'Delivered' });
      expect(delivResB.status).toBe(200);
      expect(delivResB.body.data.deliveredAt).toBeTruthy();
      expect(delivResB.body.data.warrantyExpiresAt).toBeNull();

      // Set warranty to 60 days after delivery
      const setWPost = await api('post', `/api/repairs/${tidB}/warranty`, shop.token).send({ days: 60 });
      expect(setWPost.status).toBe(200);
      expect(setWPost.body.data.warrantyDays).toBe(60);
      expect(setWPost.body.data.warrantyExpiresAt).toBeTruthy();

      const deliveredAtB = new Date(delivResB.body.data.deliveredAt);
      const expiresAtB = new Date(setWPost.body.data.warrantyExpiresAt);
      const diffDaysB = Math.round((expiresAtB.getTime() - deliveredAtB.getTime()) / (24 * 60 * 60 * 1000));
      expect(diffDaysB).toBe(60);
    });

    // Item 9: checkWarrantyExpiry: add warrantyAlertSentAt on the ticket, skip tickets already alerted, set it only after notify() succeeds. Test that two runs send one alert.
    it('Item 9: checkWarrantyExpiry sets warrantyAlertSentAt after notify() succeeds and two runs send one alert', async () => {
      const shop = await setupShop();
      const baseDate = new Date();

      const tRes = await api('post', '/api/repairs', shop.token).send({
        customer: { name: 'Expiry Alert Test Customer', phone: '0779990010' },
        device: { brand: 'OnePlus', model: '8T' },
        faultDescription: 'Display swap',
      });
      const tid = tRes.body.data._id;

      await runWithContext({ tenantId: shop.tenantId }, async () => {
        await RepairTicket.findByIdAndUpdate(tid, {
          deliveredAt: baseDate,
          warrantyDays: 90,
          warrantyExpiresAt: new Date(baseDate.getTime() + 10 * 60 * 60 * 1000), // in 10 hours (within 24h)
          warrantyAlertSentAt: null,
        });
      });

      // Run 1: Sends alert and sets warrantyAlertSentAt
      const run1 = await repairsService.checkWarrantyExpiry(shop.tenantId);
      expect(run1).toHaveLength(1);
      expect(run1[0].ticketNo).toBe(tRes.body.data.ticketNo);
      expect(run1[0].sent).toBe(true);

      const ticketAfterRun1 = await runWithContext({ tenantId: shop.tenantId }, async () => {
        return await RepairTicket.findById(tid).lean();
      });
      expect(ticketAfterRun1.warrantyAlertSentAt).toBeTruthy();

      // Run 2: Ticket already alerted, so it must be skipped
      const run2 = await repairsService.checkWarrantyExpiry(shop.tenantId);
      expect(run2).toHaveLength(0);
    });

    // Requirement: POST /:id/invoice requires repairs.approve
    it('restricts invoice endpoint to repairs.approve (403 for technician without repairs.approve)', async () => {
      const shop = await setupShop();
      const tech = await addStaff(shop, 'technician', 'tech_invoice_test@shop.lk');

      const res = await api('post', '/api/repairs', shop.token).send({
        customer: { name: 'Approver Test Customer', phone: '0779990011' },
        device: { brand: 'Apple', model: 'iPhone 13' },
        faultDescription: 'Screen issue',
      });
      const tid = res.body.data._id;
      await advanceToReady(tid, shop.token);

      // Technician lacks repairs.approve -> 403
      const techInv = await api('post', `/api/repairs/${tid}/invoice`, tech.token).send({
        paymentMethod: 'cash',
        labourCents: 50_000,
      });
      expect(techInv.status).toBe(403);

      // Owner has repairs.approve -> 200
      const ownerInv = await api('post', `/api/repairs/${tid}/invoice`, shop.token).send({
        paymentMethod: 'cash',
        labourCents: 50_000,
      });
      expect(ownerInv.status).toBe(200);
    });

    // Requirement: stock.adapter.js reservePart reject (400) instead of coercing.
    // qty integer 1..1000; unitCostCents/unitPriceCents integer 0..100000000; part name max 100 chars; max 50 parts per ticket.
    it('rejects negative qty, fractional qty, negative price, and the 51st part', async () => {
      const shop = await setupShop();

      const res = await api('post', '/api/repairs', shop.token).send({
        customer: { name: 'Part Validation Customer', phone: '0779990012' },
        device: { brand: 'Samsung', model: 'S22' },
        faultDescription: 'Validation test',
      });
      const tid = res.body.data._id;

      // Negative qty
      const negQty = await api('post', `/api/repairs/${tid}/parts`, shop.token).send({
        name: 'Valid Part Name',
        qty: -1,
        unitPriceCents: 1000,
        unitCostCents: 500,
      });
      expect(negQty.status).toBe(400);

      // Fractional qty
      const fracQty = await api('post', `/api/repairs/${tid}/parts`, shop.token).send({
        name: 'Valid Part Name',
        qty: 1.5,
        unitPriceCents: 1000,
        unitCostCents: 500,
      });
      expect(fracQty.status).toBe(400);

      // Negative price
      const negPrice = await api('post', `/api/repairs/${tid}/parts`, shop.token).send({
        name: 'Valid Part Name',
        qty: 1,
        unitPriceCents: -500,
        unitCostCents: 500,
      });
      expect(negPrice.status).toBe(400);

      // Part name > 100 chars
      const longName = await api('post', `/api/repairs/${tid}/parts`, shop.token).send({
        name: 'A'.repeat(101),
        qty: 1,
        unitPriceCents: 1000,
        unitCostCents: 500,
      });
      expect(longName.status).toBe(400);

      // Add 50 parts directly to ticket
      await runWithContext({ tenantId: shop.tenantId }, async () => {
        const ticket = await RepairTicket.findById(tid);
        ticket.parts = [];
        for (let i = 0; i < 50; i++) {
          ticket.parts.push({
            name: `Part ${i + 1}`,
            qty: 1,
            unitCostCents: 100,
            unitPriceCents: 200,
            addedAt: new Date(),
          });
        }
        await ticket.save();
      });

      // 51st part must be rejected with 400
      const fiftyFirst = await api('post', `/api/repairs/${tid}/parts`, shop.token).send({
        name: 'The 51st Part',
        qty: 1,
        unitPriceCents: 1000,
        unitCostCents: 500,
      });
      expect(fiftyFirst.status).toBe(400);
      expect(fiftyFirst.body.code).toBe('MAX_PARTS_EXCEEDED');
    });
  });

  describe('Technician role validation, notifications, warranty reset, and approval locking', () => {
    it('(a) assigning a user whose role lacks repairs.edit returns 400 INVALID_TECHNICIAN', async () => {
      const shop = await setupShop('tech_noedit@cellivo.lk', 'Tech Shop');
      const cashier = await addStaff(shop, 'cashier', 'cashier_noedit@cellivo.lk');
      const created = await api('post', '/api/repairs', shop.token).send({
        customer: { name: 'Kasun', phone: '0771234567' },
        device: { brand: 'Apple', model: 'iPad Air' },
        faultDescription: 'Glass cracked',
      });
      const tid = created.body.data._id;

      const assignRes = await api('post', `/api/repairs/${tid}/assign`, shop.token).send({
        technicianId: cashier.id,
      });
      expect(assignRes.status).toBe(400);
      expect(assignRes.body.code).toBe('INVALID_TECHNICIAN');
    });

    it('(b) the repair_created / repair_status_changed notify data contains no link and has the tenant name as shop', async () => {
      const notifySpy = vi.spyOn(notificationsService, 'notify').mockResolvedValue({ logId: 'mock-log-id' });
      const shop = await setupShop('notif_check@cellivo.lk', 'Custom Shop LK');

      // Create ticket
      const created = await api('post', '/api/repairs', shop.token).send({
        customer: { name: 'Sunil', phone: '0771234567' },
        device: { brand: 'Apple', model: 'iPhone 13' },
        faultDescription: 'Screen issue',
      });
      expect(created.status).toBe(201);
      const tid = created.body.data._id;

      // Check repair_created notification
      const createdCall = notifySpy.mock.calls.find((c) => c[0].template === 'repair_created');
      expect(createdCall).toBeDefined();
      expect(createdCall[0].data.link).toBeUndefined();
      expect(createdCall[0].data.shop).toBe('Custom Shop LK');
      expect(createdCall[0].data.status).toBe('Received');

      // Stage transition to Diagnosing
      await api('post', `/api/repairs/${tid}/stage`, shop.token).send({ to: 'Diagnosing' });
      const stageCall = notifySpy.mock.calls.find((c) => c[0].template === 'repair_status_changed');
      expect(stageCall).toBeDefined();
      expect(stageCall[0].data.link).toBeUndefined();
      expect(stageCall[0].data.shop).toBe('Custom Shop LK');
      expect(stageCall[0].data.status).toBe('Diagnosing');

      notifySpy.mockRestore();
    });

    it('(c) setWarranty clears the alert flag', async () => {
      const shop = await setupShop('warranty_flag@cellivo.lk', 'Warranty Shop');
      const created = await api('post', '/api/repairs', shop.token).send({
        customer: { name: 'Kamal', phone: '0771234567' },
        device: { brand: 'Samsung', model: 'S22' },
        faultDescription: 'Battery replacement',
      });
      const tid = created.body.data._id;

      // Set delivered & warranty alert sent flag in db
      await runWithContext({ tenantId: shop.tenantId }, async () => {
        const ticket = await RepairTicket.findById(tid);
        ticket.deliveredAt = new Date();
        ticket.warrantyDays = 30;
        ticket.warrantyAlertSentAt = new Date();
        await ticket.save();
      });

      // Verify flag is set
      const beforeDoc = await runWithContext({ tenantId: shop.tenantId }, async () => {
        return await RepairTicket.findById(tid).lean();
      });
      expect(beforeDoc.warrantyAlertSentAt).not.toBeNull();

      // Call POST /api/repairs/:id/warranty with new days
      const res = await api('post', `/api/repairs/${tid}/warranty`, shop.token).send({ days: 60 });
      expect(res.status).toBe(200);

      // Check DB: warrantyAlertSentAt must be null
      const afterDoc = await runWithContext({ tenantId: shop.tenantId }, async () => {
        return await RepairTicket.findById(tid).lean();
      });
      expect(afterDoc.warrantyDays).toBe(60);
      expect(afterDoc.warrantyAlertSentAt).toBeNull();
    });

    it('(d) recordApproval returns 400 APPROVAL_LOCKED after In repair', async () => {
      const shop = await setupShop('approval_lock@cellivo.lk', 'Lock Shop');
      const created = await api('post', '/api/repairs', shop.token).send({
        customer: { name: 'Nimal', phone: '0771234567' },
        device: { brand: 'Xiaomi', model: 'Redmi Note 10' },
        faultDescription: 'Charging port',
      });
      const tid = created.body.data._id;

      // Move to Diagnosing and record customer approval
      await api('post', `/api/repairs/${tid}/stage`, shop.token).send({ to: 'Diagnosing' });
      const approveRes = await api('post', `/api/repairs/${tid}/approval`, shop.token).send({
        decision: 'approved',
        by: 'in_person',
      });
      expect(approveRes.status).toBe(200);

      // Move to In repair (passes approval gate)
      await api('post', `/api/repairs/${tid}/stage`, shop.token).send({ to: 'In repair' });

      // Attempt to modify approval in In repair stage returns 400 APPROVAL_LOCKED
      const lockedRes = await api('post', `/api/repairs/${tid}/approval`, shop.token).send({
        decision: 'declined',
        by: 'in_person',
      });
      expect(lockedRes.status).toBe(400);
      expect(lockedRes.body.code).toBe('APPROVAL_LOCKED');
    });
  });
});


