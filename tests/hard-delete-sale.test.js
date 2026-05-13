/**
 * Admin-only hard delete sale.
 * - Non-admin calling DELETE /:id/hard -> 403
 * - Admin with wrong confirmInvoiceRef -> 400
 * - Admin with correct confirm -> 200, sale permanently deleted
 * - Metrics decrement only when sale was active
 */

const mongoose = require('mongoose');
const Sale = require('../src/models/Sale');
const salesController = require('../src/controllers/salesController');
const TenantDailyMetric = require('../src/models/TenantDailyMetric');
const metricsService = require('../src/services/metricsService');
const activityLogService = require('../src/services/activityLogService');
const { getLondonDateKey } = require('../src/utils/dateKey');

describe('hardDeleteSale', () => {
  beforeAll(async () => {
    if (process.env.MONGODB_URI) await mongoose.connect(process.env.MONGODB_URI);
  });
  afterAll(async () => {
    await mongoose.disconnect();
  });

  it('non-admin receives 403', async () => {
    if (!process.env.MONGODB_URI) return;
    const sale = await Sale.create({
      type: 'retail',
      items: [{ sku: 'HARD-DEL', name: 'Item', price: 10, quantity: 1 }],
      subtotal: 10,
      total: 10,
      paymentMethod: 'cash',
    });
    const ref = sale.reference;
    const req = {
      params: { id: sale._id.toString() },
      body: { confirmInvoiceRef: ref },
      user: { id: new mongoose.Types.ObjectId(), role: 'cashier' },
      headers: {},
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await salesController.hardDeleteSale(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, message: expect.stringContaining('admin') }));
    const still = await Sale.findById(sale._id).lean();
    expect(still).toBeDefined();
    await Sale.deleteOne({ _id: sale._id });
  });

  it('admin with wrong confirmInvoiceRef receives 400', async () => {
    if (!process.env.MONGODB_URI) return;
    const sale = await Sale.create({
      type: 'retail',
      items: [{ sku: 'HARD-DEL2', name: 'Item', price: 10, quantity: 1 }],
      subtotal: 10,
      total: 10,
      paymentMethod: 'cash',
    });
    const req = {
      params: { id: sale._id.toString() },
      body: { confirmInvoiceRef: 'WRONG-REF' },
      user: { id: new mongoose.Types.ObjectId(), role: 'admin' },
      headers: {},
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await salesController.hardDeleteSale(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, message: expect.stringContaining('Confirmation') }));
    const still = await Sale.findById(sale._id).lean();
    expect(still).toBeDefined();
    await Sale.deleteOne({ _id: sale._id });
  });

  it('admin with correct confirm deletes sale and returns 200', async () => {
    if (!process.env.MONGODB_URI) return;
    const sale = await Sale.create({
      type: 'retail',
      items: [{ sku: 'HARD-DEL3', name: 'Item', price: 10, quantity: 1 }],
      subtotal: 10,
      total: 10,
      paymentMethod: 'cash',
    });
    const ref = sale.reference;
    const req = {
      params: { id: sale._id.toString() },
      body: { confirmInvoiceRef: ref },
      user: { id: new mongoose.Types.ObjectId(), role: 'admin' },
      headers: {},
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await salesController.hardDeleteSale(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, message: expect.stringContaining('permanently deleted'), data: expect.any(Object) }));
    const gone = await Sale.findById(sale._id).lean();
    expect(gone).toBeNull();
  });

  it('metrics decrement only when sale was active', async () => {
    if (!process.env.MONGODB_URI) return;
    const redis = require('../src/lib/redis');
    const tid = redis.getTenantId ? redis.getTenantId() : 'default';
    const locationId = new mongoose.Types.ObjectId();
    const eventDate = new Date();
    const dateKey = getLondonDateKey(eventDate);
    await metricsService.incrementSaleCreated(tid, locationId, 50, eventDate);
    const sale = await Sale.create({
      type: 'retail',
      items: [{ sku: 'HARD-DEL4', name: 'Item', price: 50, quantity: 1 }],
      subtotal: 50,
      total: 50,
      paymentMethod: 'cash',
      locationId,
      status: 'active',
    });
    const ref = sale.reference;
    const before = await TenantDailyMetric.findOne({ tenantId: tid, dateKey }).lean();
    expect(before).toBeDefined();
    expect(before.salesRevenueGross).toBeGreaterThanOrEqual(50);

    const req = {
      params: { id: sale._id.toString() },
      body: { confirmInvoiceRef: ref },
      user: { id: new mongoose.Types.ObjectId(), role: 'admin' },
      headers: {},
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await salesController.hardDeleteSale(req, res);
    expect(res.status).toHaveBeenCalledWith(200);

    const after = await TenantDailyMetric.findOne({ tenantId: tid, dateKey }).lean();
    expect(after.salesRevenueGross).toBe(before.salesRevenueGross - 50);
    expect(after.salesCount).toBe(before.salesCount - 1);
  });

  it('audit event SALE_HARD_DELETED is created', async () => {
    if (!process.env.MONGODB_URI) return;
    const logSpy = jest.spyOn(activityLogService, 'logFromReq').mockResolvedValue(undefined);
    const sale = await Sale.create({
      type: 'retail',
      items: [{ sku: 'HARD-DEL5', name: 'Item', price: 5, quantity: 1 }],
      subtotal: 5,
      total: 5,
      paymentMethod: 'cash',
    });
    const ref = sale.reference;
    const req = {
      params: { id: sale._id.toString() },
      body: { confirmInvoiceRef: ref },
      user: { id: new mongoose.Types.ObjectId(), role: 'admin' },
      headers: {},
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await salesController.hardDeleteSale(req, res);
    expect(logSpy).toHaveBeenCalledWith(req, expect.objectContaining({
      action: 'SALE_HARD_DELETED',
      entityType: 'Sale',
      invoiceNo: ref,
      beforeJson: expect.any(Object),
      metaJson: expect.objectContaining({ hardDeletedAt: expect.any(String) }),
    }));
    logSpy.mockRestore();
    const gone = await Sale.findById(sale._id).lean();
    expect(gone).toBeNull();
  });
});
