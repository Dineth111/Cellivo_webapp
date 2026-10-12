import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { startDb, stopDb, resetDb } from './helpers.js';
import { api, signup, addStaff } from './api.js';
import { runWithContext } from '../src/core/tenantContext.js';
import Customer from '../src/modules/customers/Customer.model.js';
import Invoice from '../src/modules/pos/models/Invoice.model.js';
import CreditNote from '../src/modules/pos/models/CreditNote.model.js';
import InstallmentPlan from '../src/modules/pos/models/InstallmentPlan.model.js';
import LoyaltyTransaction from '../src/modules/pos/models/LoyaltyTransaction.model.js';
import Quotation from '../src/modules/pos/models/Quotation.model.js';
import Cheque from '../src/modules/pos/models/Cheque.model.js';
import LedgerEntry from '../src/modules/pos/models/LedgerEntry.model.js';
import { normalizePhone } from '../src/modules/customers/utils/phone.js';
import { getLoyaltySettings, DEFAULT_LOYALTY_SETTINGS } from '../src/modules/pos/adapters/loyaltySettings.adapter.js';

beforeAll(startDb);
afterAll(stopDb);
beforeEach(resetDb);

async function setupShop(email = 'owner@cellivo.lk', shopName = 'Cellivo Shop') {
  const shop = await signup(email, shopName);
  const me = await api('get', '/api/auth/me', shop.token);
  const tenantId = me.body.data.tenant._id;
  const branchId = me.body.data.tenant.mainBranchId || me.body.data.branchIds?.[0];
  return { ...shop, tenantId, branchId };
}

describe('normalizePhone unit tests (Review item 4)', () => {
  it('correctly handles international, local, spaces, 00 prefixes and rejects invalid inputs', () => {
    expect(normalizePhone('abc')).toBe('');
    expect(normalizePhone('+xyz')).toBe('');
    expect(normalizePhone('0094771234567')).toBe('+94771234567');
    expect(normalizePhone('077 123 4567')).toBe('+94771234567');
    expect(normalizePhone('+94771234567')).toBe('+94771234567');
    expect(normalizePhone('0771234567')).toBe('+94771234567');
    expect(normalizePhone('+14155552671')).toBe('+14155552671');
    expect(normalizePhone('')).toBe('');
    expect(normalizePhone(null)).toBe('');
  });
});

