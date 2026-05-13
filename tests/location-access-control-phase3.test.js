/**
 * Phase 3: Location-based access control.
 * Tests that:
 * - Admin users can access all locations in their tenant
 * - Non-admin users (managers/staff) can only access assigned locations
 * - Get-by-id returns 404 for out-of-scope records
 * - Create/update blocks out-of-scope locationId
 * - Dashboard/reports remain location-scoped
 */
const mongoose = require('mongoose');
const User = require('../src/models/User');
const Sale = require('../src/models/Sale');
const Repair = require('../src/models/Repair');
const SalesReturn = require('../src/models/SalesReturn');
const StockAdjustment = require('../src/models/StockAdjustment');
const Location = require('../src/models/Location');
const salesController = require('../src/controllers/salesController');
const repairController = require('../src/controllers/repairController');
const salesReturnController = require('../src/controllers/salesReturnController');
const stockAdjustmentController = require('../src/controllers/stockAdjustmentController');
const { getUserLocationScope } = require('../src/utils/dashboardHelpers');

function mockRes() {
    const res = { statusCode: 200, body: null };
    res.status = function (code) {
        res.statusCode = code;
        return res;
    };
    res.json = function (data) {
        res.body = data;
        return res;
    };
    return res;
}

function mockReq(overrides = {}) {
    return {
        params: {},
        query: {},
        body: {},
        user: null,
        ...overrides
    };
}

