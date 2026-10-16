import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { startDb, stopDb, resetDb } from './helpers.js';
import { api, signup } from './api.js';
import { runAsPlatform, runWithContext } from '../src/core/tenantContext.js';
import RepairTicket, { publicCodeHelper, PUBLIC_CODE_ALPHABET } from '../src/modules/repairs/models/RepairTicket.model.js';
import Tenant from '../src/modules/tenants/Tenant.model.js';
import { setTestLimits, resetTestLimits } from '../src/modules/repairs/utils/rateLimiter.js';

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await resetDb();
  resetTestLimits();
});

/**
 * Recursive key walker to assert that no forbidden fields leak into public responses.
 */
function assertNoForbiddenKeys(obj, path = '') {
  const FORBIDDEN = [
    'tenantId',
    '_id',
    'id',
    'customerId',
    'customer',
    'phone',
    'address',
    'nic',
    'imei',
    'serial',
    'passcode',
    'internalNotes',
    'technicianId',
    'technician',
    'cost',
    'unitCostCents',
    'partsCostCents',
    'cogsPostedCents',
    'margin',
    'audit',
  ];

  if (!obj || typeof obj !== 'object') return;

  for (const [key, val] of Object.entries(obj)) {
    const fullPath = path ? `${path}.${key}` : key;
    // Allow 'shopName' which ends in 'Name', but forbid customer/technician 'name' directly
    if (key === 'name' && path !== '') {
      expect.fail(`Forbidden key found at ${fullPath}`);
    }
    for (const forbidden of FORBIDDEN) {
      if (key.toLowerCase() === forbidden.toLowerCase()) {
        expect.fail(`Forbidden key '${forbidden}' found at ${fullPath}`);
      }
    }
    if (typeof val === 'object' && val !== null) {
      assertNoForbiddenKeys(val, fullPath);
    }
  }
}

