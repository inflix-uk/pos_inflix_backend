/**
 * Per-customer credit rules for wholesale checkout.
 *
 * - creditAllowed === false: a sale may not leave anything owing on the account
 *   (store credit the customer already holds can still be spent).
 * - creditLimit > 0: the account balance after the sale may not exceed the limit.
 *   0 / unset means no limit.
 *
 * A positive customer.balance means the customer owes the shop; negative is store credit.
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const EPSILON = 0.01;

/** Normalise a creditLimit value from a request body. Returns a number >= 0, or null when invalid. */
function normalizeCreditLimit(value) {
    if (value === undefined) return undefined;
    if (value === null || value === '') return 0;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return null;
    return round2(n);
}

/** Normalise a creditAllowed value from a request body (accepts booleans and "true"/"false"). */
function normalizeCreditAllowed(value) {
    if (value === undefined) return undefined;
    if (typeof value === 'boolean') return value;
    if (value === 'false' || value === 0 || value === '0') return false;
    return true;
}

/**
 * Check a sale against the customer's credit settings.
 * @param {{ balance?: number, creditAllowed?: boolean, creditLimit?: number, isWalkIn?: boolean } | null} customer
 * @param {number} balanceIncrease  How much this sale adds to the account balance (sale net − paid now).
 * @returns {{ ok: true } | { ok: false, code: 'CREDIT_NOT_ALLOWED' | 'CREDIT_LIMIT_EXCEEDED', message: string, creditLimit?: number, currentBalance: number, newBalance: number, availableCredit?: number }}
 */
function evaluateCustomerCredit(customer, balanceIncrease) {
    if (!customer || customer.isWalkIn) return { ok: true };
    const increase = round2(balanceIncrease);
    if (increase <= EPSILON) return { ok: true };

    const currentBalance = round2(customer.balance);
    const newBalance = round2(currentBalance + increase);
    // Fully covered by store credit the customer already holds.
    if (newBalance <= EPSILON) return { ok: true };

    if (customer.creditAllowed === false) {
        return {
            ok: false,
            code: 'CREDIT_NOT_ALLOWED',
            message: 'This customer is not allowed credit. Take full payment for this sale.',
            currentBalance,
            newBalance
        };
    }

    const limit = round2(customer.creditLimit);
    if (limit > 0 && newBalance > limit + EPSILON) {
        const availableCredit = round2(Math.max(0, limit - Math.max(0, currentBalance)));
        return {
            ok: false,
            code: 'CREDIT_LIMIT_EXCEEDED',
            message:
                `Credit limit exceeded. Limit £${limit.toFixed(2)}, current balance £${currentBalance.toFixed(2)}, ` +
                `this sale would make it £${newBalance.toFixed(2)}. Available credit: £${availableCredit.toFixed(2)}.`,
            creditLimit: limit,
            currentBalance,
            newBalance,
            availableCredit
        };
    }
    return { ok: true };
}

module.exports = { evaluateCustomerCredit, normalizeCreditLimit, normalizeCreditAllowed };
