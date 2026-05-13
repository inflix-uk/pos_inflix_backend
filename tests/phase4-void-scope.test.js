/**
 * Phase 4: Sale void (soft delete) and user location scope.
 * - Sale status voided, idempotent void (400 on second void)
 * - getUserLocationScope: admin -> null, else assignedLocationIds
 * - Scope applied to dashboard
 */

const mongoose = require('mongoose');
const Sale = require('../src/models/Sale');
const { getUserLocationScope } = require('../src/utils/dashboardHelpers');
const salesController = require('../src/controllers/salesController');

describe('Sale void (soft delete)', () => {
  it('Sale schema has status, voidedAtUtc, voidedByUserId, voidReason', () => {
    expect(Sale.schema.path('status')).toBeDefined();
    expect(Sale.schema.path('status').enumValues).toContain('active');
    expect(Sale.schema.path('status').enumValues).toContain('voided');
    expect(Sale.schema.path('voidedAtUtc')).toBeDefined();
    expect(Sale.schema.path('voidedByUserId')).toBeDefined();
    expect(Sale.schema.path('voidReason')).toBeDefined();
  });

  it('idempotent void: second void returns 400', async () => {
    if (!process.env.MONGODB_URI) return;
    const sale = await Sale.create({
      type: 'retail',
      items: [{ sku: 'VOID-TEST', name: 'Item', price: 10, quantity: 1 }],
      subtotal: 10,
      total: 10,
      paymentMethod: 'cash',
      status: 'voided',
      voidedAtUtc: new Date(),
    });
    const req = {
      params: { id: sale._id.toString() },
      body: { voidReason: 'Duplicate' },
      user: { id: new mongoose.Types.ObjectId() },
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    await salesController.deleteSale(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, message: 'Sale is already voided' }));
    const still = await Sale.findById(sale._id).lean();
    expect(still.status).toBe('voided');
    await Sale.deleteOne({ _id: sale._id });
  });
});

describe('getUserLocationScope', () => {
  it('returns null for admin', () => {
    expect(getUserLocationScope({ role: 'admin' })).toBeNull();
  });

  it('returns null for null user', () => {
    expect(getUserLocationScope(null)).toBeNull();
  });

  it('returns null when assignedLocationIds empty or missing', () => {
    expect(getUserLocationScope({ role: 'cashier' })).toBeNull();
    expect(getUserLocationScope({ role: 'cashier', assignedLocationIds: [] })).toBeNull();
  });

  it('returns array of id strings for non-admin with assignedLocationIds', () => {
    const id1 = new mongoose.Types.ObjectId();
    const id2 = new mongoose.Types.ObjectId();
    const scope = getUserLocationScope({
      role: 'manager',
      assignedLocationIds: [id1, id2],
    });
    expect(scope).toEqual([id1.toString(), id2.toString()]);
  });
});