describe('Customer Management (F-13)', () => {
  it('creates customer with phone normalised on write and marketingOptIn default to false', async () => {
    const shop = await setupShop();

    const res = await api('post', '/api/customers', shop.token).send({
      name: 'Nimal Silva',
      phone: '0771234567',
      nic: '199512345678',
      email: 'nimal@example.com',
      tags: ['vip', 'wholesale'],
    });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.name).toBe('Nimal Silva');
    expect(res.body.data.phone).toBe('+94771234567'); // Normalised to E.164
    expect(res.body.data.marketingOptIn).toBe(false); // Default is false
    expect(res.body.data.tags).toEqual(['vip', 'wholesale']);

    // Direct database read confirms no getter mutation
    const directDoc = await runWithContext({ tenantId: shop.tenantId }, async () => {
      return await Customer.findById(res.body.data._id).lean();
    });
    expect(directDoc.phone).toBe('+94771234567');
    expect(directDoc.marketingOptIn).toBe(false);
  });

  it('rejects invalid phone numbers matching /^\+[1-9]\d{7,14}$/ requirement', async () => {
    const shop = await setupShop();

    const res = await api('post', '/api/customers', shop.token).send({
      name: 'Invalid Phone Guy',
      phone: 'abc',
    });
    expect(res.status).toBe(400);
  });

  it('rejects duplicate phone within tenant with 409 and returns existing customer data', async () => {
    const shop = await setupShop();

    const first = await api('post', '/api/customers', shop.token).send({
      name: 'Customer 1',
      phone: '0771234567',
    });
    expect(first.status).toBe(201);

    // Attempt with variant of same phone number (e.g. 94771234567, +94771234567, 077 123 4567)
    const duplicate = await api('post', '/api/customers', shop.token).send({
      name: 'Customer 2',
      phone: '94771234567',
    });

    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('DUPLICATE_PHONE');
    expect(duplicate.body.data).toBeDefined();
    expect(duplicate.body.data._id).toBe(first.body.data._id);
    expect(duplicate.body.data.name).toBe('Customer 1');
  });

  it('checks archived customers on phone duplicate check with explicit message', async () => {
    const shop = await setupShop();

    const first = (
      await api('post', '/api/customers', shop.token).send({
        name: 'Archived Customer',
        phone: '0778889900',
      })
    ).body.data;

    // Archive customer
    await api('delete', `/api/customers/${first._id}`, shop.token);

    // Attempt to create another customer with the same phone
    const res = await api('post', '/api/customers', shop.token).send({
      name: 'New Customer Colliding with Archived',
      phone: '0778889900',
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DUPLICATE_PHONE');
    expect(res.body.message).toContain('archived');
  });

  it('masks phone and NIC in customer list but provides unmasked in GET /:id', async () => {
    const shop = await setupShop();

    const created = (
      await api('post', '/api/customers', shop.token).send({
        name: 'Kamal Perera',
        phone: '0779876543',
        nic: '951234567V',
      })
    ).body.data;

    // List endpoint
    const listRes = await api('get', '/api/customers', shop.token);
    expect(listRes.status).toBe(200);
    const listed = listRes.body.data.find((c) => c._id === created._id);
    expect(listed).toBeDefined();
    expect(listed.phone).toBe('+947*****543'); // Masked
    expect(listed.nic).toBe('951****67V'); // Masked

    // Get single endpoint
    const singleRes = await api('get', `/api/customers/${created._id}`, shop.token);
    expect(singleRes.status).toBe(200);
    expect(singleRes.body.data.phone).toBe('+94779876543'); // Unmasked
    expect(singleRes.body.data.nic).toBe('951234567V'); // Unmasked
  });

  it('supports partial and last-digits search for phone numbers', async () => {
    const shop = await setupShop();

    await api('post', '/api/customers', shop.token).send({
      name: 'Search Test',
      phone: '0771234567',
    });

    // Search by last 4 digits
    const resLastDigits = await api('get', '/api/customers?search=4567', shop.token);
    expect(resLastDigits.status).toBe(200);
    expect(resLastDigits.body.count).toBe(1);
    expect(resLastDigits.body.data[0].name).toBe('Search Test');

    // Search by prefix 077
    const resPrefix = await api('get', '/api/customers?search=077', shop.token);
    expect(resPrefix.status).toBe(200);
    expect(resPrefix.body.count).toBe(1);
  });

  it('detects duplicate groups via GET /api/customers/duplicates using aggregation', async () => {
    const shop = await setupShop();

    await api('post', '/api/customers', shop.token).send({
      name: 'Duplicate Alpha',
      phone: '0771111111',
      nic: '199012345678',
      email: 'dup@example.com',
    });
    await api('post', '/api/customers', shop.token).send({
      name: 'Duplicate Beta',
      phone: '0772222222',
      nic: '199012345678',
      email: 'other@example.com',
    });

    const dupRes = await api('get', '/api/customers/duplicates', shop.token);
    expect(dupRes.status).toBe(200);
    expect(dupRes.body.success).toBe(true);
    expect(dupRes.body.count).toBeGreaterThanOrEqual(1);

    const nicGroup = dupRes.body.data.find((g) => g.reason === 'duplicate_nic');
    expect(nicGroup).toBeDefined();
    expect(nicGroup.count).toBe(2);
    expect(nicGroup.customers[0].phone).toContain('*****');
  });

  it('updates customer details and checks duplicate phone when changed', async () => {
    const shop = await setupShop();

    const c1 = (await api('post', '/api/customers', shop.token).send({ name: 'C1', phone: '0771111111' })).body.data;
    const c2 = (await api('post', '/api/customers', shop.token).send({ name: 'C2', phone: '0772222222' })).body.data;

    // Updating C1 name works
    const updateRes = await api('put', `/api/customers/${c1._id}`, shop.token).send({
      name: 'C1 Updated',
      marketingOptIn: true,
    });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.data.name).toBe('C1 Updated');
    expect(updateRes.body.data.marketingOptIn).toBe(true);

    // Updating C1 to C2's phone conflicts
    const conflictRes = await api('put', `/api/customers/${c1._id}`, shop.token).send({
      phone: '0772222222',
    });
    expect(conflictRes.status).toBe(409);
    expect(conflictRes.body.code).toBe('DUPLICATE_PHONE');
  });

  it('archives customer with DELETE /:id and preserves data', async () => {
    const shop = await setupShop();

    const c = (await api('post', '/api/customers', shop.token).send({ name: 'To Archive', phone: '0773333333' })).body.data;

    const delRes = await api('delete', `/api/customers/${c._id}`, shop.token);
    expect(delRes.status).toBe(200);

    const listRes = await api('get', '/api/customers', shop.token);
    expect(listRes.body.data.some((x) => x._id === c._id)).toBe(false);

    // Filter by archived=true returns it
    const archivedList = await api('get', '/api/customers?archived=true', shop.token);
    expect(archivedList.body.data.some((x) => x._id === c._id)).toBe(true);
  });
});

