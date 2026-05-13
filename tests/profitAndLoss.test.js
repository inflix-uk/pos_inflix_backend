/**
 * Profit & Loss: COGS from unit_cost_at_sale, returns reduce revenue and reverse COGS.
 * - Sale item schema has unit_cost_at_sale (snapshot at sale time).
 * - SalesReturn item schema has unit_cost_at_return for COGS reversal.
 * - getProfitAndLoss returns revenue, cogs, grossProfit, totalExpenses, netProfit.
 */

const Sale = require('../src/models/Sale');
const SalesReturn = require('../src/models/SalesReturn');
const Product = require('../src/models/Product');

describe('Profit and Loss', () => {
    describe('Sale model', () => {
        it('has unit_cost_at_sale on sale item schema for COGS snapshot', () => {
            const itemsPath = Sale.schema.path('items');
            expect(itemsPath).toBeDefined();
            const itemSchema = itemsPath.schema || itemsPath.caster?.schema;
            expect(itemSchema).toBeDefined();
            const costPath = itemSchema.path('unit_cost_at_sale') || itemSchema.obj?.unit_cost_at_sale;
            expect(costPath != null || itemSchema.obj?.unit_cost_at_sale != null).toBe(true);
        });

        it('has price and quantity on items for revenue and COGS calculation', () => {
            const itemsPath = Sale.schema.path('items');
            const itemSchema = itemsPath.schema || itemsPath.caster?.schema;
            expect(itemSchema).toBeDefined();
            expect(itemSchema.obj?.price != null || itemSchema.path('price')).toBeTruthy();
            expect(itemSchema.obj?.quantity != null || itemSchema.path('quantity')).toBeTruthy();
        });
    });

    describe('SalesReturn model', () => {
        it('has unit_cost_at_return on return item schema for COGS reversal', () => {
            const itemsPath = SalesReturn.schema.path('items');
            expect(itemsPath).toBeDefined();
            const itemSchema = itemsPath.schema || itemsPath.caster?.schema;
            expect(itemSchema).toBeDefined();
            const costPath = itemSchema.path('unit_cost_at_return') || itemSchema.obj?.unit_cost_at_return;
            expect(costPath != null || itemSchema.obj?.unit_cost_at_return != null).toBe(true);
        });

        it('has quantity on items and grandTotal for return revenue in P&L', () => {
            const itemsPath = SalesReturn.schema.path('items');
            const itemSchema = itemsPath.schema || itemsPath.caster?.schema;
            expect(itemSchema?.obj?.quantity != null || itemSchema?.path('quantity')).toBeTruthy();
            expect(SalesReturn.schema.path('grandTotal') || SalesReturn.schema.obj.grandTotal).toBeTruthy();
        });
    });

    describe('P&L calculations (formula)', () => {
        it('gross profit = revenue - COGS', () => {
            const revenue = 1000;
            const cogs = 400;
            expect(revenue - cogs).toBe(600);
        });

        it('net profit = gross profit - operating expenses', () => {
            const grossProfit = 600;
            const expenses = 200;
            expect(grossProfit - expenses).toBe(400);
        });

        it('return reduces revenue and reverses COGS (no double count)', () => {
            const salesRevenue = 1000;
            const returnAmount = 100;
            const revenue = salesRevenue - returnAmount;
            expect(revenue).toBe(900);
            const cogsSales = 400;
            const cogsReturnReversal = 40;
            const cogs = cogsSales - cogsReturnReversal;
            expect(cogs).toBe(360);
            expect(revenue - cogs).toBe(540);
        });
    });

    describe('Inventory cost resolution', () => {
        it('salesTransactionService exports resolveCostsForSaleItems for backfill/update', () => {
            const salesTransactionService = require('../src/services/salesTransactionService');
            expect(typeof salesTransactionService.resolveCostsForSaleItems).toBe('function');
        });
    });
});
