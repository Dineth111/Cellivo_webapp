// Fills the demo shop (Demo Mobile) with presentation data: products, IMEI phones, suppliers, stock, customers,
// sales, repairs, expenses. Everything goes through the real services, so stock, ledger and dashboards agree.
// Run `npm run seed` first (creates the shop and users), then `npm run seed:demo`. Safe to re-run: skipped if products exist.
import mongoose from 'mongoose';
import { assertConfig, config } from './core/config.js';
import connectDB from './core/db.js';
import { runAsPlatform, runWithContext } from './core/tenantContext.js';
import User from './modules/users/User.model.js';
import Role from './modules/roles/Role.model.js';
import Branch from './modules/branches/Branch.model.js';
import Customer from './modules/customers/Customer.model.js';
import Brand from './modules/inventory/models/Brand.model.js';
import Category from './modules/inventory/models/Category.model.js';
import Product from './modules/inventory/models/Product.model.js';
import Supplier from './modules/inventory/models/Supplier.model.js';
import Invoice from './modules/pos/models/Invoice.model.js';
import * as purchasing from './modules/inventory/services/purchasing.service.js';
import * as sales from './modules/pos/services/sale.service.js';
import * as finance from './modules/pos/services/finance.service.js';
import * as repairs from './modules/repairs/services/repairs.service.js';

if (config.env === 'production') {
  console.error('Refusing to seed demo data when NODE_ENV=production.');
  process.exit(1);
}
assertConfig();

const rs = (n) => n * 100; // rupees -> cents
const pick = (arr, i) => arr[i % arr.length];
let seedN = 7;
const rand = () => ((seedN = (seedN * 16807) % 2147483647) / 2147483647); // deterministic, so re-seeding looks the same
const randInt = (a, b) => a + Math.floor(rand() * (b - a + 1));

function luhnImei(body14) {
  let sum = 0;
  [...body14].reverse().forEach((ch, i) => {
    let d = Number(ch);
    if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  });
  return body14 + String((10 - (sum % 10)) % 10);
}
let imeiCounter = 35000000000000;
const nextImei = () => luhnImei(String(imeiCounter += 7919));

const step = async (label, fn) => {
  try { return await fn(); } catch (e) { console.warn(`  ! ${label}: ${e.message}`); return null; }
};

await connectDB();

const owner = await runAsPlatform(async () => User.findOne({ email: 'owner@cellivo.lk' }));
if (!owner) { console.error('Demo shop not found. Run `npm run seed` first.'); process.exit(1); }
const tenantId = owner.tenantId;

