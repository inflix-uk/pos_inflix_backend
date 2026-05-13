/**
 * Expense module: model enums, schema (workflow, no hard delete).
 */

const Expense = require('../src/models/Expense');
const ExpenseCategory = require('../src/models/ExpenseCategory');

describe('Expenses', () => {
    describe('ExpenseCategory model', () => {
        it('exports COST_CENTRES', () => {
            expect(ExpenseCategory.COST_CENTRES).toEqual(['Sales', 'Repairs', 'Warehouse', 'Admin', 'General']);
        });
    });

    describe('Expense model', () => {
        it('exports STATUSES including Draft, Submitted, Approved, Paid, Rejected, Voided', () => {
            const statuses = Expense.STATUSES;
            expect(statuses).toContain('Draft');
            expect(statuses).toContain('Submitted');
            expect(statuses).toContain('Approved');
            expect(statuses).toContain('Paid');
            expect(statuses).toContain('Rejected');
            expect(statuses).toContain('Voided');
        });

        it('exports PAYMENT_METHODS', () => {
            expect(Expense.PAYMENT_METHODS).toContain('Cash');
            expect(Expense.PAYMENT_METHODS).toContain('BankTransfer');
            expect(Expense.PAYMENT_METHODS).toContain('Card');
        });

        it('supports soft delete via Voided status and voidReason', () => {
            const schemaObj = Expense.schema.obj;
            expect(schemaObj.status.enum).toContain('Voided');
            expect(schemaObj.voidReason).toBeDefined();
        });

        it('has amount fields and validation (amountNet, vatAmount, amountGross)', () => {
            const schemaObj = Expense.schema.obj;
            expect(schemaObj.amountNet).toBeDefined();
            expect(schemaObj.vatAmount).toBeDefined();
            expect(schemaObj.amountGross).toBeDefined();
        });
    });
});
