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

module.exports = {
    round2,
    normalizePaymentBreakdown,
    computeWholesaleTotalOwing,
    computeWholesalePaidNow,
    computeRemainingAmountDue
};