await runWithContext({ tenantId }, async () => {
  if (await Product.exists({})) { console.log('skip    demo data already exists'); return; }

  const branch = await Branch.findOne();
  const branchId = branch._id;
  const ownerRole = await Role.findOne({ key: 'owner' }).lean();
  const techUser = await User.findOne({ email: 'technician@cellivo.lk' });
  const user = { _id: owner._id, role: ownerRole };

  // ---- catalogue ----
  const cat = Object.fromEntries(await Promise.all(['Phones', 'Accessories', 'Spare Parts'].map(async (n) => [n, await Category.create({ name: n })])));
  const brandNames = ['Apple', 'Samsung', 'Xiaomi', 'OPPO', 'Vivo', 'Realme', 'Google', 'Anker', 'Generic'];
  const brand = Object.fromEntries(await Promise.all(brandNames.map(async (n) => [n, await Brand.create({ name: n })])));

  const phones = [
    ['iPhone 15 128GB', 'Apple', 265000, 295000, 'Black', '128GB'],
    ['iPhone 14 128GB', 'Apple', 210000, 235000, 'Blue', '128GB'],
    ['Samsung Galaxy S24', 'Samsung', 240000, 270000, 'Violet', '256GB'],
    ['Samsung Galaxy A55', 'Samsung', 95000, 112000, 'Navy', '128GB'],
    ['Samsung Galaxy A15', 'Samsung', 42000, 51000, 'Black', '128GB'],
    ['Redmi Note 13', 'Xiaomi', 52000, 62000, 'Blue', '128GB'],
    ['Redmi 13C', 'Xiaomi', 29000, 36000, 'Green', '64GB'],
    ['OPPO A58', 'OPPO', 43000, 52000, 'Gold', '128GB'],
    ['Vivo Y28', 'Vivo', 38000, 47000, 'Green', '128GB'],
    ['Realme C67', 'Realme', 41000, 50000, 'Black', '128GB'],
    ['Google Pixel 8', 'Google', 185000, 215000, 'Obsidian', '128GB'],
  ];
  const others = [
    ['Tempered Glass (universal)', 'Accessories', 'Generic', 150, 600, 80],
    ['Silicone Back Cover', 'Accessories', 'Generic', 250, 900, 60],
    ['Fast Charger 25W', 'Accessories', 'Samsung', 1800, 3200, 30],
    ['USB-C Cable 1m', 'Accessories', 'Anker', 600, 1500, 50],
    ['Lightning Cable 1m', 'Accessories', 'Generic', 700, 1800, 40],
    ['Wireless Earbuds', 'Accessories', 'Xiaomi', 3800, 6500, 25],
    ['Power Bank 10000mAh', 'Accessories', 'Anker', 4200, 7200, 4],
    ['Bluetooth Speaker', 'Accessories', 'Generic', 3500, 5900, 12],
    ['Phone Stand', 'Accessories', 'Generic', 400, 1100, 30],
    ['Memory Card 64GB', 'Accessories', 'Generic', 1400, 2400, 3],
    ['Car Charger', 'Accessories', 'Generic', 500, 1300, 20],
    ['Battery (universal Li-ion)', 'Spare Parts', 'Generic', 1500, 3200, 25],
    ['Charging Port Flex', 'Spare Parts', 'Generic', 600, 1800, 30],
    ['iPhone 13 Screen', 'Spare Parts', 'Apple', 14000, 22000, 6],
    ['Samsung A-series Screen', 'Spare Parts', 'Samsung', 9500, 16000, 8],
  ];

  let bc = 100000;
  const phoneProducts = [];
  for (const [name, b, cost, sell, colour, storage] of phones) {
    const p = await Product.create({
      name, barcode: `CEL${++bc}`, sku: `PH-${bc}`, categoryId: cat.Phones._id, brandId: brand[b]._id, isSerialised: true,
      variantAttributes: { color: colour, storage }, costPriceCents: rs(cost), sellingPriceCents: rs(sell), wholesalePriceCents: rs(Math.round((cost + sell) / 2)), reorderLevel: 3,
    });
    phoneProducts.push(p);
  }
  const otherProducts = [];
  for (const [name, c, b, cost, sell, qty] of others) {
    const p = await Product.create({
      name, barcode: `CEL${++bc}`, sku: `AC-${bc}`, categoryId: cat[c]._id, brandId: brand[b]._id, isSerialised: false,
      costPriceCents: rs(cost), sellingPriceCents: rs(sell), reorderLevel: 10,
    });
    otherProducts.push({ product: p, qty });
  }
  console.log(`created ${phoneProducts.length + otherProducts.length} products`);

  // ---- suppliers + stock in (GRN) ----
  const supplierData = [
    ['Lanka Mobile Distributors', 'Chaminda Rathnayake', '0112345678'],
    ['TechWorld Imports', 'Priya Nadesan', '0112876543'],
    ['Smart Parts Lanka', 'Farook Hameed', '0114567890'],
  ];
  const suppliers = [];
  for (const [name, contactPerson, phone] of supplierData) {
    suppliers.push(await Supplier.create({ name, contactPerson, phone, email: `${name.split(' ')[0].toLowerCase()}@example.lk`, address: 'Colombo', paymentTermsDays: 30 }));
  }

  const imeisByProduct = new Map();
  for (const [i, p] of phoneProducts.entries()) {
    const qty = i < 2 ? 6 : randInt(4, 8);
    const imeis = Array.from({ length: qty }, nextImei);
    imeisByProduct.set(String(p._id), [...imeis]);
    await step(`GRN ${p.name}`, () => purchasing.createGrn({
      tenantId, branchId, supplierId: suppliers[i % 2]._id, paymentType: 'credit', userId: owner._id,
      items: [{ productId: p._id, qty, unitCostCents: p.costPriceCents, imeis }],
    }));
  }
  for (const [i, { product, qty }] of otherProducts.entries()) {
    const sup = product.categoryId.equals(cat['Spare Parts']._id) ? suppliers[2] : suppliers[i % 2];
    await step(`GRN ${product.name}`, () => purchasing.createGrn({
      tenantId, branchId, supplierId: sup._id, paymentType: 'credit', userId: owner._id,
      items: [{ productId: product._id, qty, unitCostCents: product.costPriceCents }],
    }));
  }
  await step('purchase order', () => purchasing.createPurchaseOrder({
    tenantId, branchId, supplierId: suppliers[0]._id, userId: owner._id, notes: 'Weekend restock',
    items: [{ productId: phoneProducts[0]._id, qty: 5 }, { productId: phoneProducts[2]._id, qty: 4 }],
  }));
  await step('supplier payment', () => purchasing.paySupplier({
    tenantId, branchId, supplierId: suppliers[0]._id, amountCents: rs(500000), paymentMethod: 'bank_transfer', reference: 'TRF-1001', userId: owner._id,
  }));

  // ---- customers ----
  const people = [
    ['Nimal Perera', 'retail'], ['Kamal Fernando', 'retail'], ['Sanduni Silva', 'retail'], ['Ayesha Rahman', 'retail'],
    ['Tharindu Jayawardena', 'retail'], ['Dilshan Wickramasinghe', 'retail'], ['Nadeeka Gunasekara', 'retail'], ['Roshan De Mel', 'retail'],
    ['Priyanka Dissanayake', 'retail'], ['Mohamed Faizal', 'retail'], ['Chathura Bandara', 'retail'], ['Hiruni Senanayake', 'retail'],
    ['Lanka Gadget Hub', 'wholesale'], ['Kandy Mobile World', 'wholesale'], ['Galle Phone Centre', 'wholesale'],
  ];
  const customers = [];
  for (const [i, [name, type]] of people.entries()) {
    customers.push(await Customer.create({
      name, type, phone: `07${[1, 2, 5, 6, 7, 8][i % 6]}${String(2000000 + i * 137531).slice(0, 7)}`,
      email: `${name.split(' ')[0].toLowerCase()}${i}@example.lk`, address: 'Sri Lanka', marketingOptIn: i % 3 !== 0,
      creditLimitCents: type === 'wholesale' ? rs(1000000) : 0, tags: type === 'wholesale' ? ['wholesale'] : [],
    }));
  }
  console.log(`created ${customers.length} customers`);

  // ---- sales over the last 14 days ----
  await step('open drawer', () => finance.openSession({ tenantId, branchId, userId: owner._id, openingFloatCents: rs(20000) }));
  const methods = ['cash', 'cash', 'card', 'bank_transfer'];
  const accessoryProducts = otherProducts.filter((o) => o.product.categoryId.equals(cat.Accessories._id)).map((o) => o.product);
  let made = 0;
  for (let n = 0; n < 34; n++) {
    const lines = [];
    let total = 0;
    if (rand() < 0.55) {
      const p = pick(phoneProducts, randInt(0, phoneProducts.length - 1));
      const list = imeisByProduct.get(String(p._id));
      const imei = list?.pop();
      if (imei) { lines.push({ imei, qty: 1, name: p.name, productId: p._id }); total += p.sellingPriceCents; }
    }
    if (!lines.length || rand() < 0.5) {
      const a = pick(accessoryProducts, randInt(0, accessoryProducts.length - 1));
      const qty = randInt(1, 3);
      lines.push({ barcode: a.barcode, qty, name: a.name, productId: a._id });
      total += a.sellingPriceCents * qty;
    }
    const wholesale = n % 11 === 5;
    const customer = wholesale ? pick(customers.filter((c) => c.type === 'wholesale'), n) : rand() < 0.6 ? pick(customers.filter((c) => c.type === 'retail'), n) : null;
    const payments = wholesale && customer
      ? [{ method: 'cash', amountCents: Math.round(total * 0.3) }, { method: 'credit', amountCents: total - Math.round(total * 0.3) }]
      : [{ method: pick(methods, n), amountCents: total }];
    const inv = await step(`sale ${n + 1}`, () => sales.completeSale({
      tenantId, branchId, userId: owner._id, userRole: ownerRole, idempotencyKey: `demo-sale-${n}`,
      data: { customerId: customer?._id || null, lines, payments },
    }));
    if (!inv) continue;
    made++;
    const daysAgo = n < 8 ? 0 : randInt(1, 13); // keep the first few "today" so the dashboard has live numbers
    if (daysAgo) {
      const at = new Date(Date.now() - daysAgo * 864e5 - randInt(0, 8) * 36e5);
      await Invoice.collection.updateOne({ _id: inv._id }, { $set: { createdAt: at, updatedAt: at } });
    }
  }
  console.log(`created ${made} sales`);

  // ---- expenses ----
  for (const [category, payee, amt] of [['Rent', 'Landlord', 85000], ['Electricity', 'CEB', 14500], ['Staff lunch', 'Canteen', 3200], ['Packaging', 'Print House', 6800]]) {
    await step(`expense ${category}`, () => finance.recordExpense({ tenantId, branchId, userId: owner._id, data: { category, amountCents: rs(amt), payee, paymentMethod: 'cash' } }));
  }

  // ---- repairs, one per stage ----
  const faults = [
    ['Samsung', 'Galaxy A32', 'Cracked screen'], ['Apple', 'iPhone 11', 'Battery drains fast'], ['Xiaomi', 'Redmi Note 10', 'Not charging'],
    ['OPPO', 'A74', 'Water damage, will not power on'], ['Apple', 'iPhone 13', 'Back glass broken'], ['Vivo', 'Y21', 'Speaker not working'],
    ['Samsung', 'Galaxy S21', 'Touch not responding'], ['Realme', '8i', 'Camera blurry'], ['Huawei', 'P30', 'Boot loop'], ['Apple', 'iPhone XR', 'Face ID failure'],
  ];
  const stagePath = {
    Received: [], Diagnosing: ['Diagnosing'], 'Waiting approval': ['Diagnosing', 'Waiting approval'],
    'In repair': ['Diagnosing', 'Waiting approval', 'approve', 'In repair'], 'Quality check': ['Diagnosing', 'Waiting approval', 'approve', 'In repair', 'Quality check'],
    Ready: ['Diagnosing', 'Waiting approval', 'approve', 'In repair', 'Quality check', 'Ready'],
    Delivered: ['Diagnosing', 'Waiting approval', 'approve', 'In repair', 'Quality check', 'Ready', 'settle', 'Delivered'],
    Unrepairable: ['Diagnosing', 'Unrepairable'],
  };
  const targets = ['Received', 'Diagnosing', 'Waiting approval', 'In repair', 'In repair', 'Quality check', 'Ready', 'Ready', 'Delivered', 'Unrepairable'];
  for (const [i, [b, model, fault]] of faults.entries()) {
    const customer = customers[i];
    const created = await step(`repair ${i + 1}`, () => repairs.createTicket({
      tenantId, branchId, customerId: customer._id, user,
      device: { brand: b, model, colour: pick(['Black', 'Blue', 'White'], i), imei: luhnImei(String(35900000000000 + i * 4231)) },
      accessories: i % 2 ? ['SIM tray'] : [], conditionNotes: 'Minor scratches on frame', faultDescription: fault,
      estimateCents: rs(randInt(30, 180) * 100), advanceCents: i % 3 === 0 ? rs(2000) : 0, promisedDate: new Date(Date.now() + (i - 3) * 864e5),
      technicianId: techUser?._id || null,
    }));
    const ticket = created?.ticket ?? created;
    if (!ticket?._id) continue;
    for (const s of stagePath[targets[i]]) {
      const ok = await step(`repair ${i + 1} -> ${s}`, async () => {
        if (s === 'approve') return repairs.recordApproval({ tenantId, ticketId: ticket._id, decision: 'approved', user });
        if (s === 'settle') return repairs.settleInvoice({ tenantId, ticketId: ticket._id, paymentMethod: 'cash', user });
        return repairs.changeStage({ tenantId, ticketId: ticket._id, to: s, user });
      });
      if (ok === null) break;
    }
  }
  console.log('created repair tickets');
});

console.log('\nDemo data ready. Log in with owner@cellivo.lk / Cellivo@123');
await mongoose.disconnect();
process.exit(0);