describe('REP-08 Public Repair Status Page', () => {
  it('allows valid lookup without login by ticket number and phone last 4 digits', async () => {
    const owner = await signup('shop1@cellivo.lk', 'Apex Cell Fix');
    const custRes = await api('post', '/api/customers', owner.token).send({
      name: 'Kamal Perera',
      phone: '0771234567',
    });
    const customer = custRes.body.data;

    const ticketRes = await api('post', '/api/repairs', owner.token).send({
      customerId: customer._id,
      device: { brand: 'Samsung', model: 'Galaxy S23' },
      faultDescription: 'Broken display',
      estimateCents: 1500000,
    });
    const ticket = ticketRes.body.data;
    expect(ticket.ticketNo).toMatch(/^JOB-/);

    // Public lookup without any Authorization header
    const publicRes = await api('get', `/api/public/repairs/status?ticketNo=${ticket.ticketNo}&phoneLast4=4567`);
    expect(publicRes.status).toBe(200);
    expect(publicRes.headers['cache-control']).toContain('no-store');

    const data = publicRes.body.data;
    expect(data.shopName).toBe('Apex Cell Fix');
    expect(data.ticketNo).toBe(ticket.ticketNo);
    expect(data.device).toEqual({ brand: 'Samsung', model: 'Galaxy S23' });
    expect(data.stage).toBe('Received');
    expect(Array.isArray(data.timeline)).toBe(true);
    expect(data.timeline.length).toBeGreaterThanOrEqual(1);
    expect(data.amountDue).toBeNull(); // not ready yet
  });

  it('allows valid lookup without login by tracking token (GET and POST)', async () => {
    const owner = await signup('shop2@cellivo.lk', 'Metro Repairs');
    const custRes = await api('post', '/api/customers', owner.token).send({
      name: 'Sunil Silva',
      phone: '0719876543',
    });
    const customer = custRes.body.data;

    const ticketRes = await api('post', '/api/repairs', owner.token).send({
      customerId: customer._id,
      device: { brand: 'Apple', model: 'iPhone 14' },
      faultDescription: 'Battery swelling',
      estimateCents: 1200000,
    });
    const ticket = ticketRes.body.data;

    // Fetch tracking token from internal jobcard
    const jobCardRes = await api('get', `/api/repairs/${ticket._id}/jobcard`, owner.token);
    const trackingToken = jobCardRes.body.data.trackingToken;
    expect(trackingToken).toBeDefined();
    expect(trackingToken.length).toBeGreaterThanOrEqual(32);

    // 1. GET with token
    const getRes = await api('get', `/api/public/repairs/status?token=${trackingToken}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.shopName).toBe('Metro Repairs');
    expect(getRes.body.data.device.model).toBe('iPhone 14');

    // 2. POST with token
    const postRes = await api('post', '/api/public/repairs/status').send({ token: trackingToken });
    expect(postRes.status).toBe(200);
    expect(postRes.body.data.shopName).toBe('Metro Repairs');
    expect(postRes.body.data.ticketNo).toBe(ticket.ticketNo);
  });

  it('wrong phone digits and unknown ticket return identical status code and body with similar timing', async () => {
    const owner = await signup('shop3@cellivo.lk', 'Lanka Phone Hub');
    const custRes = await api('post', '/api/customers', owner.token).send({
      name: 'Nimal Jay',
      phone: '0761112233',
    });
    const customer = custRes.body.data;

    const ticketRes = await api('post', '/api/repairs', owner.token).send({
      customerId: customer._id,
      device: { brand: 'Xiaomi', model: 'Redmi Note 12' },
      faultDescription: 'Water damage',
    });
    const ticket = ticketRes.body.data;

    // 1. Known ticket, wrong digits
    const startWrong = Date.now();
    const wrongDigitsRes = await api('get', `/api/public/repairs/status?ticketNo=${ticket.ticketNo}&phoneLast4=9999`);
    const durationWrong = Date.now() - startWrong;

    // 2. Unknown ticket
    const startUnknown = Date.now();
    const unknownTicketRes = await api('get', `/api/public/repairs/status?ticketNo=JOB-999999&phoneLast4=2233`);
    const durationUnknown = Date.now() - startUnknown;

    expect(wrongDigitsRes.status).toBe(404);
    expect(unknownTicketRes.status).toBe(404);
    expect(wrongDigitsRes.body).toEqual(unknownTicketRes.body);
    expect(wrongDigitsRes.body).toEqual({
      error: 'TICKET_NOT_FOUND',
      message: 'Ticket not found or details do not match',
    });

    // Timing difference should be small (within reasonable delta for single DB round trips)
    const delta = Math.abs(durationWrong - durationUnknown);
    expect(delta).toBeLessThan(500); // 500ms max variance under local test execution
  });

  it('enforces rate limiting and returns 429 when threshold exceeded, ignoring x-test-rate-limit header', async () => {
    setTestLimits({ failedAttemptLimit: 2, ipLimit: 100 });
    const owner = await signup('shop4@cellivo.lk', 'FastFix Kandy');
    const custRes = await api('post', '/api/customers', owner.token).send({
      name: 'Ruwan Perera',
      phone: '0754445555',
    });
    const ticketRes = await api('post', '/api/repairs', owner.token).send({
      customerId: custRes.body.data._id,
      device: { brand: 'Google', model: 'Pixel 7' },
      faultDescription: 'Camera glass cracked',
    });
    const ticketNo = ticketRes.body.data.ticketNo;

    // Successful lookups do not count toward failed attempts
    const successRes = await api('get', `/api/public/repairs/status?ticketNo=${ticketNo}&phoneLast4=5555`);
    expect(successRes.status).toBe(200);

    // Send huge header value to verify it is completely ignored by server config
    const fail1 = await api('get', `/api/public/repairs/status?ticketNo=${ticketNo}&phoneLast4=0000`)
      .set('x-test-rate-limit', '999999');
    expect(fail1.status).toBe(404);

    const fail2 = await api('get', `/api/public/repairs/status?ticketNo=${ticketNo}&phoneLast4=0000`)
      .set('x-test-rate-limit', '999999');
    expect(fail2.status).toBe(404);

    // 3rd failed attempt hits server-side limit of 2 failed attempts
    const fail3 = await api('get', `/api/public/repairs/status?ticketNo=${ticketNo}&phoneLast4=0000`)
      .set('x-test-rate-limit', '999999');
    expect(fail3.status).toBe(429);
    expect(fail3.body.error).toBe('RATE_LIMIT_EXCEEDED');
    expect(fail3.headers['retry-after']).toBe('900');

    resetTestLimits();
  });

  it('two tenants with the same ticket number and same phone suffix each return only their own ticket', async () => {
    const shopA = await signup('alpha@cellivo.lk', 'Alpha Mobile');
    const shopB = await signup('beta@cellivo.lk', 'Beta Mobile');

    // Both shops create a customer with phone ending in 1234
    const custA = (await api('post', '/api/customers', shopA.token).send({
      name: 'Alpha Customer',
      phone: '0770001234',
    })).body.data;

    const custB = (await api('post', '/api/customers', shopB.token).send({
      name: 'Beta Customer',
      phone: '0719991234',
    })).body.data;

    // Both shops create their first ticket (#JOB-000001)
    const ticketA = (await api('post', '/api/repairs', shopA.token).send({
      customerId: custA._id,
      device: { brand: 'Apple', model: 'iPhone 13' },
      faultDescription: 'Screen issue',
    })).body.data;

    const ticketB = (await api('post', '/api/repairs', shopB.token).send({
      customerId: custB._id,
      device: { brand: 'Samsung', model: 'Galaxy S22' },
      faultDescription: 'Charging port',
    })).body.data;

    expect(ticketA.ticketNo).toBe('JOB-000001');
    expect(ticketB.ticketNo).toBe('JOB-000001');

    const cardA = (await api('get', `/api/repairs/${ticketA._id}/jobcard`, shopA.token)).body.data;
    const cardB = (await api('get', `/api/repairs/${ticketB._id}/jobcard`, shopB.token)).body.data;

    expect(cardA.publicCode).toBeDefined();
    expect(cardB.publicCode).toBeDefined();
    expect(cardA.publicCode).not.toBe(cardB.publicCode);

    // 1. Lookup via publicCode + last 4 digits (unambiguous, no cross-tenant leakage)
    const resA = await api('get', `/api/public/repairs/status?publicCode=${cardA.publicCode}&phoneLast4=1234`);
    expect(resA.status).toBe(200);
    expect(resA.body.data.shopName).toBe('Alpha Mobile');
    expect(resA.body.data.device.model).toBe('iPhone 13');

    const resB = await api('get', `/api/public/repairs/status?publicCode=${cardB.publicCode}&phoneLast4=1234`);
    expect(resB.status).toBe(200);
    expect(resB.body.data.shopName).toBe('Beta Mobile');
    expect(resB.body.data.device.model).toBe('Galaxy S22');

    // 2. Lookup via ticketNo + shopCode + last 4 digits
    const resShopA = await api('get', `/api/public/repairs/status?ticketNo=JOB-000001&shopCode=Alpha Mobile&phoneLast4=1234`);
    expect(resShopA.status).toBe(200);
    expect(resShopA.body.data.shopName).toBe('Alpha Mobile');
    expect(resShopA.body.data.device.brand).toBe('Apple');

    const resShopB = await api('get', `/api/public/repairs/status?ticketNo=JOB-000001&shopCode=Beta Mobile&phoneLast4=1234`);
    expect(resShopB.status).toBe(200);
    expect(resShopB.body.data.shopName).toBe('Beta Mobile');
    expect(resShopB.body.data.device.brand).toBe('Samsung');
  });

  it('token of another tenant cannot read across tenants', async () => {
    const shopA = await signup('shopA@cellivo.lk', 'Shop Alpha');
    const shopB = await signup('shopB@cellivo.lk', 'Shop Beta');

    const custA = (await api('post', '/api/customers', shopA.token).send({
      name: 'Customer A',
      phone: '0770000001',
    })).body.data;

    const custB = (await api('post', '/api/customers', shopB.token).send({
      name: 'Customer B',
      phone: '0770000002',
    })).body.data;

    const ticketA = (await api('post', '/api/repairs', shopA.token).send({
      customerId: custA._id,
      device: { brand: 'OnePlus', model: '11' },
      faultDescription: 'Mic issue',
    })).body.data;

    const tokenA = (await api('get', `/api/repairs/${ticketA._id}/jobcard`, shopA.token)).body.data.trackingToken;

    // Cross-tenant attempt: lookup Ticket A using Ticket A's number with Shop B's customer phone
    const crossRes = await api('get', `/api/public/repairs/status?ticketNo=${ticketA.ticketNo}&phoneLast4=0002`);
    expect(crossRes.status).toBe(404);
    expect(crossRes.body.error).toBe('TICKET_NOT_FOUND');

    // Token lookup returns only Shop A data, never Shop B
    const lookupA = await api('get', `/api/public/repairs/status?token=${tokenA}`);
    expect(lookupA.status).toBe(200);
    expect(lookupA.body.data.shopName).toBe('Shop Alpha');
    expect(lookupA.body.data.shopName).not.toBe('Shop Beta');

    // Forged/random token returns 404
    const fakeToken = '0123456789abcdef0123456789abcdef0123456789abcdef';
    const fakeRes = await api('get', `/api/public/repairs/status?token=${fakeToken}`);
    expect(fakeRes.status).toBe(404);
  });

  it('response contains strictly no forbidden fields (assert by key walk)', async () => {
    const owner = await signup('shop5@cellivo.lk', 'Secure Repairs');
    const custRes = await api('post', '/api/customers', owner.token).send({
      name: 'Secret VIP',
      phone: '0779998877',
      nic: '199512345678',
      address: '123 High Street, Colombo',
    });
    const customer = custRes.body.data;

    // Create ticket with sensitive internal fields: passcode, imei, serial, cost, internalNotes
    const ticketRes = await api('post', '/api/repairs', owner.token).send({
      customerId: customer._id,
      device: {
        brand: 'Apple',
        model: 'iPhone 15 Pro',
        imei: '356938035643809',
        serial: 'SN987654321',
      },
      passcode: '9876',
      faultDescription: 'Screen flickering',
      internalNotes: 'Customer is impatient, handle with extra care',
      estimateCents: 2500000,
    });
    const ticket = ticketRes.body.data;

    const publicRes = await api('get', `/api/public/repairs/status?ticketNo=${ticket.ticketNo}&phoneLast4=8877`);
    expect(publicRes.status).toBe(200);

    const data = publicRes.body.data;

    // Run strict recursive key walk
    assertNoForbiddenKeys(data);

    // Explicit specific assertions
    expect(data.tenantId).toBeUndefined();
    expect(data._id).toBeUndefined();
    expect(data.id).toBeUndefined();
    expect(data.customerId).toBeUndefined();
    expect(data.customer).toBeUndefined();
    expect(data.phone).toBeUndefined();
    expect(data.address).toBeUndefined();
    expect(data.nic).toBeUndefined();
    expect(data.internalNotes).toBeUndefined();
    expect(data.technicianId).toBeUndefined();
    expect(data.device.imei).toBeUndefined();
    expect(data.device.serial).toBeUndefined();
    expect(data.device.passcode).toBeUndefined();
  });

  it('handles ticket of cancelled shop with 403 SHOP_INACTIVE', async () => {
    const owner = await signup('shop6@cellivo.lk', 'Closing Soon Ltd');
    const custRes = await api('post', '/api/customers', owner.token).send({
      name: 'Kasun Bandara',
      phone: '0773332211',
    });
    const ticketRes = await api('post', '/api/repairs', owner.token).send({
      customerId: custRes.body.data._id,
      device: { brand: 'Sony', model: 'Xperia 1' },
      faultDescription: 'Power button loose',
    });
    const ticketNo = ticketRes.body.data.ticketNo;

    // Cancel the tenant in database
    await runAsPlatform(async () => {
      await Tenant.updateOne({ name: 'Closing Soon Ltd' }, { status: 'cancelled' });
    });

    const statusRes = await api('get', `/api/public/repairs/status?ticketNo=${ticketNo}&phoneLast4=2211`);
    expect(statusRes.status).toBe(403);
    expect(statusRes.body.error).toBe('SHOP_INACTIVE');
  });

  it('shows amount due with total and balance only when ticket stage is Ready', async () => {
    const owner = await signup('shop7@cellivo.lk', 'Precision Tech');
    const custRes = await api('post', '/api/customers', owner.token).send({
      name: 'Deepal Fernando',
      phone: '0778889900',
    });
    const ticketRes = await api('post', '/api/repairs', owner.token).send({
      customerId: custRes.body.data._id,
      device: { brand: 'Asus', model: 'ROG Phone 6' },
      faultDescription: 'Speaker distortion',
      estimateCents: 1000000,
      advanceCents: 300000,
    });
    const ticketId = ticketRes.body.data._id;
    const ticketNo = ticketRes.body.data.ticketNo;

    // Transition: Received -> Diagnosing -> Waiting approval -> In repair -> Quality check -> Ready
    await api('post', `/api/repairs/${ticketId}/stage`, owner.token).send({ to: 'Diagnosing' });
    await api('post', `/api/repairs/${ticketId}/stage`, owner.token).send({ to: 'Waiting approval' });
    await api('post', `/api/repairs/${ticketId}/approval`, owner.token).send({ decision: 'approved', by: 'in_person' });
    await api('post', `/api/repairs/${ticketId}/stage`, owner.token).send({ to: 'In repair' });
    await api('post', `/api/repairs/${ticketId}/stage`, owner.token).send({ to: 'Quality check' });
    await api('post', `/api/repairs/${ticketId}/stage`, owner.token).send({ to: 'Ready' });

    const readyRes = await api('get', `/api/public/repairs/status?ticketNo=${ticketNo}&phoneLast4=9900`);
    expect(readyRes.status).toBe(200);
    expect(readyRes.body.data.stage).toBe('Ready');
    expect(readyRes.body.data.amountDue).toEqual({
      totalCents: 1000000,
      balanceCents: 700000,
    });
  });

  it('publicCode generates 10 characters from unconfusable alphabet and retries on duplicate collision', async () => {
    const owner = await signup('format_test@cellivo.lk', 'Format Test Shop');

    // 1. Format test: 10 chars from alphabet ABCDEFGHJKMNPQRSTUVWXYZ23456789
    const custRes = await api('post', '/api/customers', owner.token).send({
      name: 'Format Tester',
      phone: '0771239876',
    });
    const ticketRes1 = await api('post', '/api/repairs', owner.token).send({
      customerId: custRes.body.data._id,
      device: { brand: 'OnePlus', model: '11' },
      faultDescription: 'Format verification test',
    });
    expect(ticketRes1.status).toBe(201);
    const code1 = ticketRes1.body.data.publicCode;

    expect(code1).toBeDefined();
    expect(code1).toHaveLength(10);
    expect(code1).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{10}$/);
    for (const ch of code1) {
      expect(PUBLIC_CODE_ALPHABET.includes(ch)).toBe(true);
    }

    // 2. Retry test on collision:
    // Spy on publicCodeHelper.generate to return code1 on the first call (causing duplicate key error 11000),
    // and then a fresh code on the retry call.
    const spy = vi.spyOn(publicCodeHelper, 'generate');
    const freshCode = '9Z8Y7X6W5V';
    spy.mockReturnValueOnce(code1).mockReturnValueOnce(freshCode);

    const ticketRes2 = await api('post', '/api/repairs', owner.token).send({
      customerId: custRes.body.data._id,
      device: { brand: 'Xiaomi', model: '13 Pro' },
      faultDescription: 'Retry collision test',
    });

    expect(ticketRes2.status).toBe(201);
    expect(ticketRes2.body.data.publicCode).toBe(freshCode);
    expect(spy).toHaveBeenCalledTimes(2);

    spy.mockRestore();
  });
});

