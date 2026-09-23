const {
    computeRemainingAmountDue,
    computeWholesaleTotalOwing,
    normalizePaymentBreakdown,
    resolveWholesaleCheckoutAmounts,
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

describe('resolveWholesaleCheckoutAmounts', () => {
    it('keeps a named account balance on the invoice', () => {
        expect(
            resolveWholesaleCheckoutAmounts({
                total: 100,
                discount: 0,
                previousBalance: 25,
                payments: { cash: 50 },
                carryAccountBalance: true,
            })
        ).toEqual({
            previousBalance: 25,
            amountDue: 75,
            payments: { cash: 50, card: 0, credit: 0, bank: 0, split: 0 },
        });
    });

    it('applies a named account store credit to the invoice', () => {
        const { previousBalance, amountDue } = resolveWholesaleCheckoutAmounts({
            total: 3435,
            discount: 0,
            previousBalance: -810,
            payments: { credit: 2625 },
            carryAccountBalance: true,
        });
        expect(previousBalance).toBe(-810);
        expect(amountDue).toBe(2625);
    });

    it('never charges a walk-in sale for the shared account balance', () => {
        // INV-012150: £30 sale billed at £64.48 because the shared account owed £34.48.
        const { previousBalance, amountDue } = resolveWholesaleCheckoutAmounts({
            total: 30,
            discount: 0,
            previousBalance: 34.48,
            payments: { credit: 64.48 },
            carryAccountBalance: false,
        });
        expect(previousBalance).toBe(0);
        expect(amountDue).toBe(30);
    });

    it('never pays a walk-in sale from the shared account credit', () => {
        // INV-012145: £8 sale that collected nothing because the shared account held credit.
        const { previousBalance, amountDue, payments } = resolveWholesaleCheckoutAmounts({
            total: 8,
            discount: 0,
            previousBalance: -13.52,
            payments: { credit: 0 },
            carryAccountBalance: false,
        });
        expect(previousBalance).toBe(0);
        expect(amountDue).toBe(8);
        expect(payments.credit).toBe(0);
    });

    it('re-derives credit from the amount actually due for a walk-in sale', () => {
        const paidInFull = resolveWholesaleCheckoutAmounts({
            total: 30,
            discount: 0,
            previousBalance: 34.48,
            payments: { card: 64.48, credit: 0 },
            carryAccountBalance: false,
        });
        expect(paidInFull.amountDue).toBe(0);
        expect(paidInFull.payments.credit).toBe(0);

        const unpaid = resolveWholesaleCheckoutAmounts({
            total: 30,
            discount: 0,
            previousBalance: 34.48,
            payments: { credit: 64.48 },
            carryAccountBalance: false,
        });
        expect(unpaid.payments.credit).toBe(30);
    });

    it('carries the balance by default, so an unset flag keeps today behaviour', () => {
        const { previousBalance, amountDue } = resolveWholesaleCheckoutAmounts({
            total: 100,
            discount: 0,
            previousBalance: 25,
            payments: {},
        });
        expect(previousBalance).toBe(25);
        expect(amountDue).toBe(125);
    });
});
