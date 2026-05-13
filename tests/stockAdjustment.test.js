/**
 * Stock Adjustment module: model, service, permissions.
 * - StockAdjustment: Draft | Posted | Cancelled; reasonCode; lines/serials.
 * - Post creates StockMoves (adjust_in/adjust_out), updates StockBalance and SerialLocation.
 * - No direct stock edits; all auditable.
 */

const StockAdjustment = require('../src/models/StockAdjustment');
const StockMove = require('../src/models/StockMove');
const stockAdjustmentService = require('../src/services/stockAdjustmentService');

describe('Stock Adjustment', () => {
    describe('StockAdjustment model', () => {
        it('has STATUSES Draft, Posted, Cancelled', () => {
            expect(StockAdjustment.STATUSES).toEqual(['Draft', 'Posted', 'Cancelled']);
        });

        it('has REASON_CODES including COUNT_CORRECTION, OTHER', () => {
            expect(StockAdjustment.REASON_CODES).toBeDefined();
            expect(StockAdjustment.REASON_CODES).toContain('COUNT_CORRECTION');
            expect(StockAdjustment.REASON_CODES).toContain('OTHER');
        });

        it('has adjustmentNo, locationId, status, reasonCode, notes, lines, serials', () => {
            const schema = StockAdjustment.schema.obj;
            expect(schema.adjustmentNo).toBeDefined();
            expect(schema.locationId).toBeDefined();
            expect(schema.status).toBeDefined();
            expect(schema.reasonCode).toBeDefined();
            expect(schema.notes).toBeDefined();
            expect(schema.lines).toBeDefined();
            expect(schema.serials).toBeDefined();
        });

        it('has lines with productId, deltaQty, unitCostSnapshot, valueSnapshot', () => {
            const linesPath = StockAdjustment.schema.path('lines');
            const lineSchema = linesPath?.schema?.obj || (linesPath?.caster?.schema?.obj);
            expect(lineSchema).toBeDefined();
            expect(lineSchema.productId).toBeDefined();
            expect(lineSchema.deltaQty).toBeDefined();
            expect(lineSchema.unitCostSnapshot).toBeDefined();
            expect(lineSchema.valueSnapshot).toBeDefined();
        });

        it('has serials with serialOrImei, direction, unitCostSnapshot', () => {
            const serialsPath = StockAdjustment.schema.path('serials');
            const serSchema = serialsPath?.schema?.obj || (serialsPath?.caster?.schema?.obj);
            expect(serSchema).toBeDefined();
            expect(serSchema.serialOrImei).toBeDefined();
            expect(serSchema.direction).toBeDefined();
            expect(serSchema.direction.enum).toEqual(['IN', 'OUT']);
        });
    });

    describe('StockMove model', () => {
        it('supports adjust_in and adjust_out types', () => {
            const schema = StockMove.schema.obj;
            expect(schema.type.enum).toContain('adjust_in');
            expect(schema.type.enum).toContain('adjust_out');
            expect(schema.adjustmentId).toBeDefined();
        });
    });

    describe('stockAdjustmentService', () => {
        it('exports STATUS, generateAdjustmentNo, validateSerialForAdjustment, postAdjustment, cancelAdjustment', () => {
            expect(stockAdjustmentService.STATUS).toBeDefined();
            expect(stockAdjustmentService.STATUS.DRAFT).toBe('Draft');
            expect(stockAdjustmentService.STATUS.POSTED).toBe('Posted');
            expect(stockAdjustmentService.STATUS.CANCELLED).toBe('Cancelled');
            expect(typeof stockAdjustmentService.generateAdjustmentNo).toBe('function');
            expect(typeof stockAdjustmentService.validateSerialForAdjustment).toBe('function');
            expect(typeof stockAdjustmentService.postAdjustment).toBe('function');
            expect(typeof stockAdjustmentService.cancelAdjustment).toBe('function');
        });

        it('normalizeSerial trims input', () => {
            expect(stockAdjustmentService.normalizeSerial('  abc  ')).toBe('abc');
        });

        it('validateSerialForAdjustment returns valid: false for empty serial', async () => {
            const result = await stockAdjustmentService.validateSerialForAdjustment('', null, 'OUT');
            expect(result.valid).toBe(false);
            expect(result.reason).toBeDefined();
        });

        it('computeTotals sums lines and serials', () => {
            const adj = {
                lines: [
                    { deltaQty: 5, valueSnapshot: 10 },
                    { deltaQty: -3, valueSnapshot: 6 }
                ],
                serials: [
                    { direction: 'IN', valueSnapshot: 2 },
                    { direction: 'OUT', valueSnapshot: 1 }
                ]
            };
            const t = stockAdjustmentService.computeTotals(adj);
            expect(t.totalQtyIn).toBe(6);
            expect(t.totalQtyOut).toBe(4);
            expect(t.totalValueIn).toBe(12);
            expect(t.totalValueOut).toBe(7);
        });
    });
});