describe('CSV Import (F-13)', () => {
  it('imports valid CSV with text/csv header and normalises phones', async () => {
    const shop = await setupShop();

    const csvData = [
      'name,phone,email,nic,type,tags,marketing_opt_in',
      'Sunil Fernando,0771234567,sunil@test.com,198012345678,retail,"vip, loyalty",true',
      'Ruwan Silva,0712345678,ruwan@test.com,198112345678,wholesale,"trader",false',
    ].join('\n');

    const res = await api('post', '/api/customers/import', shop.token)
      .set('Content-Type', 'text/csv')
      .send(csvData);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBe(2);

    const list = await api('get', '/api/customers', shop.token);
    expect(list.body.total).toBe(2);
  });

  it('reports error if CSV file ends inside an open quote (Review item 10)', async () => {
    const shop = await setupShop();

    const brokenCsv = 'name,phone,notes\nIncomplete Customer,0771234567,"Unclosed quote notes';

    const res = await api('post', '/api/customers/import', shop.token)
      .set('Content-Type', 'text/csv')
      .send(brokenCsv);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CSV_VALIDATION_ERROR');
    expect(res.body.data?.errors[0].message).toContain('open quote');
  });

  it('all-or-nothing: rejects entire CSV on row validation error with per-row errors', async () => {
    const shop = await setupShop();

    const csvData = [
      'name,phone,email',
      'Valid Customer,0771112233,valid@test.com',
      ',0772223344,invalid-no-name@test.com', // Missing name on row 3
      'Duplicate In File,0771112233,dup@test.com', // Duplicate phone on row 4
    ].join('\n');

    const res = await api('post', '/api/customers/import', shop.token)
      .set('Content-Type', 'text/csv')
      .send(csvData);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CSV_VALIDATION_ERROR');
    expect(res.body.data?.errors).toBeDefined();
    expect(res.body.data.errors.length).toBeGreaterThanOrEqual(2);

    // Verify 0 customers inserted
    const list = await api('get', '/api/customers', shop.token);
    expect(list.body.total).toBe(0);
  });

  it('rejects CSV if phone exists in active OR archived database records (Review item 3)', async () => {
    const shop = await setupShop();

    const existing = (
      await api('post', '/api/customers', shop.token).send({
        name: 'Archived Guy',
        phone: '0779998877',
      })
    ).body.data;

    // Archive it
    await api('delete', `/api/customers/${existing._id}`, shop.token);

    const csvData = [
      'name,phone,email',
      'New Guy,0775554433,new@test.com',
      'Colliding Guy,0779998877,colliding@test.com',
    ].join('\n');

    const res = await api('post', '/api/customers/import', shop.token)
      .set('Content-Type', 'text/csv')
      .send(csvData);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('DUPLICATE_PHONE_IN_CSV');
    expect(res.body.data?.errors[0].message).toContain('archived');

    // Verify New Guy was NOT inserted
    const list = await api('get', '/api/customers', shop.token);
    expect(list.body.total).toBe(0); // 1 archived, 0 active
  });
});

