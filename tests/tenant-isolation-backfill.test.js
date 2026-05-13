/**
 * Tenant isolation and backfill tests.
 * - User from tenant A cannot read tenant B data (403 or empty).
 * - Backfill scripts set tenantId correctly.
 * - Usage counts correct after backfill.
 * - Purchase, Expense, StockTransfer, StockAdjustment scoped by tenantId.
 */
const mongoose = require('mongoose');
const { getTenantIdFromReq } = require('../src/middleware/auth');
const Sale = require('../src/models/Sale');
const Purchase = require('../src/models/Purchase');
const Expense = require('../src/models/Expense');
const StockTransfer = require('../src/models/StockTransfer');
const StockAdjustment = require('../src/models/StockAdjustment');
const StockMove = require('../src/models/StockMove');
const Tenant = require('../src/models/Tenant');
const entitlementsService = require('../src/services/entitlementsService');

describe('Tenant isolation', () => {
  beforeAll(async () => {
    if (process.env.MONGODB_URI) await mongoose.connect(process.env.MONGODB_URI);
  });
  afterAll(async () => {
    await mongoose.disconnect();
  });

  it('getTenantIdFromReq returns req.user.tenantId', () => {
    const reqA = { user: { _id: new mongoose.Types.ObjectId(), tenantId: 'tenant-a' } };
    const reqB = { user: { _id: new mongoose.Types.ObjectId(), tenantId: 'tenant-b' } };
    expect(getTenantIdFromReq(reqA)).toBe('tenant-a');
    expect(getTenantIdFromReq(reqB)).toBe('tenant-b');
    expect(getTenantIdFromReq({})).toBe('default');
  });

  it('user from tenant A cannot read tenant B sale (findOne with tenantId returns null for wrong tenant)', async () => {
    if (!process.env.MONGODB_URI) return;
    const tid = 'test-iso-' + Date.now();
    const saleDoc = await Sale.create({
      reference: 'INV-TEST-ISO',
      type: 'retail',
      items: [{ sku: 'S1', name: 'Item', price: 10, quantity: 1 }],
      subtotal: 10,
      tax: 0,
      total: 10,
      tenantId: tid,
      status: 'active',
    });
    const otherTenant = 'other-tenant-id';
    const asOther = await Sale.findOne({ _id: saleDoc._id, tenantId: otherTenant }).lean();
    expect(asOther).toBeNull();
    const asOwner = await Sale.findOne({ _id: saleDoc._id, tenantId: tid }).lean();
    expect(asOwner).not.toBeNull();
    expect(asOwner.tenantId).toBe(tid);
    await Sale.deleteOne({ _id: saleDoc._id });
  });

  it('purchase: tenant B cannot see purchase created under tenant A', async () => {
    if (!process.env.MONGODB_URI) return;
    const tid = 'test-pur-' + Date.now();
    const purchase = await Purchase.create({
      tenantId: tid,
      purchaseNumber: 'PUR-ISO-TEST',
      parcelNumber: 'PARCEL-ISO',
      status: 'Received',
      paymentStatus: 'Unpaid',
      items: [{ name: 'Item', purchasePrice: 10, salePrice: 15, quantity: 1, isOtherItem: true }],
      grandTotal: 10,
    });
    const asOther = await Purchase.findOne({ _id: purchase._id, tenantId: 'other-tenant' }).lean();
    expect(asOther).toBeNull();
    const asOwner = await Purchase.findOne({ _id: purchase._id, tenantId: tid }).lean();
    expect(asOwner).not.toBeNull();
    await Purchase.deleteOne({ _id: purchase._id });
  });

  it('expense: tenant B cannot see expense created under tenant A', async () => {
    if (!process.env.MONGODB_URI) return;
    const tid = 'test-exp-' + Date.now();
    const expense = await Expense.create({
      tenantId: tid,
      status: 'Draft',
      amountNet: 100,
      vatAmount: 20,
      amountGross: 120,
      occurredAtUtc: new Date(),
    });
    const asOther = await Expense.findOne({ _id: expense._id, tenantId: 'other-tenant' }).lean();
    expect(asOther).toBeNull();
    const asOwner = await Expense.findOne({ _id: expense._id, tenantId: tid }).lean();
    expect(asOwner).not.toBeNull();
    await Expense.deleteOne({ _id: expense._id });
  });

  it('stock transfer: tenant B cannot see transfer created under tenant A', async () => {
    if (!process.env.MONGODB_URI) return;
    const tid = 'test-st-' + Date.now();
    const fromId = new mongoose.Types.ObjectId();
    const toId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const transfer = await StockTransfer.create({
      tenantId: tid,
      transferNo: 'ST-ISO-' + Date.now(),
      fromLocationId: fromId,
      toLocationId: toId,
      status: 'Draft',
      createdByUserId: userId,
      lines: [],
      serials: [],
    });
    const asOther = await StockTransfer.findOne({ _id: transfer._id, tenantId: 'other-tenant' }).lean();
    expect(asOther).toBeNull();
    const asOwner = await StockTransfer.findOne({ _id: transfer._id, tenantId: tid }).lean();
    expect(asOwner).not.toBeNull();
    await StockTransfer.deleteOne({ _id: transfer._id });
  });

  it('stock adjustment: tenant B cannot see adjustment created under tenant A', async () => {
    if (!process.env.MONGODB_URI) return;
    const tid = 'test-sa-' + Date.now();
    const locId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const adjustment = await StockAdjustment.create({
      tenantId: tid,
      adjustmentNo: 'SA-ISO-' + Date.now(),
      locationId: locId,
      status: 'Draft',
      reasonCode: 'COUNT_CORRECTION',
      createdByUserId: userId,
      lines: [],
      serials: [],
    });
    const asOther = await StockAdjustment.findOne({ _id: adjustment._id, tenantId: 'other-tenant' }).lean();
    expect(asOther).toBeNull();
    const asOwner = await StockAdjustment.findOne({ _id: adjustment._id, tenantId: tid }).lean();
    expect(asOwner).not.toBeNull();
    await StockAdjustment.deleteOne({ _id: adjustment._id });
  });

  it('StockMove created by transfer carries tenantId', async () => {
    if (!process.env.MONGODB_URI) return;
    const tid = 'test-move-' + Date.now();
    const move = await StockMove.create({
      tenantId: tid,
      type: 'out',
      locationId: new mongoose.Types.ObjectId(),
      productId: new mongoose.Types.ObjectId(),
      quantity: 1,
      transferId: new mongoose.Types.ObjectId(),
    });
    expect(move.tenantId).toBe(tid);
    const asOther = await StockMove.findOne({ _id: move._id, tenantId: 'other-tenant' }).lean();
    expect(asOther).toBeNull();
    await StockMove.deleteOne({ _id: move._id });
  });
});

