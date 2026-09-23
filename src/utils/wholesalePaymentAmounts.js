const round2 = (n) => Math.round(Number(n) * 100) / 100;

function normalizePaymentBreakdown(payments = {}) {
    return {
        cash: round2(Number(payments.cash) || 0),
        card: round2(Number(payments.card) || 0),
        credit: round2(Number(payments.credit) || 0),
        bank: round2(Number(payments.bank) || 0),
        split: round2(Number(payments.split) || 0)
    };
}

/** Invoice/sale total owing before payments (previous balance + net invoice). */
function computeWholesaleTotalOwing({ total, discount, previousBalance }) {
    const net = round2((Number(total) || 0) - (Number(discount) || 0));
    return round2((Number(previousBalance) || 0) + net);
}

function computeWholesalePaidNow(payments = {}) {
    return round2(
        (Number(payments.cash) || 0) +
        (Number(payments.card) || 0) +
        (Number(payments.bank) || 0)
    );
}

/** Remaining balance after cash/card/bank received at checkout. */
function computeRemainingAmountDue(fields) {
    const totalOwing = computeWholesaleTotalOwing(fields);
    const paidNow = computeWholesalePaidNow(fields.payments);
    return round2(Math.max(0, totalOwing - paidNow));
}

/**
 * Checkout amounts stored on a wholesale sale.
 * With `carryAccountBalance` false the sale stands alone: what the account owes is not added and
 * its store credit is not spent. That is always the case for the shared Walk-in account, whose
 * balance belongs to earlier walk-in customers, and company-wide when the setting is off. Credit
 * is the unpaid remainder, so it is re-derived once the balance is dropped (an older client sizes
 * it against the balance it still had).
 */
function resolveWholesaleCheckoutAmounts({ total, discount, previousBalance, payments, carryAccountBalance = true }) {
    const breakdown = normalizePaymentBreakdown(payments);
    const prev = carryAccountBalance ? round2(Number(previousBalance) || 0) : 0;
    const amountDue = computeRemainingAmountDue({ total, discount, previousBalance: prev, payments: breakdown });
    if (!carryAccountBalance) breakdown.credit = Math.min(breakdown.credit, amountDue);
    return { previousBalance: prev, amountDue, payments: breakdown };
}

/** Build payments breakdown from a single method + amount (retail/repair checkout). */
function paymentBreakdownFromMethod(method, amount) {
    const payments = { cash: 0, card: 0, credit: 0, bank: 0, split: 0 };
    const m = String(method || 'cash').toLowerCase();
    const amt = round2(Number(amount) || 0);
    if (m === 'cash') payments.cash = amt;
    else if (m === 'card') payments.card = amt;
    else if (m === 'bank') payments.bank = amt;
    else if (m === 'credit') payments.credit = amt;
    return payments;
}

module.exports = {
    round2,
    normalizePaymentBreakdown,
    computeWholesaleTotalOwing,
    computeWholesalePaidNow,
    computeRemainingAmountDue,
    resolveWholesaleCheckoutAmounts,
    paymentBreakdownFromMethod
};