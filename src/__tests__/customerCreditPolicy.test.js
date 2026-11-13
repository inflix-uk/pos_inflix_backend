const {
    evaluateCustomerCredit,
    normalizeCreditLimit,
    normalizeCreditAllowed
} = require('../utils/customerCreditPolicy');

describe('evaluateCustomerCredit', () => {
    test('fully paid sale is always allowed', () => {
        expect(evaluateCustomerCredit({ balance: 0, creditAllowed: false }, 0).ok).toBe(true);
        expect(evaluateCustomerCredit({ balance: 500, creditAllowed: false }, 0).ok).toBe(true);
    });

    test('credit not allowed blocks an unpaid remainder', () => {
        const r = evaluateCustomerCredit({ balance: 0, creditAllowed: false }, 50);
        expect(r.ok).toBe(false);
        expect(r.code).toBe('CREDIT_NOT_ALLOWED');
    });

    test('credit not allowed still lets existing store credit be spent', () => {
        expect(evaluateCustomerCredit({ balance: -100, creditAllowed: false }, 80).ok).toBe(true);
        expect(evaluateCustomerCredit({ balance: -100, creditAllowed: false }, 120).ok).toBe(false);
    });

    test('credit allowed with no limit (0) allows any amount', () => {
        expect(evaluateCustomerCredit({ balance: 0, creditAllowed: true, creditLimit: 0 }, 1e6).ok).toBe(true);
        // Legacy customers without the fields default to allowed / no limit.
        expect(evaluateCustomerCredit({ balance: 0 }, 1e6).ok).toBe(true);
    });

    test('credit limit is checked against balance after the sale', () => {
        const customer = { balance: 4000, creditAllowed: true, creditLimit: 5000 };
        expect(evaluateCustomerCredit(customer, 1000).ok).toBe(true);
        const r = evaluateCustomerCredit(customer, 1000.5);
        expect(r.ok).toBe(false);
        expect(r.code).toBe('CREDIT_LIMIT_EXCEEDED');
        expect(r.availableCredit).toBe(1000);
        expect(r.newBalance).toBe(5000.5);
    });

    test('walk-in account is never blocked', () => {
        expect(evaluateCustomerCredit({ isWalkIn: true, creditAllowed: false }, 100).ok).toBe(true);
    });
});

describe('normalizers', () => {
    test('normalizeCreditLimit', () => {
        expect(normalizeCreditLimit(undefined)).toBeUndefined();
        expect(normalizeCreditLimit('')).toBe(0);
        expect(normalizeCreditLimit(null)).toBe(0);
        expect(normalizeCreditLimit('10000')).toBe(10000);
        expect(normalizeCreditLimit(-1)).toBeNull();
        expect(normalizeCreditLimit('abc')).toBeNull();
    });

    test('normalizeCreditAllowed', () => {
        expect(normalizeCreditAllowed(undefined)).toBeUndefined();
        expect(normalizeCreditAllowed(false)).toBe(false);
        expect(normalizeCreditAllowed('false')).toBe(false);
        expect(normalizeCreditAllowed(true)).toBe(true);
        expect(normalizeCreditAllowed('true')).toBe(true);
    });
});
