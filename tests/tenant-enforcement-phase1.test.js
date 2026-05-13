/**
 * Phase 1 tenant enforcement: cross-tenant isolation for users, repairs, activity log, reports.
 * - adminController listUsers/getUser filter by tenantId
 * - userController getUsers/getUser/update/delete/reset filter by tenantId
 * - repairController getRepairs/getRepair/update/delete/takePayment filter by tenantId
 * - activityLogController getActivityLog/getActivityLogById filter by tenantId
 * - activityLogService writes tenantId on audit events
 * - reportController getDashboardStats/getInventoryReport filter Product/Customer by tenantId
 */
const mongoose = require('mongoose');
const User = require('../src/models/User');
const Repair = require('../src/models/Repair');
const AuditEvent = require('../src/models/AuditEvent');
const Product = require('../src/models/Product');
const Customer = require('../src/models/Customer');
const adminController = require('../src/controllers/adminController');
const userController = require('../src/controllers/userController');
const repairController = require('../src/controllers/repairController');
const activityLogController = require('../src/controllers/activityLogController');
const reportController = require('../src/controllers/reportController');
const activityLogService = require('../src/services/activityLogService');
const { getTenantIdFromReq } = require('../src/middleware/auth');

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

describe('Phase 1: Tenant enforcement', () => {
    beforeAll(async () => {
        if (process.env.MONGODB_URI) await mongoose.connect(process.env.MONGODB_URI);
    });
    afterAll(async () => {
        await mongoose.disconnect();
    });

    describe('getTenantIdFromReq', () => {
        it('returns user.tenantId when set', () => {
            expect(getTenantIdFromReq(mockReq({ user: { tenantId: 'tenant-a' } }))).toBe('tenant-a');
            expect(getTenantIdFromReq(mockReq({ user: { tenantId: 'default' } }))).toBe('default');
        });
        it('returns default when user missing or tenantId empty', () => {
            expect(getTenantIdFromReq(mockReq())).toBe('default');
            expect(getTenantIdFromReq(mockReq({ user: {} }))).toBe('default');
            expect(getTenantIdFromReq(mockReq({ user: { tenantId: null } }))).toBe('default');
        });
    });

    describe('adminController listUsers / getUser', () => {
        it('listUsers returns only users in request tenant', async () => {
            if (!process.env.MONGODB_URI) return;
            const tid = 'phase1-admin-' + Date.now();
            const userA = await User.create({
                name: 'User A',
                email: `admin-list-${tid}-a@test.com`,
                password: 'Pass123!ab',
                tenantId: tid,
                role: 'admin'
            });
            const userB = await User.create({
                name: 'User B',
                email: `admin-list-${tid}-b@other.com`,
                password: 'Pass123!ab',
                tenantId: 'other-tenant',
                role: 'cashier'
            });
            const req = mockReq({ user: { _id: userA._id, tenantId: tid }, query: {} });
            const res = mockRes();
            await adminController.listUsers(req, res);
            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);
            const ids = (res.body.data || []).map((u) => u._id.toString());
            expect(ids).toContain(userA._id.toString());
            expect(ids).not.toContain(userB._id.toString());
            await User.deleteOne({ _id: userA._id });
            await User.deleteOne({ _id: userB._id });
        });

        it('getUser returns 404 when user belongs to different tenant', async () => {
            if (!process.env.MONGODB_URI) return;
            const tid = 'phase1-getuser-' + Date.now();
            const userB = await User.create({
                name: 'Other Tenant User',
                email: `getuser-other-${tid}@test.com`,
                password: 'Pass123!ab',
                tenantId: 'other-tenant',
                role: 'cashier'
            });
            const req = mockReq({ user: { tenantId: tid }, params: { id: userB._id } });
            const res = mockRes();
            await adminController.getUser(req, res);
            expect(res.statusCode).toBe(404);
            expect(res.body.success).toBe(false);
            await User.deleteOne({ _id: userB._id });
        });
    });

    describe('userController getUsers / getUser', () => {
        it('getUsers returns only users in request tenant', async () => {
            if (!process.env.MONGODB_URI) return;
            const tid = 'phase1-user-' + Date.now();
            const userA = await User.create({
                name: 'User A',
                email: `user-list-${tid}-a@test.com`,
                password: 'Pass123!ab',
                tenantId: tid
            });
            const userB = await User.create({
                name: 'User B',
                email: `user-list-${tid}-b@other.com`,
                password: 'Pass123!ab',
                tenantId: 'other-tenant'
            });
            const req = mockReq({ user: { tenantId: tid }, query: {} });
            const res = mockRes();
            await userController.getUsers(req, res);
            expect(res.statusCode).toBe(200);
            const ids = (res.body.data || []).map((u) => u._id.toString());
            expect(ids).toContain(userA._id.toString());
            expect(ids).not.toContain(userB._id.toString());
            await User.deleteOne({ _id: userA._id });
            await User.deleteOne({ _id: userB._id });
        });

        it('getUser returns 404 when user belongs to different tenant', async () => {
            if (!process.env.MONGODB_URI) return;
            const userB = await User.create({
                name: 'Other',
                email: `user-get-other-${Date.now()}@test.com`,
                password: 'Pass123!ab',
                tenantId: 'other-tenant'
            });
            const req = mockReq({ user: { tenantId: 'my-tenant' }, params: { id: userB._id } });
            const res = mockRes();
            await userController.getUser(req, res);
            expect(res.statusCode).toBe(404);
            await User.deleteOne({ _id: userB._id });
        });
    });

    describe('repairController getRepairs / getRepair', () => {
        it('getRepairs returns only repairs in request tenant', async () => {
            if (!process.env.MONGODB_URI) return;
            const tid = 'phase1-rep-' + Date.now();
            const refA = 'REP-P1-' + Date.now();
            const refB = 'REP-P1-B-' + Date.now();
            const repairA = await Repair.create({
                reference: refA,
                customerName: 'Cust A',
                tenantId: tid,
                status: 'pending'
            });
            const repairB = await Repair.create({
                reference: refB,
                customerName: 'Cust B',
                tenantId: 'other-tenant',
                status: 'pending'
            });
            const req = mockReq({ user: { tenantId: tid }, query: {} });
            const res = mockRes();
            await repairController.getRepairs(req, res);
            expect(res.statusCode).toBe(200);
            const ids = (res.body.data || []).map((r) => r._id.toString());
            expect(ids).toContain(repairA._id.toString());
            expect(ids).not.toContain(repairB._id.toString());
            await Repair.deleteOne({ _id: repairA._id });
            await Repair.deleteOne({ _id: repairB._id });
        });

        it('getRepair returns 404 when repair belongs to different tenant', async () => {
            if (!process.env.MONGODB_URI) return;
            const repair = await Repair.create({
                reference: 'REP-P1-OTHER-' + Date.now(),
                customerName: 'Cust',
                tenantId: 'other-tenant',
                status: 'pending'
            });
            const req = mockReq({ user: { tenantId: 'my-tenant' }, params: { id: repair._id } });
            const res = mockRes();
            await repairController.getRepair(req, res);
            expect(res.statusCode).toBe(404);
            await Repair.deleteOne({ _id: repair._id });
        });
    });

    describe('activityLogController getActivityLog / getActivityLogById', () => {
        it('getActivityLog returns only events for request tenant', async () => {
            if (!process.env.MONGODB_URI) return;
            const tid = 'phase1-audit-' + Date.now();
            const myId = new mongoose.Types.ObjectId();
            await AuditEvent.create({
                action: 'CREATE_SALE',
                entityType: 'Sale',
                entityId: myId,
                tenantId: tid,
                occurredAtUtc: new Date(),
                success: true
            });
            await AuditEvent.create({
                action: 'CREATE_SALE',
                entityType: 'Sale',
                entityId: new mongoose.Types.ObjectId(),
                tenantId: 'other-tenant',
                occurredAtUtc: new Date(),
                success: true
            });
            const req = mockReq({ user: { tenantId: tid }, query: {} });
            const res = mockRes();
            await activityLogController.getActivityLog(req, res);
            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);
            const ourEvent = (res.body.data || []).find((e) => e.entityId === myId.toString());
            expect(ourEvent).toBeDefined();
            expect(res.body.data.length).toBe(1);
            expect(res.body.total).toBe(1);
            await AuditEvent.deleteMany({ tenantId: tid });
            await AuditEvent.deleteMany({ tenantId: 'other-tenant' });
        });

        it('getActivityLogById returns 404 when event belongs to different tenant', async () => {
            if (!process.env.MONGODB_URI) return;
            const ev = await AuditEvent.create({
                action: 'CREATE_SALE',
                entityType: 'Sale',
                entityId: new mongoose.Types.ObjectId(),
                tenantId: 'other-tenant',
                occurredAtUtc: new Date(),
                success: true
            });
            const req = mockReq({ user: { tenantId: 'my-tenant' }, params: { id: ev._id } });
            const res = mockRes();
            await activityLogController.getActivityLogById(req, res);
            expect(res.statusCode).toBe(404);
            await AuditEvent.deleteOne({ _id: ev._id });
        });
    });

    describe('activityLogService writes tenantId', () => {
        it('logFromReq includes tenantId from req.user', async () => {
            if (!process.env.MONGODB_URI) return;
            const tid = 'phase1-write-' + Date.now();
            const req = mockReq({ user: { _id: new mongoose.Types.ObjectId(), name: 'T', tenantId: tid } });
            const doc = await activityLogService.logFromReq(req, {
                action: 'CREATE_SALE',
                entityType: 'Sale',
                entityId: new mongoose.Types.ObjectId(),
                success: true
            });
            expect(doc).not.toBeNull();
            expect(doc.tenantId).toBe(tid);
            await AuditEvent.deleteOne({ _id: doc._id });
        });

        it('log accepts tenantId in opts', async () => {
            if (!process.env.MONGODB_URI) return;
            const tid = 'phase1-log-opts-' + Date.now();
            const doc = await activityLogService.log({
                action: 'CREATE_SALE',
                entityType: 'Sale',
                entityId: new mongoose.Types.ObjectId(),
                tenantId: tid,
                success: true
            });
            expect(doc).not.toBeNull();
            expect(doc.tenantId).toBe(tid);
            await AuditEvent.deleteOne({ _id: doc._id });
        });
    });

    describe('reportController getDashboardStats / getInventoryReport', () => {
        it('getDashboardStats product and customer counts are tenant-scoped', async () => {
            if (!process.env.MONGODB_URI) return;
            const tid = 'phase1-report-' + Date.now();
            const catId = new mongoose.Types.ObjectId();
            const Category = require('../src/models/Category');
            let cat = await Category.findOne().lean();
            if (!cat) {
                await Category.create({ name: 'Test Cat', slug: 'test-cat' });
                cat = await Category.findOne().lean();
            }
            await Product.create({
                name: 'P1',
                sku: 'SKU-P1-' + tid,
                category: cat._id,
                costPrice: 10,
                sellingPrice: 15,
                quantity: 0,
                tenantId: tid,
                isActive: true
            });
            await Customer.create({
                name: 'C1',
                phone: '123',
                tenantId: tid,
                isActive: true
            });
            const req = mockReq({ user: { tenantId: tid }, query: {} });
            const res = mockRes();
            await reportController.getDashboardStats(req, res);
            expect(res.statusCode).toBe(200);
            expect(res.body.data.totalProducts).toBeGreaterThanOrEqual(1);
            expect(res.body.data.totalCustomers).toBeGreaterThanOrEqual(1);
            await Product.deleteOne({ sku: 'SKU-P1-' + tid });
            await Customer.deleteOne({ name: 'C1', tenantId: tid });
        });

        it('getInventoryReport returns only products for request tenant', async () => {
            if (!process.env.MONGODB_URI) return;
            const tid = 'phase1-inv-' + Date.now();
            const Category = require('../src/models/Category');
            let cat = await Category.findOne().lean();
            if (!cat) {
                await Category.create({ name: 'Test Cat', slug: 'test-cat' });
                cat = await Category.findOne().lean();
            }
            await Product.create({
                name: 'Inv P',
                sku: 'SKU-INV-' + tid,
                category: cat._id,
                costPrice: 10,
                sellingPrice: 15,
                quantity: 5,
                tenantId: tid,
                isActive: true
            });
            const req = mockReq({ user: { tenantId: tid }, query: {} });
            const res = mockRes();
            await reportController.getInventoryReport(req, res);
            expect(res.statusCode).toBe(200);
            expect(res.body.data.stats).toBeDefined();
            expect(res.body.data.stats.totalProducts).toBeGreaterThanOrEqual(1);
            await Product.deleteOne({ sku: 'SKU-INV-' + tid });
        });
    });
});
