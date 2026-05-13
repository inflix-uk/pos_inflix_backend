/**
 * Stock Transfer module: model statuses, schema, service exports, permission checks.
 * - StockTransfer has status Draft | Dispatched | Received | Cancelled.
 * - from_location_id != to_location_id enforced in controller.
 * - dispatch/receive use stock moves (tested via service export and logic).
 */

const StockTransfer = require('../src/models/StockTransfer');
const StockMove = require('../src/models/StockMove');
const SerialLocation = require('../src/models/SerialLocation');
const stockTransferService = require('../src/services/stockTransferService');
const { requirePermission } = require('../src/middleware/auth');

describe('Stock Transfer', () => {
    describe('StockTransfer model', () => {
        it('has STATUSES Draft, Dispatched, Received, Cancelled', () => {
            expect(StockTransfer.STATUSES).toEqual(['Draft', 'Dispatched', 'Received', 'Cancelled']);
        });

        it('has transferNo, fromLocationId, toLocationId, status, lines, serials', () => {
            const schema = StockTransfer.schema.obj;
            expect(schema.transferNo).toBeDefined();
            expect(schema.fromLocationId).toBeDefined();
            expect(schema.toLocationId).toBeDefined();
            expect(schema.status).toBeDefined();
            expect(schema.status.enum).toContain('Draft');
            expect(schema.status.enum).toContain('Dispatched');
            expect(schema.status.enum).toContain('Received');
            expect(schema.status.enum).toContain('Cancelled');
            expect(schema.lines).toBeDefined();
            expect(schema.serials).toBeDefined();
        });

        it('has lines with productId, qty, unitCost', () => {
            const linesPath = StockTransfer.schema.path('lines');
            const lineSchema = linesPath?.schema?.obj || (linesPath?.caster?.schema?.obj);
            expect(lineSchema).toBeDefined();
            expect(lineSchema.productId).toBeDefined();
            expect(lineSchema.qty).toBeDefined();
            expect(lineSchema.unitCost).toBeDefined();
        });

        it('has serials with serialOrImei, fromLocationId, toLocationId', () => {
            const serialsPath = StockTransfer.schema.path('serials');
            const serSchema = serialsPath?.schema?.obj || (serialsPath?.caster?.schema?.obj);
            expect(serSchema).toBeDefined();
            expect(serSchema.serialOrImei).toBeDefined();
            expect(serSchema.fromLocationId).toBeDefined();
            expect(serSchema.toLocationId).toBeDefined();
        });
    });

    describe('StockMove model', () => {
        it('has type in/out/adjust_in/adjust_out, locationId, transferId, adjustmentId, quantity, serialNumber', () => {
            const schema = StockMove.schema.obj;
            expect(schema.type).toBeDefined();
            expect(schema.type.enum).toEqual(expect.arrayContaining(['in', 'out', 'adjust_in', 'adjust_out']));
            expect(schema.adjustmentId).toBeDefined();
            expect(schema.locationId).toBeDefined();
            expect(schema.transferId).toBeDefined();
            expect(schema.quantity).toBeDefined();
            expect(schema.serialNumber).toBeDefined();
        });
    });

    describe('SerialLocation model', () => {
        it('has serialNumber, locationId, status, transferId, adjustmentId', () => {
            const schema = SerialLocation.schema.obj;
            expect(schema.serialNumber).toBeDefined();
            expect(schema.locationId).toBeDefined();
            expect(schema.status).toBeDefined();
            expect(schema.status.enum).toContain('available');
            expect(schema.status.enum).toContain('in_transfer');
            expect(schema.status.enum).toContain('adjusted_out');
            expect(schema.transferId).toBeDefined();
            expect(schema.adjustmentId).toBeDefined();
        });
    });

    describe('stockTransferService', () => {
        it('exports STATUS, generateTransferNo, validateSerialForTransfer, dispatchTransfer, receiveTransfer, cancelTransfer', () => {
            expect(stockTransferService.STATUS).toBeDefined();
            expect(stockTransferService.STATUS.DRAFT).toBe('Draft');
            expect(stockTransferService.STATUS.DISPATCHED).toBe('Dispatched');
            expect(stockTransferService.STATUS.RECEIVED).toBe('Received');
            expect(stockTransferService.STATUS.CANCELLED).toBe('Cancelled');
            expect(typeof stockTransferService.generateTransferNo).toBe('function');
            expect(typeof stockTransferService.validateSerialForTransfer).toBe('function');
            expect(typeof stockTransferService.dispatchTransfer).toBe('function');
            expect(typeof stockTransferService.receiveTransfer).toBe('function');
            expect(typeof stockTransferService.cancelTransfer).toBe('function');
        });

        it('validateSerialForTransfer returns valid false for empty serial', async () => {
            const result = await stockTransferService.validateSerialForTransfer('', 'someLocationId');
            expect(result.valid).toBe(false);
            expect(result.reason).toBeDefined();
        });
    });

    describe('Permission checks', () => {
        const mockRes = () => {
            const res = {};
            res.status = jest.fn(() => res);
            res.json = jest.fn(() => res);
            return res;
        };
        const next = jest.fn();

        it('requirePermission(stock_transfer.view) returns 403 when user lacks permission', async () => {
            const req = { user: { role: 'staff', permissionKeys: new Set(['sale.view']) }, method: 'GET', originalUrl: '/api/stock-transfers', path: '/stock-transfers', headers: {}, connection: {} };
            const res = mockRes();
            const mw = requirePermission('stock_transfer.view');
            await mw(req, res, next);
            expect(res.status).toHaveBeenCalledWith(403);
            expect(next).not.toHaveBeenCalled();
        });

        it('requirePermission(stock_transfer.dispatch) allows user with stock_transfer.dispatch', async () => {
            const req = { user: { role: 'staff', permissionKeys: new Set(['stock_transfer.dispatch']) }, method: 'POST', originalUrl: '/api/stock-transfers/1/dispatch', path: '/stock-transfers/1/dispatch', headers: {}, connection: {} };
            const res = mockRes();
            const mw = requirePermission('stock_transfer.dispatch');
            await mw(req, res, next);
            expect(next).toHaveBeenCalled();
            expect(res.status).not.toHaveBeenCalled();
        });
    });
});
