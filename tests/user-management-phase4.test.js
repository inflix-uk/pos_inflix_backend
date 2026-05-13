/**
 * Phase 4: Admin/User Management Alignment.
 * Tests that:
 * - User creation always uses current tenant (body.tenantId ignored)
 * - User update verifies user belongs to current tenant
 * - Cross-tenant location assignment rejected
 * - defaultLocationId outside assignedLocationIds rejected (when assignedLocationIds non-empty)
 * - StockTransfer location enforcement
 * - Empty assignedLocationIds preserves "all locations" behavior
 */
const mongoose = require('mongoose');
const User = require('../src/models/User');
const Location = require('../src/models/Location');
const StockTransfer = require('../src/models/StockTransfer');
const adminController = require('../src/controllers/adminController');
const stockTransferController = require('../src/controllers/stockTransferController');
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
        get: () => null,
        headers: {},
        ...overrides
    };
}

describe('Phase 4: User Management Alignment', () => {
    beforeAll(async () => {
        if (process.env.MONGODB_URI) await mongoose.connect(process.env.MONGODB_URI);
    });
    afterAll(async () => {
        await mongoose.disconnect();
    });

    describe('adminController.createUser - tenant enforcement', () => {
        it('ignores body.tenantId and uses resolved tenant', async () => {
            if (!process.env.MONGODB_URI) return;
            const tid = 'phase4-create-' + Date.now();
            const admin = await User.create({
                name: 'Admin',
                email: `admin-${tid}@test.com`,
                password: 'Pass123!ab',
                tenantId: tid,
                role: 'admin'
            });
            const req = mockReq({
                user: { _id: admin._id, tenantId: tid },
                body: {
                    name: 'New User',
                    email: `newuser-${tid}@test.com`,
                    password: 'Pass123!ab',
                    tenantId: 'wrong-tenant' // Should be ignored
                },
                resolvedTenant: null
            });
            const res = mockRes();
            await adminController.createUser(req, res);
            expect(res.statusCode).toBe(201);
            expect(res.body.success).toBe(true);
            const created = await User.findOne({ email: `newuser-${tid}@test.com` });
            expect(created).toBeTruthy();
            expect(created.tenantId).toBe(tid); // Should use resolved tenant, not body.tenantId
            await User.deleteOne({ _id: created._id });
            await User.deleteOne({ _id: admin._id });
        });
    });

    describe('adminController.createUser - location assignment', () => {
        it('accepts and validates assignedLocationIds', async () => {
            if (!process.env.MONGODB_URI) return;
            const tid = 'phase4-loc-create-' + Date.now();
            const admin = await User.create({
                name: 'Admin',
                email: `admin-${tid}@test.com`,
                password: 'Pass123!ab',
                tenantId: tid,
                role: 'admin'
            });
            const loc1 = await Location.create({ name: 'Location 1', tenantId: tid, isActive: true });
            const loc2 = await Location.create({ name: 'Location 2', tenantId: tid, isActive: true });
            const req = mockReq({
                user: { _id: admin._id, tenantId: tid },
                body: {
                    name: 'Manager',
                    email: `manager-${tid}@test.com`,
                    password: 'Pass123!ab',
                    assignedLocationIds: [loc1._id.toString(), loc2._id.toString()],
                    defaultLocationId: loc1._id.toString()
                },
                resolvedTenant: null
            });
            const res = mockRes();
            await adminController.createUser(req, res);
            expect(res.statusCode).toBe(201);
            const created = await User.findOne({ email: `manager-${tid}@test.com` });
            expect(created.assignedLocationIds.length).toBe(2);
            expect(created.defaultLocationId.toString()).toBe(loc1._id.toString());
            await User.deleteOne({ _id: created._id });
            await User.deleteOne({ _id: admin._id });
            await Location.deleteOne({ _id: loc1._id });
            await Location.deleteOne({ _id: loc2._id });
        });

        it('rejects cross-tenant location assignment', async () => {
            if (!process.env.MONGODB_URI) return;
            const tid1 = 'phase4-tenant1-' + Date.now();
            const tid2 = 'phase4-tenant2-' + Date.now();
            const admin = await User.create({
                name: 'Admin',
                email: `admin-${tid1}@test.com`,
                password: 'Pass123!ab',
                tenantId: tid1,
                role: 'admin'
            });
            const locOther = await Location.create({ name: 'Other Location', tenantId: tid2, isActive: true });
            const req = mockReq({
                user: { _id: admin._id, tenantId: tid1 },
                body: {
                    name: 'User',
                    email: `user-${tid1}@test.com`,
                    password: 'Pass123!ab',
                    assignedLocationIds: [locOther._id.toString()]
                },
                resolvedTenant: null
            });
            const res = mockRes();
            await adminController.createUser(req, res);
            expect(res.statusCode).toBe(400);
            expect(res.body.message).toContain('does not belong to this tenant');
            await User.deleteOne({ _id: admin._id });
            await Location.deleteOne({ _id: locOther._id });
        });

        it('rejects defaultLocationId outside assignedLocationIds', async () => {
            if (!process.env.MONGODB_URI) return;
            const tid = 'phase4-default-' + Date.now();
            const admin = await User.create({
                name: 'Admin',
                email: `admin-${tid}@test.com`,
                password: 'Pass123!ab',
                tenantId: tid,
                role: 'admin'
            });
            const loc1 = await Location.create({ name: 'Location 1', tenantId: tid, isActive: true });
            const loc2 = await Location.create({ name: 'Location 2', tenantId: tid, isActive: true });
            const req = mockReq({
                user: { _id: admin._id, tenantId: tid },
                body: {
                    name: 'User',
                    email: `user-${tid}@test.com`,
                    password: 'Pass123!ab',
                    assignedLocationIds: [loc1._id.toString()],
                    defaultLocationId: loc2._id.toString() // Not in assignedLocationIds
                },
                resolvedTenant: null
            });
            const res = mockRes();
            await adminController.createUser(req, res);
            expect(res.statusCode).toBe(400);
            expect(res.body.message).toContain('defaultLocationId must be one of assignedLocationIds');
            await User.deleteOne({ _id: admin._id });
            await Location.deleteOne({ _id: loc1._id });
            await Location.deleteOne({ _id: loc2._id });
        });

        it('allows defaultLocationId when assignedLocationIds is empty (legacy)', async () => {
            if (!process.env.MONGODB_URI) return;
            const tid = 'phase4-legacy-' + Date.now();
            const admin = await User.create({
                name: 'Admin',
                email: `admin-${tid}@test.com`,
                password: 'Pass123!ab',
                tenantId: tid,
                role: 'admin'
            });
            const loc1 = await Location.create({ name: 'Location 1', tenantId: tid, isActive: true });
            const req = mockReq({
                user: { _id: admin._id, tenantId: tid },
                body: {
                    name: 'User',
                    email: `user-${tid}@test.com`,
                    password: 'Pass123!ab',
                    assignedLocationIds: [], // Empty = all locations
                    defaultLocationId: loc1._id.toString()
                },
                resolvedTenant: null
            });
            const res = mockRes();
            await adminController.createUser(req, res);
            expect(res.statusCode).toBe(201);
            const created = await User.findOne({ email: `user-${tid}@test.com` });
            expect(created.assignedLocationIds.length).toBe(0);
            expect(created.defaultLocationId.toString()).toBe(loc1._id.toString());
            await User.deleteOne({ _id: created._id });
            await User.deleteOne({ _id: admin._id });
            await Location.deleteOne({ _id: loc1._id });
        });
    });

    describe('adminController.updateUser - tenant enforcement', () => {
        it('verifies user belongs to current tenant before updating', async () => {
            if (!process.env.MONGODB_URI) return;
            const tid1 = 'phase4-update1-' + Date.now();
            const tid2 = 'phase4-update2-' + Date.now();
            const admin = await User.create({
                name: 'Admin',
                email: `admin-${tid1}@test.com`,
                password: 'Pass123!ab',
                tenantId: tid1,
                role: 'admin'
            });
            const userOther = await User.create({
                name: 'Other User',
                email: `other-${tid2}@test.com`,
                password: 'Pass123!ab',
                tenantId: tid2,
                role: 'cashier'
            });
            const req = mockReq({
                user: { _id: admin._id, tenantId: tid1 },
                params: { id: userOther._id.toString() },
                body: { name: 'Updated Name' },
                resolvedTenant: null
            });
            const res = mockRes();
            await adminController.updateUser(req, res);
            expect(res.statusCode).toBe(404); // User not found in current tenant
            await User.deleteOne({ _id: admin._id });
            await User.deleteOne({ _id: userOther._id });
        });

        it('rejects cross-tenant location assignment in update', async () => {
            if (!process.env.MONGODB_URI) return;
            const tid1 = 'phase4-update-loc1-' + Date.now();
            const tid2 = 'phase4-update-loc2-' + Date.now();
            const admin = await User.create({
                name: 'Admin',
                email: `admin-${tid1}@test.com`,
                password: 'Pass123!ab',
                tenantId: tid1,
                role: 'admin'
            });
            const user = await User.create({
                name: 'User',
                email: `user-${tid1}@test.com`,
                password: 'Pass123!ab',
                tenantId: tid1,
                role: 'cashier'
            });
            const locOther = await Location.create({ name: 'Other Location', tenantId: tid2, isActive: true });
            const req = mockReq({
                user: { _id: admin._id, tenantId: tid1 },
                params: { id: user._id.toString() },
                body: {
                    assignedLocationIds: [locOther._id.toString()]
                },
                resolvedTenant: null
            });
            const res = mockRes();
            await adminController.updateUser(req, res);
            expect(res.statusCode).toBe(400);
            expect(res.body.message).toContain('does not belong to this tenant');
            await User.deleteOne({ _id: admin._id });
            await User.deleteOne({ _id: user._id });
            await Location.deleteOne({ _id: locOther._id });
        });
    });

    describe('stockTransferController - location enforcement (Phase 3 follow-up)', () => {
        it('list filters by user assigned locations', async () => {
            if (!process.env.MONGODB_URI) return;
            const tid = 'phase4-st-list-' + Date.now();
            const loc1 = await Location.create({ name: 'Location 1', tenantId: tid, isActive: true });
            const loc2 = await Location.create({ name: 'Location 2', tenantId: tid, isActive: true });
            const loc3 = await Location.create({ name: 'Location 3', tenantId: tid, isActive: true });
            const manager = await User.create({
                name: 'Manager',
                email: `manager-${tid}@test.com`,
                password: 'Pass123!ab',
                tenantId: tid,
                role: 'manager',
                assignedLocationIds: [loc1._id, loc2._id]
            });
            const transfer1 = await StockTransfer.create({
                tenantId: tid,
                transferNo: `TF-${tid}-1`,
                fromLocationId: loc1._id,
                toLocationId: loc2._id,
                status: 'Draft',
                createdByUserId: manager._id,
                lines: [],
                serials: []
            });
            const transfer2 = await StockTransfer.create({
                tenantId: tid,
                transferNo: `TF-${tid}-2`,
                fromLocationId: loc3._id,
                toLocationId: loc1._id,
                status: 'Draft',
                createdByUserId: manager._id,
                lines: [],
                serials: []
            });
            const req = mockReq({
                user: {
                    _id: manager._id,
                    tenantId: tid,
                    role: 'manager',
                    assignedLocationIds: [loc1._id, loc2._id],
                    permissionKeys: new Set(['stock_transfer.view'])
                },
                query: {},
                resolvedTenant: null
            });
            const res = mockRes();
            await stockTransferController.list(req, res);
            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);
            const transferNos = (res.body.data || []).map((t) => t.transferNo);
            expect(transferNos).toContain(transfer1.transferNo);
            // transfer2 has fromLocationId=loc3 which is not in scope, but toLocationId=loc1 is in scope
            // So it should appear (fromLocationId OR toLocationId in scope)
            expect(transferNos).toContain(transfer2.transferNo);
            await StockTransfer.deleteOne({ _id: transfer1._id });
            await StockTransfer.deleteOne({ _id: transfer2._id });
            await User.deleteOne({ _id: manager._id });
            await Location.deleteOne({ _id: loc1._id });
            await Location.deleteOne({ _id: loc2._id });
            await Location.deleteOne({ _id: loc3._id });
        });

        it('getById returns 404 for out-of-scope transfer', async () => {
            if (!process.env.MONGODB_URI) return;
            const tid = 'phase4-st-get-' + Date.now();
            const loc1 = await Location.create({ name: 'Location 1', tenantId: tid, isActive: true });
            const loc2 = await Location.create({ name: 'Location 2', tenantId: tid, isActive: true });
            const loc3 = await Location.create({ name: 'Location 3', tenantId: tid, isActive: true });
            const manager = await User.create({
                name: 'Manager',
                email: `manager-${tid}@test.com`,
                password: 'Pass123!ab',
                tenantId: tid,
                role: 'manager',
                assignedLocationIds: [loc1._id]
            });
            const transfer = await StockTransfer.create({
                tenantId: tid,
                transferNo: `TF-${tid}-1`,
                fromLocationId: loc2._id,
                toLocationId: loc3._id,
                status: 'Draft',
                createdByUserId: manager._id,
                lines: [],
                serials: []
            });
            const req = mockReq({
                user: {
                    _id: manager._id,
                    tenantId: tid,
                    role: 'manager',
                    assignedLocationIds: [loc1._id],
                    permissionKeys: new Set(['stock_transfer.view'])
                },
                params: { id: transfer._id.toString() },
                resolvedTenant: null
            });
            const res = mockRes();
            await stockTransferController.getById(req, res);
            expect(res.statusCode).toBe(404); // Both fromLocationId and toLocationId are out of scope
            await StockTransfer.deleteOne({ _id: transfer._id });
            await User.deleteOne({ _id: manager._id });
            await Location.deleteOne({ _id: loc1._id });
            await Location.deleteOne({ _id: loc2._id });
            await Location.deleteOne({ _id: loc3._id });
        });

        it('create rejects if user cannot access both locations', async () => {
            if (!process.env.MONGODB_URI) return;
            const tid = 'phase4-st-create-' + Date.now();
            const loc1 = await Location.create({ name: 'Location 1', tenantId: tid, isActive: true });
            const loc2 = await Location.create({ name: 'Location 2', tenantId: tid, isActive: true });
            const loc3 = await Location.create({ name: 'Location 3', tenantId: tid, isActive: true });
            const manager = await User.create({
                name: 'Manager',
                email: `manager-${tid}@test.com`,
                password: 'Pass123!ab',
                tenantId: tid,
                role: 'manager',
                assignedLocationIds: [loc1._id, loc2._id]
            });
            const req = mockReq({
                user: {
                    _id: manager._id,
                    tenantId: tid,
                    role: 'manager',
                    assignedLocationIds: [loc1._id, loc2._id],
                    permissionKeys: new Set(['stock_transfer.create'])
                },
                body: {
                    fromLocationId: loc1._id.toString(),
                    toLocationId: loc3._id.toString() // loc3 not in scope
                },
                resolvedTenant: null
            });
            const res = mockRes();
            await stockTransferController.create(req, res);
            expect(res.statusCode).toBe(403);
            expect(res.body.message).toContain('do not have access');
            await User.deleteOne({ _id: manager._id });
            await Location.deleteOne({ _id: loc1._id });
            await Location.deleteOne({ _id: loc2._id });
            await Location.deleteOne({ _id: loc3._id });
        });
    });
});
