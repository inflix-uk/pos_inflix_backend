/**
 * Low stocks: Product lowStockThreshold, InventorySettings defaultLowStockThreshold,
 * GET /api/inventory/low-stocks, threshold update audit.
 */

const Product = require('../src/models/Product');
const InventorySettings = require('../src/models/InventorySettings');
const SerialLocation = require('../src/models/SerialLocation');

describe('Low Stocks', () => {
    describe('Product model', () => {
        it('has lowStockThreshold and reorderQtyDefault fields', () => {
            const schema = Product.schema.obj;
            expect(schema.lowStockThreshold).toBeDefined();
            expect(schema.reorderQtyDefault).toBeDefined();
        });
    });

    describe('InventorySettings model', () => {
        it('has defaultLowStockThreshold with default 5', () => {
            const schema = InventorySettings.schema.obj;
            expect(schema.defaultLowStockThreshold).toBeDefined();
            expect(schema.defaultLowStockThreshold.default).toBe(5);
        });
    });

    describe('SerialLocation model', () => {
        it('has productId field for low-stock serial count', () => {
            const schema = SerialLocation.schema.obj;
            expect(schema.productId).toBeDefined();
        });
    });
});
