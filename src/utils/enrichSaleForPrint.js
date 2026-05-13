const Customer = require('../models/Customer');

/**
 * Attach customerPhone / customerEmail from linked Customer for receipts (PDF + ESC/POS).
 * Sale document only stores customerId + customerName by default.
 */
async function enrichSaleWithCustomerContact(sale) {
    if (!sale || !sale.customerId) return sale;
    try {
        const c = await Customer.findById(sale.customerId).select('phone mobile email').lean();
        if (!c) return sale;
        const phone = String(c.phone || '').trim() || String(c.mobile || '').trim();
        const email = String(c.email || '').trim();
        return {
            ...sale,
            ...(phone ? { customerPhone: phone } : {}),
            ...(email ? { customerEmail: email } : {}),
        };
    } catch {
        return sale;
    }
}

module.exports = { enrichSaleWithCustomerContact };
