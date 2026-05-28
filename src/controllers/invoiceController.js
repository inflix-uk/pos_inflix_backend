const Invoice = require('../models/Invoice');
const Tax = require('../models/Tax');
const asyncHandler = require('../middleware/asyncHandler');
const { getTenantIdFromReq } = require('../middleware/auth');

function escapeRegex(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;

/** Resolve a tax category id into a snapshot { taxId, taxName, taxRate, taxType }. */
async function resolveTaxSnapshot(taxId) {
    if (!taxId) return { taxId: null, taxName: '', taxRate: 0, taxType: '' };
    const tax = await Tax.findById(taxId).lean();
    if (!tax) return { taxId: null, taxName: '', taxRate: 0, taxType: '' };
    return {
        taxId: tax._id,
        taxName: tax.name || '',
        taxRate: Number(tax.rate) || 0,
        taxType: tax.type === 'fixed' ? 'flat' : (tax.type || 'percentage'),
    };
}

function computeTaxAmount(subtotal, snapshot) {
    if (!snapshot || !snapshot.taxRate) return 0;
    if (snapshot.taxType === 'percentage') return round2(subtotal * (snapshot.taxRate / 100));
    return round2(snapshot.taxRate);
}

const getInvoices = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const { search, type, status = 'active', limit = 100, page = 1 } = req.query;
    const query = { tenantId };
    if (status !== 'all') query.status = status === 'voided' ? 'voided' : { $ne: 'voided' };
    if (type && type !== 'all') query.type = type;
    if (search) {
        const re = new RegExp(escapeRegex(search), 'i');
        query.$or = [{ reference: re }, { customerName: re }];
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));

    const [items, total] = await Promise.all([
        Invoice.find(query)
            .sort({ occurredAt: -1, createdAt: -1 })
            .skip((pageNum - 1) * pageSize)
            .limit(pageSize)
            .lean(),
        Invoice.countDocuments(query),
    ]);

    res.status(200).json({
        success: true,
        data: items,
        meta: { page: pageNum, limit: pageSize, total },
    });
});

const getInvoiceById = asyncHandler(async (req, res) => {
    const invoice = await Invoice.findById(req.params.id).lean();
    if (!invoice) {
        return res.status(404).json({ success: false, message: 'Invoice not found' });
    }
    res.status(200).json({ success: true, data: invoice });
});

const createInvoice = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const body = req.body || {};

    const subtotal = Number(body.subtotal) || 0;
    const taxSnapshot = await resolveTaxSnapshot(body.taxId);
    const taxAmount = body.tax != null ? Number(body.tax) : computeTaxAmount(subtotal, taxSnapshot);
    const discount = Number(body.discount) || 0;
    const total = body.total != null ? Number(body.total) : round2(subtotal + taxAmount - discount);

    const invoice = await Invoice.create({
        type: body.type || 'wholesale',
        items: Array.isArray(body.items) ? body.items : [],
        subtotal,
        ...taxSnapshot,
        tax: taxAmount,
        total,
        discount,
        discountType: body.discountType || 'flat',
        discountValue: Number(body.discountValue) || 0,
        previousBalance: Number(body.previousBalance) || 0,
        amountDue: Number(body.amountDue) || 0,
        customerId: body.customerId || null,
        customerName: body.customerName || '',
        payments: body.payments || {},
        bankAccount: body.bankAccount || '',
        paymentMethod: body.paymentMethod,
        soldBy: req.user ? req.user._id : null,
        occurredAt: body.occurredAt ? new Date(body.occurredAt) : null,
        locationId: body.locationId || null,
        tenantId,
        note: body.note || '',
        reference: body.reference || undefined,
    });

    res.status(201).json({ success: true, data: invoice });
});

const updateInvoice = asyncHandler(async (req, res) => {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) {
        return res.status(404).json({ success: false, message: 'Invoice not found' });
    }

    const body = req.body || {};
    const updatable = [
        'type', 'items', 'subtotal', 'tax', 'total', 'discount', 'discountType',
        'discountValue', 'previousBalance', 'amountDue', 'customerId', 'customerName',
        'payments', 'bankAccount', 'paymentMethod', 'locationId', 'note', 'occurredAt',
    ];
    for (const key of updatable) {
        if (body[key] !== undefined) invoice[key] = body[key];
    }

    if (body.taxId !== undefined) {
        const snap = await resolveTaxSnapshot(body.taxId);
        invoice.taxId = snap.taxId;
        invoice.taxName = snap.taxName;
        invoice.taxRate = snap.taxRate;
        invoice.taxType = snap.taxType;
        if (body.tax === undefined) {
            invoice.tax = computeTaxAmount(invoice.subtotal, snap);
        }
    }

    await invoice.save();
    res.status(200).json({ success: true, data: invoice });
});

const voidInvoice = asyncHandler(async (req, res) => {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) {
        return res.status(404).json({ success: false, message: 'Invoice not found' });
    }
    invoice.status = 'voided';
    invoice.voidedAtUtc = new Date();
    invoice.voidedByUserId = req.user ? req.user._id : null;
    invoice.voidReason = (req.body && req.body.reason) || '';
    await invoice.save();
    res.status(200).json({ success: true, data: invoice });
});

const deleteInvoice = asyncHandler(async (req, res) => {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) {
        return res.status(404).json({ success: false, message: 'Invoice not found' });
    }
    await invoice.deleteOne();
    res.status(200).json({ success: true, data: { _id: invoice._id } });
});

const checkReference = asyncHandler(async (req, res) => {
    const ref = String(req.query.reference || '').trim().toUpperCase();
    if (!ref) {
        return res.status(200).json({ success: true, data: { valid: false, exists: false } });
    }
    if (!/^[A-Z0-9\-\/_]{1,32}$/.test(ref)) {
        return res.status(200).json({ success: true, data: { valid: false, exists: false } });
    }
    const exists = await Invoice.exists({ reference: ref });
    res.status(200).json({ success: true, data: { valid: true, exists: !!exists } });
});

module.exports = {
    getInvoices,
    getInvoiceById,
    createInvoice,
    updateInvoice,
    voidInvoice,
    deleteInvoice,
    checkReference,
};
