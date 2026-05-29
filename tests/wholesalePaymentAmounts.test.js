const {
    computeRemainingAmountDue,
    computeWholesaleTotalOwing,
    normalizePaymentBreakdown,
} = require('../src/utils/wholesalePaymentAmounts');

describe('wholesalePaymentAmounts', () => {
    it('computes remaining amount due after cash/card/bank received', () => {
        const payments = normalizePaymentBreakdown({ cash: 100, card: 0, credit: 0, bank: 0 });
        expect(
            computeRemainingAmountDue({
                total: 100,
                discount: 0,
                previousBalance: 0,
                payments,
            })
        ).toBe(0);
    });

    it('includes previous balance in checkout total', () => {
        const payments = normalizePaymentBreakdown({ cash: 50, card: 0, credit: 0, bank: 0 });
        expect(
            computeWholesaleTotalOwing({
                total: 100,
                discount: 0,
                previousBalance: 25,
            })
        ).toBe(125);
        expect(
            computeRemainingAmountDue({
                total: 100,
                discount: 0,
                previousBalance: 25,
                payments,
            })
        ).toBe(75);
    });

    it('applies discount before computing balance due', () => {
        const payments = normalizePaymentBreakdown({ cash: 80, card: 0, credit: 0, bank: 0 });
        expect(
            computeRemainingAmountDue({
                total: 100,
                discount: 20,
                previousBalance: 0,
                payments,
            })
        ).toBe(0);
    });
});