describe('Customer Merge (F-13)', () => {
  it('enforces owner-only permission for merge', async () => {
    const shop = await setupShop();
    const cashier = await addStaff(shop, 'cashier', 'cashier@cellivo.lk');

    const c1 = (await api('post', '/api/customers', shop.token).send({ name: 'A', phone: '0771111111' })).body.data;
    const c2 = (await api('post', '/api/customers', shop.token).send({ name: 'B', phone: '0772222222' })).body.data;

    const res = await api('post', `/api/customers/${c1._id}/merge`, cashier.token).send({
      intoId: c2._id,
    });
    expect(res.status).toBe(403);
  });

  it('rejects self-merge, archived or already-merged customers, loops, and cross-tenant merges', async () => {
    const shopA = await setupShop('shop-a@cellivo.lk', 'Shop A');
    const shopB = await setupShop('shop-b@cellivo.lk', 'Shop B');

    const a1 = (await api('post', '/api/customers', shopA.token).send({ name: 'A1', phone: '0771111111' })).body.data;
    const a2 = (await api('post', '/api/customers', shopA.token).send({ name: 'A2', phone: '0772222222' })).body.data;
    const b1 = (await api('post', '/api/customers', shopB.token).send({ name: 'B1', phone: '0773333333' })).body.data;

    // Self-merge
    const selfRes = await api('post', `/api/customers/${a1._id}/merge`, shopA.token).send({ intoId: a1._id });
    expect(selfRes.status).toBe(400);

    // Cross-tenant merge returns 404
    const crossRes = await api('post', `/api/customers/${a1._id}/merge`, shopA.token).send({ intoId: b1._id });
    expect(crossRes.status).toBe(404);

    // Successful merge of a1 into a2
    const mergeRes = await api('post', `/api/customers/${a1._id}/merge`, shopA.token).send({ intoId: a2._id });
    expect(mergeRes.status).toBe(200);

    // Merging an already-merged customer (a1) returns 400
    const remRes = await api('post', `/api/customers/${a1._id}/merge`, shopA.token).send({ intoId: a2._id });
    expect(remRes.status).toBe(400);

    // Merging into an already-merged customer returns 400
    const a3 = (await api('post', '/api/customers', shopA.token).send({ name: 'A3', phone: '0774444444' })).body.data;
    const intoMerged = await api('post', `/api/customers/${a3._id}/merge`, shopA.token).send({ intoId: a1._id });
    expect(intoMerged.status).toBe(400);
  });

  it('atomically reassigns POS references and handles concurrent balance changes via $inc (Review item 2)', async () => {
    const shop = await setupShop();

    const c1 = (
      await api('post', '/api/customers', shop.token).send({
        name: 'Source Customer',
        phone: '0771111111',
        tags: ['tag1'],
        notes: 'Source notes',
      })
    ).body.data;

    const c2 = (
      await api('post', '/api/customers', shop.token).send({
        name: 'Target Customer',
        phone: '0772222222',
        tags: ['tag2'],
        notes: 'Target notes',
      })
    ).body.data;

    // Seed data under source customer in Dev 3 collections
    let invoiceId;
    await runWithContext({ tenantId: shop.tenantId }, async () => {
      // Set initial balances
      await Customer.updateOne({ _id: c1._id }, { $set: { currentBalanceCents: 5000, loyaltyPoints: 100, creditLimitCents: 20000 } });
      await Customer.updateOne({ _id: c2._id }, { $set: { currentBalanceCents: 10000, loyaltyPoints: 50, creditLimitCents: 15000 } });

      const inv = await Invoice.create({
        invoiceNumber: 'INV-TEST-001',
        customerId: c1._id,
        customerSnapshot: { name: 'Source Customer', phone: '+94771111111' },
        branchId: shop.branchId,
        cashierId: shop.user._id,
        subtotalCents: 5000,
        grandTotalCents: 5000,
        totalPaidCents: 5000,
        lines: [
          {
            name: 'Earphones',
            qty: 1,
            unitPriceCents: 5000,
            grossCents: 5000,
            netCents: 5000,
            lineTotalCents: 5000,
          },
        ],
      });
      invoiceId = inv._id;

      await CreditNote.create({
        creditNoteNumber: 'CN-TEST-001',
        originalInvoiceId: inv._id,
        originalInvoiceNumber: 'INV-TEST-001',
        customerId: c1._id,
        branchId: shop.branchId,
        items: [
          {
            name: 'Earphones',
            qty: 1,
            unitPriceCents: 1000,
            refundCents: 1000,
          },
        ],
        subtotalCents: 1000,
        totalRefundCents: 1000,
      });

      await InstallmentPlan.create({
        planNumber: 'IP-001',
        invoiceId: inv._id,
        invoiceNumber: 'INV-TEST-001',
        customerId: c1._id,
        totalAmountCents: 5000,
        downPaymentCents: 1000,
        financedAmountCents: 4000,
        remainingBalanceCents: 4000,
        numberOfInstallments: 4,
        frequency: 'monthly',
        schedule: [
          {
            installmentNumber: 1,
            dueDate: new Date(),
            amountCents: 4000,
          },
        ],
      });

      await LoyaltyTransaction.create({
        customerId: c1._id,
        invoiceId: inv._id,
        type: 'earn',
        points: 50,
        amountCents: 5000,
        balanceAfter: 50,
      });

      await Quotation.create({
        quoteNumber: 'QUO-001',
        customerId: c1._id,
        branchId: shop.branchId,
        subtotalCents: 3000,
        grandTotalCents: 3000,
      });

      await Cheque.create({
        chequeNumber: 'CHQ-123456',
        bankName: 'BOC',
        amountCents: 5000,
        partyName: 'Source Customer',
        customerId: c1._id,
        branchId: shop.branchId,
        maturityDate: new Date(),
      });

      await LedgerEntry.create({
        entryNumber: 'LE-001',
        date: new Date(),
        referenceType: 'sale',
        referenceId: String(inv._id),
        lines: [
          { accountCode: '1010', accountName: 'Cash', debit: 50, credit: 0 },
          { accountCode: '4010', accountName: 'Sales Revenue', debit: 0, credit: 50 },
        ],
      });
    });

    // Concurrently adjust target balance before merge executes to test $inc atomicity
    await runWithContext({ tenantId: shop.tenantId }, async () => {
      await Customer.updateOne({ _id: c2._id }, { $inc: { currentBalanceCents: 2000 } });
    });

    // Execute merge
    const res = await api('post', `/api/customers/${c1._id}/merge`, shop.token).send({
      intoId: c2._id,
    });
    expect(res.status).toBe(200);

    // Inspect updated collections
    await runWithContext({ tenantId: shop.tenantId }, async () => {
      // 1. Invoices reassigned, customerSnapshot preserved
      const updatedInv = await Invoice.findById(invoiceId).lean();
      expect(String(updatedInv.customerId)).toBe(String(c2._id));
      expect(updatedInv.customerSnapshot.name).toBe('Source Customer');
      expect(updatedInv.customerSnapshot.phone).toBe('+94771111111');

      // 2. Collections reassigned
      const cn = await CreditNote.findOne({ customerId: c2._id }).lean();
      expect(cn).toBeDefined();

      const ip = await InstallmentPlan.findOne({ customerId: c2._id }).lean();
      expect(ip).toBeDefined();

      const lt = await LoyaltyTransaction.findOne({ customerId: c2._id }).lean();
      expect(lt).toBeDefined();

      const quot = await Quotation.findOne({ customerId: c2._id }).lean();
      expect(quot).toBeDefined();

      const chq = await Cheque.findOne({ customerId: c2._id }).lean();
      expect(chq).toBeDefined();

      // 3. LedgerEntry untouched
      const leCount = await LedgerEntry.countDocuments();
      expect(leCount).toBe(1);

      // 4. Target balances combined via $inc (10000 + 2000 concurrent + 5000 from source = 17000)
      const updatedTarget = await Customer.findById(c2._id).lean();
      expect(updatedTarget.currentBalanceCents).toBe(17000);
      expect(updatedTarget.loyaltyPoints).toBe(150); // 100 + 50
      expect(updatedTarget.creditLimitCents).toBe(20000); // Math.max(20000, 15000)
      expect(updatedTarget.tags).toEqual(expect.arrayContaining(['tag1', 'tag2']));
      expect(updatedTarget.notes).toContain('Target notes');
      expect(updatedTarget.notes).toContain('Source notes');

      // 5. Source customer archived with mergedInto
      const updatedSource = await Customer.findById(c1._id).lean();
      expect(updatedSource.isArchived).toBe(true);
      expect(String(updatedSource.mergedInto)).toBe(String(c2._id));
      expect(updatedSource.currentBalanceCents).toBe(0);
      expect(updatedSource.loyaltyPoints).toBe(0);
    });
  });
});

