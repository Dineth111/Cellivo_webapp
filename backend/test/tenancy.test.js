import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { startDb, stopDb, resetDb } from './helpers.js';
import tenantPlugin from '../src/core/tenantPlugin.js';
import { runWithContext, runAsPlatform } from '../src/core/tenantContext.js';

const schema = new mongoose.Schema({ name: String });
schema.plugin(tenantPlugin);
const Widget = mongoose.model('Widget', schema);

const A = new mongoose.Types.ObjectId();
const B = new mongoose.Types.ObjectId();
const asA = (fn) => runWithContext({ tenantId: A }, async () => await fn());
const asB = (fn) => runWithContext({ tenantId: B }, async () => await fn());

beforeAll(startDb);
afterAll(stopDb);
beforeEach(resetDb);

describe('tenant plugin', () => {
  it('sets tenantId on create and scopes reads', async () => {
    const w = await asA(() => Widget.create({ name: 'a' }));
    expect(w.tenantId.equals(A)).toBe(true);
    await asB(() => Widget.create({ name: 'b' }));
    expect(await asA(() => Widget.find())).toHaveLength(1);
    expect(await asA(() => Widget.countDocuments())).toBe(1);
  });

  it('throws without a tenant context', async () => {
    await expect(Widget.find()).rejects.toThrow(/Tenant context missing/);
    await expect(Widget.create({ name: 'x', tenantId: A })).rejects.toThrow(/Tenant context missing/);
    await expect(Widget.aggregate([{ $match: {} }])).rejects.toThrow(/Tenant context missing/);
    await expect(Widget.insertMany([{ name: 'x' }])).rejects.toThrow(/Tenant context missing/);
  });

  it('other tenant cannot read, update, delete or aggregate', async () => {
    const w = await asA(() => Widget.create({ name: 'secret' }));
    expect(await asB(() => Widget.findById(w._id))).toBeNull();
    expect(await asB(() => Widget.findByIdAndUpdate(w._id, { name: 'hacked' }))).toBeNull();
    expect((await asB(() => Widget.updateMany({}, { name: 'hacked' }))).matchedCount).toBe(0);
    expect((await asB(() => Widget.deleteMany({}))).deletedCount).toBe(0);
    expect(await asB(() => Widget.aggregate([{ $group: { _id: null, n: { $sum: 1 } } }]))).toEqual([]);
    // An explicit tenantId in the filter cannot override the context.
    expect(await asB(() => Widget.find({ tenantId: A }))).toEqual([]);
    expect((await asA(() => Widget.findById(w._id))).name).toBe('secret');
  });

  it('cannot move a document to another tenant', async () => {
    const w = await asA(() => Widget.create({ name: 'a' }));
    await asA(() => Widget.updateOne({ _id: w._id }, { $set: { tenantId: B } }));
    expect((await runAsPlatform(async () => await Widget.findById(w._id))).tenantId.equals(A)).toBe(true);
    await expect(asB(() => Widget.create({ name: 'x', tenantId: A }))).rejects.toThrow(/Cross-tenant/);
  });

  it('platform mode is unscoped; bulkWrite blocked for tenants', async () => {
    await asA(() => Widget.create({ name: 'a' }));
    await asB(() => Widget.create({ name: 'b' }));
    expect(await runAsPlatform(async () => await Widget.find())).toHaveLength(2);
    await expect(asA(() => Widget.bulkWrite([]))).rejects.toThrow(/not allowed/);
  });
});