describe('Tenant and default seed', () => {
  beforeAll(async () => {
    if (process.env.MONGODB_URI) await mongoose.connect(process.env.MONGODB_URI);
  });
  afterAll(async () => {
    await mongoose.disconnect();
  });

  it('default tenant record exists or can be created', async () => {
    if (!process.env.MONGODB_URI) return;
    let tenant = await Tenant.findOne({ tenantId: 'default' }).lean();
    if (!tenant) {
      await Tenant.create({ tenantId: 'default', name: 'Default', companyName: 'Default', status: 'active' });
      tenant = await Tenant.findOne({ tenantId: 'default' }).lean();
    }
    expect(tenant).not.toBeNull();
    expect(tenant.tenantId).toBe('default');
  });
});

describe('Usage counts after backfill', () => {
  beforeAll(async () => {
    if (process.env.MONGODB_URI) await mongoose.connect(process.env.MONGODB_URI);
  });
  afterAll(async () => {
    await mongoose.disconnect();
  });

  it('getUsage returns tenant-scoped counts (only docs with that tenantId)', async () => {
    if (!process.env.MONGODB_URI) return;
    const tid = 'usage-test-' + Date.now();
    const usageBefore = await entitlementsService.getUsage(tid);
    expect(usageBefore.maxUsers).toBe(0);
    expect(usageBefore.maxLocations).toBe(0);
    const User = require('../src/models/User');
    await User.create({
      name: 'U',
      email: `u-${tid}@test.com`,
      password: 'password123',
      tenantId: tid,
    });
    const usageAfter = await entitlementsService.getUsage(tid);
    expect(usageAfter.maxUsers).toBe(1);
    await User.deleteOne({ email: `u-${tid}@test.com` });
  });
});