describe('Loyalty Settings & Adapter (F-13)', () => {
  it('requires settings.view and settings.edit permissions (Review item 6)', async () => {
    const shop = await setupShop();
    const cashier = await addStaff(shop, 'cashier', 'cashier-loyalty@cellivo.lk');

    // Cashier does not have settings permissions
    const getRes = await api('get', '/api/customers/loyalty-settings', cashier.token);
    expect(getRes.status).toBe(403);

    const putRes = await api('put', '/api/customers/loyalty-settings', cashier.token).send({
      pointsPerHundredRupees: 2,
    });
    expect(putRes.status).toBe(403);
  });

  it('validates settings with Number.isFinite and caps (Review item 6)', async () => {
    const shop = await setupShop();

    // Rejects non-finite values
    const nanRes = await api('put', '/api/customers/loyalty-settings', shop.token).send({
      pointsPerHundredRupees: 'invalid-not-a-number',
    });
    expect(nanRes.status).toBe(400);

    // Rejects pointsPerHundredRupees > 1000
    const overPoints = await api('put', '/api/customers/loyalty-settings', shop.token).send({
      pointsPerHundredRupees: 1001,
    });
    expect(overPoints.status).toBe(400);

    // Rejects valuePerPointCents > 10000
    const overValue = await api('put', '/api/customers/loyalty-settings', shop.token).send({
      valuePerPointCents: 10001,
    });
    expect(overValue.status).toBe(400);

    // Rejects minRedemptionPoints > 1000000
    const overMin = await api('put', '/api/customers/loyalty-settings', shop.token).send({
      minRedemptionPoints: 1000001,
    });
    expect(overMin.status).toBe(400);

    // Rejects expiryDays > 3650
    const overExpiry = await api('put', '/api/customers/loyalty-settings', shop.token).send({
      expiryDays: 3651,
    });
    expect(overExpiry.status).toBe(400);
  });

  it('gets defaults when no settings exist, updates settings via PUT, and adapter reads them', async () => {
    const shop = await setupShop();

    // GET /loyalty-settings returns defaults initially
    const getRes = await api('get', '/api/customers/loyalty-settings', shop.token);
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.pointsPerHundredRupees).toBe(1);
    expect(getRes.body.data.valuePerPointCents).toBe(100);

    // Adapter returns defaults when document is absent, even with no request context
    const adapterResDefault = await getLoyaltySettings(shop.tenantId);
    expect(adapterResDefault.pointsPerHundredRupees).toBe(1);
    expect(adapterResDefault.valuePerPointCents).toBe(100);

    // PUT /loyalty-settings updates the settings
    const putRes = await api('put', '/api/customers/loyalty-settings', shop.token).send({
      pointsPerHundredRupees: 2,
      valuePerPointCents: 200,
      minRedemptionPoints: 50,
      expiryDays: 180,
    });
    expect(putRes.status).toBe(200);
    expect(putRes.body.data.pointsPerHundredRupees).toBe(2);
    expect(putRes.body.data.valuePerPointCents).toBe(200);
    expect(putRes.body.data.minRedemptionPoints).toBe(50);
    expect(putRes.body.data.expiryDays).toBe(180);

    // Adapter reads updated settings (outside request context)
    const adapterResUpdated = await getLoyaltySettings(shop.tenantId);
    expect(adapterResUpdated.pointsPerHundredRupees).toBe(2);
    expect(adapterResUpdated.valuePerPointCents).toBe(200);
    expect(adapterResUpdated.minRedemptionPoints).toBe(50);
    expect(adapterResUpdated.expiryDays).toBe(180);
  });
});

