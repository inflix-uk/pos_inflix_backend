/**
 * Rigid POS: transaction behaviour, double-return safety, audit logging.
 * These tests require MongoDB (replica set for transactions). Skip if no MONGODB_URI or not replica set.
 */

const mongoose = require('mongoose');
const { runWithTransaction, supportsTransactions } = require('../src/services/transactionService');
const salesTransactionService = require('../src/services/salesTransactionService');

const Sale = require('../src/models/Sale');
const SoldSerial = require('../src/models/SoldSerial');
const AuditLog = require('../src/models/AuditLog');
const AuditEvent = require('../src/models/AuditEvent');
const activityLogService = require('../src/services/activityLogService');

const round2 = (n) => Math.round(Number(n) * 100) / 100;

describe('Rigid POS', () => {
    beforeAll(async () => {
        if (!process.env.MONGODB_URI) {
            console.warn('MONGODB_URI not set; skipping DB tests');
            return;
        }
        await mongoose.connect(process.env.MONGODB_URI);
    });

    afterAll(async () => {
        await mongoose.disconnect();
    });

    describe('transactionService', () => {
        it('aborts transaction and throws when callback throws', async () => {
            if (!process.env.MONGODB_URI) return;
            const supports = await supportsTransactions();
            if (!supports) {
                console.warn('Transactions not supported (replica set required); skipping');
                return;
            }
            await expect(
                runWithTransaction(async (session) => {
                    await Sale.create([{ type: 'retail', items: [{ sku: 't', name: 'T', price: 1, quantity: 1 }], subtotal: 1, total: 1 }], { session });
                    throw new Error('Rollback');
                })
            ).rejects.toThrow('Rollback');
            const count = await Sale.countDocuments({ 'items.sku': 't' });
            expect(count).toBe(0);
        });
    });

    describe('salesTransactionService.round2', () => {
        it('rounds to 2 decimals', () => {
            expect(salesTransactionService.round2(10.556)).toBe(10.56);
            expect(salesTransactionService.round2(10.554)).toBe(10.55);
        });
    });

    describe('Audit log', () => {
        it('AuditLog model has required fields', () => {
            const schema = AuditLog.schema.obj;
            expect(schema.entityType).toBeDefined();
            expect(schema.entityId).toBeDefined();
            expect(schema.action).toBeDefined();
            expect(schema.performedAt).toBeDefined();
        });
    });

    describe('Activity log (AuditEvent)', () => {
        it('AuditEvent model has fast-filter columns', () => {
            const schema = AuditEvent.schema.obj;
            expect(schema.occurredAtUtc).toBeDefined();
            expect(schema.actorUserId).toBeDefined();
            expect(schema.action).toBeDefined();
            expect(schema.entityType).toBeDefined();
            expect(schema.entityId).toBeDefined();
            expect(schema.success).toBeDefined();
            expect(schema.message).toBeDefined();
            expect(schema.customerId).toBeDefined();
            expect(schema.saleId).toBeDefined();
            expect(schema.invoiceNo).toBeDefined();
            expect(schema.imei).toBeDefined();
        });

        it('log() creates an event with required fields', async () => {
            if (!process.env.MONGODB_URI) return;
            const doc = await activityLogService.log({
                action: 'LOGIN',
                entityType: 'User',
                entityId: 'test-user-id',
                success: true,
                message: 'Test login'
            });
            expect(doc).toBeDefined();
            expect(doc.action).toBe('LOGIN');
            expect(doc.entityType).toBe('User');
            expect(doc.entityId).toBe('test-user-id');
            expect(doc.success).toBe(true);
            expect(doc.occurredAtUtc).toBeDefined();
            if (doc._id) {
                await AuditEvent.deleteOne({ _id: doc._id });
            }
        });
    });

    describe('SoldSerial unique constraint', () => {
        it('SoldSerial schema has unique index on serialNumber', () => {
            const index = SoldSerial.schema.indexes().find((i) => i[0].serialNumber === 1);
            expect(index).toBeDefined();
            expect(index[1].unique).toBe(true);
        });
    });
});