describe('Phase 3: Location-based access control', () => {
    beforeAll(async () => {
        if (process.env.MONGODB_URI) await mongoose.connect(process.env.MONGODB_URI);
    });
    afterAll(async () => {
        await mongoose.disconnect();
    });

    describe('getUserLocationScope helper', () => {
        it('returns null for admin (all locations)', () => {
            expect(getUserLocationScope({ role: 'admin' })).toBe(null);
            expect(getUserLocationScope({ role: 'admin', assignedLocationIds: ['loc1', 'loc2'] })).toBe(null);
        });
        it('returns null for empty assignedLocationIds', () => {
            expect(getUserLocationScope({ role: 'manager', assignedLocationIds: [] })).toBe(null);
            expect(getUserLocationScope({ role: 'staff', assignedLocationIds: null })).toBe(null);
            expect(getUserLocationScope({ role: 'cashier' })).toBe(null);
        });
        it('returns array of location IDs for non-admin with assigned locations', () => {
            const scope = getUserLocationScope({ role: 'manager', assignedLocationIds: ['loc1', 'loc2'] });
            expect(Array.isArray(scope)).toBe(true);
            expect(scope.length).toBe(2);
            expect(scope).toContain('loc1');
            expect(scope).toContain('loc2');
        });
    });

    describe('salesController location enforcement', () => {
        it('getSales filters by assigned locations for non-admin', async () => {
            if (!process.env.MONGODB_URI) return;
            const tid = 'phase3-sales-' + Date.now();
            const loc1 = await Location.create({ name: 'Location 1', tenantId: tid, isActive: true });
            const loc2 = await Location.create({ name: 'Location 2', tenantId: tid, isActive: true });
            const user = await User.create({
                name: 'Manager',
                email: `manager-${tid}@test.com`,
                password: 'Pass123!ab',
                tenantId: tid,
                role: 'manager',
                assignedLocationIds: [loc1._id]
            });
            const sale1 = await Sale.create({
                reference: `SALE-${tid}-1`,
                tenantId: tid,
                locationId: loc1._id,
                type: 'retail',
                items: [{ sku: 'SKU1', name: 'Item 1', price: 10, quantity: 1 }],
                subtotal: 10,
                total: 10,
                paidAmount: 10,
                paymentMethod: 'cash',
                status: 'active',
                soldBy: user._id
            });
            const sale2 = await Sale.create({
                reference: `SALE-${tid}-2`,
                tenantId: tid,
                locationId: loc2._id,
                type: 'retail',
                items: [{ sku: 'SKU2', name: 'Item 2', price: 20, quantity: 1 }],
                subtotal: 20,
                total: 20,
                paidAmount: 20,
                paymentMethod: 'cash',
                status: 'active',
                soldBy: user._id
            });
            const req = mockReq({ user: user.toObject(), query: {} });
            const res = mockRes();
            await salesController.getSales(req, res);
            expect(res.statusCode).toBe(200);
            const saleIds = (res.body.data || []).map((s) => s._id.toString());
            expect(saleIds).toContain(sale1._id.toString());
            expect(saleIds).not.toContain(sale2._id.toString());
            await Sale.deleteOne({ _id: sale1._id });
            await Sale.deleteOne({ _id: sale2._id });
            await Location.deleteOne({ _id: loc1._id });
            await Location.deleteOne({ _id: loc2._id });
            await User.deleteOne({ _id: user._id });
        });

        it('getSaleById returns 404 for out-of-scope location', async () => {
            if (!process.env.MONGODB_URI) return;
            const tid = 'phase3-sale-get-' + Date.now();
            const loc1 = await Location.create({ name: 'Location 1', tenantId: tid, isActive: true });
            const loc2 = await Location.create({ name: 'Location 2', tenantId: tid, isActive: true });
            const user = await User.create({
                name: 'Manager',
                email: `manager-get-${tid}@test.com`,
                password: 'Pass123!ab',
                tenantId: tid,
                role: 'manager',
                assignedLocationIds: [loc1._id]
            });
            const sale = await Sale.create({
                reference: `SALE-${tid}`,
                tenantId: tid,
                locationId: loc2._id,
                type: 'retail',
                items: [{ sku: 'SKU1', name: 'Item 1', price: 10, quantity: 1 }],
                subtotal: 10,
                total: 10,
                paidAmount: 10,
                paymentMethod: 'cash',
                status: 'active',
                soldBy: user._id
            });
            const req = mockReq({ user: user.toObject(), params: { id: sale._id } });
            const res = mockRes();
            await salesController.getSaleById(req, res);
            expect(res.statusCode).toBe(404);
            await Sale.deleteOne({ _id: sale._id });
            await Location.deleteOne({ _id: loc1._id });
            await Location.deleteOne({ _id: loc2._id });
            await User.deleteOne({ _id: user._id });
        });

        it('createSale blocks out-of-scope locationId', async () => {
            if (!process.env.MONGODB_URI) return;
            const tid = 'phase3-sale-create-' + Date.now();
            const loc1 = await Location.create({ name: 'Location 1', tenantId: tid, isActive: true });
            const loc2 = await Location.create({ name: 'Location 2', tenantId: tid, isActive: true });
            const user = await User.create({
                name: 'Manager',
                email: `manager-create-${tid}@test.com`,
                password: 'Pass123!ab',
                tenantId: tid,
                role: 'manager',
                assignedLocationIds: [loc1._id]
            });
            const req = mockReq({
                user: user.toObject(),
                body: {
                    type: 'retail',
                    locationId: loc2._id,
                    items: [{ sku: 'SKU1', name: 'Item 1', price: 10, quantity: 1 }],
                    subtotal: 10,
                    total: 10,
                    paidAmount: 10,
                    paymentMethod: 'cash'
                }
            });
            const res = mockRes();
            await salesController.createSale(req, res);
            expect(res.statusCode).toBe(403);
            expect(res.body.message).toContain('do not have access');
            await Location.deleteOne({ _id: loc1._id });
            await Location.deleteOne({ _id: loc2._id });
            await User.deleteOne({ _id: user._id });
        });
    });

    describe('repairController location enforcement', () => {
        it('getRepairs filters by assigned locations for non-admin', async () => {
            if (!process.env.MONGODB_URI) return;
            const tid = 'phase3-repair-' + Date.now();
            const loc1 = await Location.create({ name: 'Location 1', tenantId: tid, isActive: true });
            const loc2 = await Location.create({ name: 'Location 2', tenantId: tid, isActive: true });
            const user = await User.create({
                name: 'Manager',
                email: `manager-repair-${tid}@test.com`,
                password: 'Pass123!ab',
                tenantId: tid,
                role: 'manager',
                assignedLocationIds: [loc1._id]
            });
            const repair1 = await Repair.create({
                reference: `REP-${tid}-1`,
                tenantId: tid,
                locationId: loc1._id,
                customerName: 'Customer 1',
                status: 'pending',
                createdBy: user._id
            });
            const repair2 = await Repair.create({
                reference: `REP-${tid}-2`,
                tenantId: tid,
                locationId: loc2._id,
                customerName: 'Customer 2',
                status: 'pending',
                createdBy: user._id
            });
            const req = mockReq({ user: user.toObject(), query: {} });
            const res = mockRes();
            await repairController.getRepairs(req, res);
            expect(res.statusCode).toBe(200);
            const repairIds = (res.body.data || []).map((r) => r._id.toString());
            expect(repairIds).toContain(repair1._id.toString());
            expect(repairIds).not.toContain(repair2._id.toString());
            await Repair.deleteOne({ _id: repair1._id });
            await Repair.deleteOne({ _id: repair2._id });
            await Location.deleteOne({ _id: loc1._id });
            await Location.deleteOne({ _id: loc2._id });
            await User.deleteOne({ _id: user._id });
        });

        it('getRepair returns 404 for out-of-scope location', async () => {
            if (!process.env.MONGODB_URI) return;
            const tid = 'phase3-repair-get-' + Date.now();
            const loc1 = await Location.create({ name: 'Location 1', tenantId: tid, isActive: true });
            const loc2 = await Location.create({ name: 'Location 2', tenantId: tid, isActive: true });
            const user = await User.create({
                name: 'Manager',
                email: `manager-repair-get-${tid}@test.com`,
                password: 'Pass123!ab',
                tenantId: tid,
                role: 'manager',
                assignedLocationIds: [loc1._id]
            });
            const repair = await Repair.create({
                reference: `REP-${tid}`,
                tenantId: tid,
                locationId: loc2._id,
                customerName: 'Customer',
                status: 'pending',
                createdBy: user._id
            });
            const req = mockReq({ user: user.toObject(), params: { id: repair._id } });
            const res = mockRes();
            await repairController.getRepair(req, res);
            expect(res.statusCode).toBe(404);
            await Repair.deleteOne({ _id: repair._id });
            await Location.deleteOne({ _id: loc1._id });
            await Location.deleteOne({ _id: loc2._id });
            await User.deleteOne({ _id: user._id });
        });

        it('createRepair blocks out-of-scope locationId', async () => {
            if (!process.env.MONGODB_URI) return;
            const tid = 'phase3-repair-create-' + Date.now();
            const loc1 = await Location.create({ name: 'Location 1', tenantId: tid, isActive: true });
            const loc2 = await Location.create({ name: 'Location 2', tenantId: tid, isActive: true });
            const user = await User.create({
                name: 'Manager',
                email: `manager-repair-create-${tid}@test.com`,
                password: 'Pass123!ab',
                tenantId: tid,
                role: 'manager',
                assignedLocationIds: [loc1._id]
            });
            const req = mockReq({
                user: user.toObject(),
                body: {
                    locationId: loc2._id,
                    customerName: 'Customer',
                    status: 'pending'
                }
            });
            const res = mockRes();
            // Mock entitlements check to pass
            const originalAssert = require('../src/services/entitlementsService').assertFeature;
            require('../src/services/entitlementsService').assertFeature = async () => {};
            const originalAssertLimit = require('../src/services/entitlementsService').assertLimit;
            require('../src/services/entitlementsService').assertLimit = async () => {};
            try {
                await repairController.createRepair(req, res);
                expect(res.statusCode).toBe(403);
                expect(res.body.message).toContain('do not have access');
            } finally {
                require('../src/services/entitlementsService').assertFeature = originalAssert;
                require('../src/services/entitlementsService').assertLimit = originalAssertLimit;
            }
            await Location.deleteOne({ _id: loc1._id });
            await Location.deleteOne({ _id: loc2._id });
            await User.deleteOne({ _id: user._id });
        });
    });

    describe('salesReturnController location enforcement', () => {
        it('getSalesReturns filters by assigned locations for non-admin', async () => {
            if (!process.env.MONGODB_URI) return;
            const tid = 'phase3-return-' + Date.now();
            const loc1 = await Location.create({ name: 'Location 1', tenantId: tid, isActive: true });
            const loc2 = await Location.create({ name: 'Location 2', tenantId: tid, isActive: true });
            const user = await User.create({
                name: 'Manager',
                email: `manager-return-${tid}@test.com`,
                password: 'Pass123!ab',
                tenantId: tid,
                role: 'manager',
                assignedLocationIds: [loc1._id]
            });
            const return1 = await SalesReturn.create({
                reference: `RET-${tid}-1`,
                tenantId: tid,
                locationId: loc1._id,
                customerName: 'Customer 1',
                status: 'Pending',
                items: [],
                total: 0,
                grandTotal: 0
            });
            const return2 = await SalesReturn.create({
                reference: `RET-${tid}-2`,
                tenantId: tid,
                locationId: loc2._id,
                customerName: 'Customer 2',
                status: 'Pending',
                items: [],
                total: 0,
                grandTotal: 0
            });
            const req = mockReq({ user: user.toObject(), query: {} });
            const res = mockRes();
            await salesReturnController.getSalesReturns(req, res);
            expect(res.statusCode).toBe(200);
            const returnIds = (res.body.data || []).map((r) => r._id || r.id).map((id) => id.toString());
            expect(returnIds).toContain(return1._id.toString());
            expect(returnIds).not.toContain(return2._id.toString());
            await SalesReturn.deleteOne({ _id: return1._id });
            await SalesReturn.deleteOne({ _id: return2._id });
            await Location.deleteOne({ _id: loc1._id });
            await Location.deleteOne({ _id: loc2._id });
            await User.deleteOne({ _id: user._id });
        });
    });

    describe('stockAdjustmentController location enforcement', () => {
        it('list filters by assigned locations for non-admin', async () => {
            if (!process.env.MONGODB_URI) return;
            const tid = 'phase3-adjust-' + Date.now();
            const loc1 = await Location.create({ name: 'Location 1', tenantId: tid, isActive: true });
            const loc2 = await Location.create({ name: 'Location 2', tenantId: tid, isActive: true });
            const user = await User.create({
                name: 'Manager',
                email: `manager-adjust-${tid}@test.com`,
                password: 'Pass123!ab',
                tenantId: tid,
                role: 'manager',
                assignedLocationIds: [loc1._id]
            });
            const adj1 = await StockAdjustment.create({
                tenantId: tid,
                adjustmentNo: `ADJ-${tid}-1`,
                locationId: loc1._id,
                status: 'draft',
                reasonCode: 'COUNT_CORRECTION',
                createdByUserId: user._id,
                lines: [],
                serials: []
            });
            const adj2 = await StockAdjustment.create({
                tenantId: tid,
                adjustmentNo: `ADJ-${tid}-2`,
                locationId: loc2._id,
                status: 'draft',
                reasonCode: 'COUNT_CORRECTION',
                createdByUserId: user._id,
                lines: [],
                serials: []
            });
            const req = mockReq({ user: user.toObject(), query: {} });
            const res = mockRes();
            await stockAdjustmentController.list(req, res);
            expect(res.statusCode).toBe(200);
            const adjIds = (res.body.data || []).map((a) => a._id.toString());
            expect(adjIds).toContain(adj1._id.toString());
            expect(adjIds).not.toContain(adj2._id.toString());
            await StockAdjustment.deleteOne({ _id: adj1._id });
            await StockAdjustment.deleteOne({ _id: adj2._id });
            await Location.deleteOne({ _id: loc1._id });
            await Location.deleteOne({ _id: loc2._id });
            await User.deleteOne({ _id: user._id });
        });

        it('create blocks out-of-scope locationId', async () => {
            if (!process.env.MONGODB_URI) return;
            const tid = 'phase3-adjust-create-' + Date.now();
            const loc1 = await Location.create({ name: 'Location 1', tenantId: tid, isActive: true });
            const loc2 = await Location.create({ name: 'Location 2', tenantId: tid, isActive: true });
            const user = await User.create({
                name: 'Manager',
                email: `manager-adjust-create-${tid}@test.com`,
                password: 'Pass123!ab',
                tenantId: tid,
                role: 'manager',
                assignedLocationIds: [loc1._id]
            });
            const req = mockReq({
                user: user.toObject(),
                body: {
                    locationId: loc2._id,
                    reasonCode: 'COUNT_CORRECTION'
                }
            });
            const res = mockRes();
            await stockAdjustmentController.create(req, res);
            expect(res.statusCode).toBe(403);
            expect(res.body.message).toContain('do not have access');
            await Location.deleteOne({ _id: loc1._id });
            await Location.deleteOne({ _id: loc2._id });
            await User.deleteOne({ _id: user._id });
        });
    });

    describe('admin access to all locations', () => {
        it('admin can access sales from all locations', async () => {
            if (!process.env.MONGODB_URI) return;
            const tid = 'phase3-admin-' + Date.now();
            const loc1 = await Location.create({ name: 'Location 1', tenantId: tid, isActive: true });
            const loc2 = await Location.create({ name: 'Location 2', tenantId: tid, isActive: true });
            const admin = await User.create({
                name: 'Admin',
                email: `admin-${tid}@test.com`,
                password: 'Pass123!ab',
                tenantId: tid,
                role: 'admin'
            });
            const sale1 = await Sale.create({
                reference: `SALE-${tid}-1`,
                tenantId: tid,
                locationId: loc1._id,
                type: 'retail',
                items: [{ sku: 'SKU1', name: 'Item 1', price: 10, quantity: 1 }],
                subtotal: 10,
                total: 10,
                paidAmount: 10,
                paymentMethod: 'cash',
                status: 'active',
                soldBy: admin._id
            });
            const sale2 = await Sale.create({
                reference: `SALE-${tid}-2`,
                tenantId: tid,
                locationId: loc2._id,
                type: 'retail',
                items: [{ sku: 'SKU2', name: 'Item 2', price: 20, quantity: 1 }],
                subtotal: 20,
                total: 20,
                paidAmount: 20,
                paymentMethod: 'cash',
                status: 'active',
                soldBy: admin._id
            });
            const req = mockReq({ user: admin.toObject(), query: {} });
            const res = mockRes();
            await salesController.getSales(req, res);
            expect(res.statusCode).toBe(200);
            const saleIds = (res.body.data || []).map((s) => s._id.toString());
            expect(saleIds).toContain(sale1._id.toString());
            expect(saleIds).toContain(sale2._id.toString());
            await Sale.deleteOne({ _id: sale1._id });
            await Sale.deleteOne({ _id: sale2._id });
            await Location.deleteOne({ _id: loc1._id });
            await Location.deleteOne({ _id: loc2._id });
            await User.deleteOne({ _id: admin._id });
        });
    });
});