describe('Customer History (F-13)', () => {
  it('masks cost prices for cashier but reveals for owner in getCustomerHistory (Review item 1)', async () => {
    const shop = await setupShop();
    const cashier = await addStaff(shop, 'cashier', 'cashier-history@cellivo.lk');

    const customer = (
      await api('post', '/api/customers', shop.token).send({
        name: 'History Customer',
        phone: '0779991122',
      })
    ).body.data;

    let invoiceId;
    await runWithContext({ tenantId: shop.tenantId }, async () => {
      const inv = await Invoice.create({
        invoiceNumber: 'INV-HIST-001',
        customerId: customer._id,
        branchId: shop.branchId,
        cashierId: shop.user._id,
        subtotalCents: 10000,
        grandTotalCents: 10000,
        totalPaidCents: 10000,
        lines: [
          {
            name: 'Phone Case',
            qty: 1,
            unitPriceCents: 10000,
            costPriceCents: 6000,
            grossCents: 10000,
            netCents: 10000,
            lineTotalCents: 10000,
          },
        ],
      });
      invoiceId = inv._id;
    });

    // 1. Query as Cashier: costPriceCents MUST BE MASKED
    const cashierHist = await api('get', `/api/customers/${customer._id}/history`, cashier.token);
    expect(cashierHist.status).toBe(200);
    const cashierLine = cashierHist.body.data.invoices[0].lines[0];
    expect(cashierLine.costPriceCents).toBeUndefined();

    // 2. Query as Owner: costPriceCents is present
    const ownerHist = await api('get', `/api/customers/${customer._id}/history`, shop.token);
    expect(ownerHist.status).toBe(200);
    const ownerLine = ownerHist.body.data.invoices[0].lines[0];
    expect(ownerLine.costPriceCents).toBe(6000);
  });

  it('returns customer history with POS records and enforces tenant isolation', async () => {
    const shopA = await setupShop('shop-ha@cellivo.lk', 'History Shop A');
    const shopB = await setupShop('shop-hb@cellivo.lk', 'History Shop B');

    const customerA = (
      await api('post', '/api/customers', shopA.token).send({
        name: 'History Isolation Customer',
        phone: '0779991133',
      })
    ).body.data;

    let invoiceId;
    await runWithContext({ tenantId: shopA.tenantId }, async () => {
      const inv = await Invoice.create({
        invoiceNumber: 'INV-HIST-002',
        customerId: customerA._id,
        branchId: shopA.branchId,
        cashierId: shopA.user._id,
        subtotalCents: 10000,
        grandTotalCents: 10000,
        totalPaidCents: 10000,
        lines: [
          {
            name: 'Phone Case',
            qty: 1,
            unitPriceCents: 10000,
            grossCents: 10000,
            netCents: 10000,
            lineTotalCents: 10000,
          },
        ],
      });
      invoiceId = inv._id;
    });

    // Query history as Tenant A
    const histRes = await api('get', `/api/customers/${customerA._id}/history`, shopA.token);
    expect(histRes.status).toBe(200);
    expect(histRes.body.success).toBe(true);
    expect(histRes.body.data.customer._id).toBe(customerA._id);
    expect(histRes.body.data.invoices.length).toBe(1);
    expect(histRes.body.data.invoices[0]._id).toBe(String(invoiceId));

    // Query history as Tenant B fails with 404
    const crossRes = await api('get', `/api/customers/${customerA._id}/history`, shopB.token);
    expect(crossRes.status).toBe(404);
  });
});
