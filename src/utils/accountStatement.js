/**
 * Account statement helpers: date range parsing and debit/credit/running-balance rows.
 *
 * Ledger amounts are signed: + raises the account balance (customer owes us more / we owe the
 * supplier more), − lowers it. On a customer statement a raise is a debit (invoice) and a
 * lowering is a credit (payment); on a supplier statement it is the other way round.
 */
const { getLondonDayStart } = require('./dateKey');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function londonDayStartFor(y, m, d) {
    return getLondonDayStart(new Date(Date.UTC(y, m - 1, d, 12)));
}

/** `from` / `to` query values → Dates. A bare YYYY-MM-DD is a London calendar day and `to` includes all of it. */
function parseStatementRange(query = {}) {
    const bound = (value, endOfDay) => {
        if (!value) return null;
        const s = String(value).trim();
        if (DATE_ONLY.test(s)) {
            const [y, m, d] = s.split('-').map(Number);
            return endOfDay
                ? new Date(londonDayStartFor(y, m, d + 1).getTime() - 1)
                : londonDayStartFor(y, m, d);
        }
        const dt = new Date(s);
        return Number.isNaN(dt.getTime()) ? null : dt;
    };
    return { from: bound(query.from, false), to: bound(query.to, true) };
}

/** Mongo `date` condition for the range, or null when unbounded. */
function dateMatchForRange({ from, to }) {
    if (!from && !to) return null;
    const cond = {};
    if (from) cond.$gte = from;
    if (to) cond.$lte = to;
    return cond;
}

function compareEntries(a, b) {
    const byDate = new Date(a.date) - new Date(b.date);
    if (byDate !== 0) return byDate;
    return String(a._id).localeCompare(String(b._id));
}

/**
 * Oldest-first statement lines with debit, credit and the balance after each line.
 * @param {Array} entries ledger entries inside the period
 * @param {number} openingBalance balance carried in from before the period
 * @param {'debit'|'credit'} increasesAs column that carries a positive ledger amount
 */
function buildStatementRows(entries, openingBalance, increasesAs) {
    let balance = round2(openingBalance);
    let totalDebit = 0;
    let totalCredit = 0;
    const lines = [...entries].sort(compareEntries).map((e) => {
        const amount = round2(e.amount);
        const up = amount > 0 ? amount : 0;
        const down = amount < 0 ? round2(-amount) : 0;
        const debit = increasesAs === 'debit' ? up : down;
        const credit = increasesAs === 'debit' ? down : up;
        balance = round2(balance + amount);
        totalDebit = round2(totalDebit + debit);
        totalCredit = round2(totalCredit + credit);
        return {
            _id: e._id,
            type: e.type,
            amount,
            debit,
            credit,
            balance,
            referenceId: e.referenceId || undefined,
            referenceLabel: e.referenceLabel,
            date: e.date,
            paymentMethod: e.paymentMethod || undefined,
            note: e.note || undefined
        };
    });
    return {
        openingBalance: round2(openingBalance),
        closingBalance: balance,
        totals: { debit: totalDebit, credit: totalCredit },
        lines
    };
}

const serialsOf = (list) => (Array.isArray(list) ? list.filter(Boolean) : []);

/** Invoice summary for a statement line: what was sold, at what price. */
function saleDetails(sale) {
    const items = (sale.items || []).map((it) => {
        const quantity = Number(it.quantity) || 0;
        const price = round2(it.price);
        return {
            name: it.name || it.sku || 'Item',
            sku: it.sku || undefined,
            quantity,
            price,
            total: round2(price * quantity),
            serialNumbers: serialsOf(it.serialNumbers)
        };
    });
    const discount = round2(sale.discount);
    return {
        kind: 'invoice',
        reference: sale.reference || undefined,
        date: sale.occurredAt || sale.createdAt || undefined,
        status: sale.status || undefined,
        items,
        subtotal: round2(sale.total),
        discount,
        total: round2((Number(sale.total) || 0) - discount)
    };
}

/** Return summary for a statement line: what came back, at what price. */
function returnDetails(ret) {
    const items = (ret.items || []).map((it) => ({
        name: it.product || it.sku || 'Item',
        sku: it.sku || undefined,
        quantity: Number(it.quantity) || 0,
        price: round2(it.netUnitPrice),
        total: round2(it.subtotal),
        serialNumbers: serialsOf(it.serialNumbers)
    }));
    return {
        kind: 'return',
        reference: ret.reference || undefined,
        linkedInvoiceRef: ret.linkedInvoiceRef || undefined,
        date: ret.date || ret.createdAt || undefined,
        items,
        subtotal: round2(ret.total),
        discount: round2(ret.discount),
        total: round2(ret.grandTotal)
    };
}

/**
 * Adds `details` (items sold or returned) to lines whose referenceId is a sale or a sales return.
 * Lines with no matching document are left as they are.
 */
function attachLineDetails(lines, sales = [], returns = []) {
    const byId = new Map();
    for (const s of sales) byId.set(String(s._id), saleDetails(s));
    for (const r of returns) byId.set(String(r._id), returnDetails(r));
    return lines.map((line) => {
        const details = line.referenceId ? byId.get(String(line.referenceId)) : null;
        return details ? { ...line, details } : line;
    });
}

module.exports = { parseStatementRange, dateMatchForRange, buildStatementRows, attachLineDetails, round2 };
