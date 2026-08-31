const mongoose = require('mongoose');
const Invoice = require('../models/Invoice');
const Purchase = require('../models/Purchase');
const Tax = require('../models/Tax');
const SoldSerial = require('../models/SoldSerial');
const SerialHistory = require('../models/SerialHistory');
const GeneralSettings = require('../models/GeneralSettings');
const Customer = require('../models/Customer');
const asyncHandler = require('../middleware/asyncHandler');
const { getTenantIdFromReq } = require('../middleware/auth');
const {
    normalizePaymentBreakdown,
    computeRemainingAmountDue,
} = require('../utils/wholesalePaymentAmounts');
const transactionService = require('../services/transactionService');
const {
    decrementProductQuantitiesWithSession,
    decrementPurchaseItemQuantitiesWithSession,
} = require('../services/salesTransactionService');
const { findActiveSoldSerialsAmong } = require('../utils/activeSoldSerialQueries');
const { invalidateInventoryListCaches } = require('./purchaseController');
const serialIndexService = require('../services/serialIndexService');
const stockItemService = require('../services/stockItemService');
const EmailSettings = require('../models/EmailSettings');
const emailService = require('../lib/emailService');
const { getLondonDateUtcBounds, applySalesDateRestriction } = require('../utils/salesDateAccess');

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
        const orClause = [{ reference: re }, { customerName: re }];
        // Match by Customer.contactName / contact fields — Invoice stores only the customerName snapshot,
        // so look up matching customers (by tenant) and add their ids to the $or clause.
        const matchingCustomers = await Customer.find({
            tenantId,
            $or: [{ contactName: re }, { email: re }, { phone: re }, { mobile: re }],
        })
            .select('_id')
            .lean();
        const matchedIds = (matchingCustomers || []).map((c) => c._id).filter(Boolean);
        if (matchedIds.length > 0) {
            orClause.push({ customerId: { $in: matchedIds } });
        }
        query.$or = orClause;
    }

    const dateRestriction = applySalesDateRestriction(req.user, {
        from: req.query.from,
        to: req.query.to,
    });
    let fromUtc;
    let toUtc;
    if (dateRestriction.restricted) {
        fromUtc = dateRestriction.from;
        toUtc = dateRestriction.to;
    } else {
        const fromQ = req.query.from && String(req.query.from).trim();
        const toQ = req.query.to && String(req.query.to).trim();
        if (fromQ || toQ) {
            const bounds = getLondonDateUtcBounds(fromQ, toQ || fromQ);
            fromUtc = bounds.fromUtc;
            toUtc = bounds.toUtc;
        }
    }
    if (fromUtc && toUtc) {
        const dateClause = {
            $or: [
                { occurredAt: { $gte: fromUtc, $lte: toUtc } },
                {
                    $and: [
                        { $or: [{ occurredAt: null }, { occurredAt: { $exists: false } }] },
                        { createdAt: { $gte: fromUtc, $lte: toUtc } },
                    ],
                },
            ],
        };
        if (!query.$and) query.$and = [];
        query.$and.push(dateClause);
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));

    // Sort by effective invoice date (occurredAt, else createdAt). Plain
    // { occurredAt: -1 } pushes null occurredAt to the end, so recent invoices
    // without occurredAt vanish from page 1 on wider ranges (e.g. 30 days).
    const [items, total] = await Promise.all([
        Invoice.aggregate([
            { $match: query },
            { $addFields: { _sortDate: { $ifNull: ['$occurredAt', '$createdAt'] } } },
            { $sort: { _sortDate: -1, createdAt: -1, _id: -1 } },
            { $skip: (pageNum - 1) * pageSize },
            { $limit: pageSize },
            { $project: { _sortDate: 0 } },
        ]),
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
    const previousBalance = Number(body.previousBalance) || 0;
    const payments = normalizePaymentBreakdown(body.payments);
    const amountDue = computeRemainingAmountDue({
        total,
        discount,
        previousBalance,
        payments,
    });

    const itemsIn = Array.isArray(body.items) ? body.items : [];

    // Pre-flight: serial numbers must not already be sold.
    const serialsToCheck = [...new Set(
        itemsIn.flatMap((item) => (Array.isArray(item.serialNumbers) ? item.serialNumbers : [])
            .map((s) => (s && String(s).trim()) || '')
            .filter(Boolean))
    )];
    if (serialsToCheck.length > 0) {
        const alreadySold = await findActiveSoldSerialsAmong(serialsToCheck);
        if (alreadySold.length > 0) {
            return res.status(400).json({
                success: false,
                message: `Serial number(s) already sold: ${alreadySold.map((s) => s.serialNumber).join(', ')}`,
            });
        }
    }

    const settings = await GeneralSettings.getSettings().catch(() => ({ allowNegativeStock: false }));
    const allowNegativeStock = !!(settings && settings.allowNegativeStock);

    let invoice;
    try {
        invoice = await transactionService.runWithTransaction(async (session) => {
            const created = await Invoice.create([{
                type: body.type || 'wholesale',
                items: itemsIn,
                subtotal,
                ...taxSnapshot,
                tax: taxAmount,
                total,
                discount,
                discountType: body.discountType || 'flat',
                discountValue: Number(body.discountValue) || 0,
                previousBalance,
                amountDue,
                customerId: body.customerId || null,
                customerName: body.customerName || '',
                payments,
                bankAccount: body.bankAccount || '',
                paymentMethod: body.paymentMethod,
                soldBy: req.user ? req.user._id : null,
                occurredAt: body.occurredAt ? new Date(body.occurredAt) : new Date(),
                locationId: body.locationId || null,
                tenantId,
                note: body.note || '',
                reference: body.reference || undefined,
            }], session ? { session } : undefined);
            const inv = Array.isArray(created) ? created[0] : created;

            // SoldSerial + SerialHistory for every serial line.
            const now = new Date();
            const refLabel = inv.reference || `Invoice ${inv._id}`;
            const soldSerialDocs = [];
            for (const item of itemsIn) {
                const serials = Array.isArray(item.serialNumbers) ? item.serialNumbers : [];
                for (const s of serials) {
                    const trimmed = (s && String(s).trim()) || null;
                    if (trimmed) soldSerialDocs.push({ serialNumber: trimmed, saleId: inv._id, soldAt: now });
                }
            }
            if (soldSerialDocs.length > 0) {
                await SoldSerial.insertMany(soldSerialDocs, session ? { session } : undefined);
                const customerName = inv.customerName ? String(inv.customerName).trim() : '';
                const historyDocs = soldSerialDocs.map((d) => ({
                    serialNumber: d.serialNumber,
                    eventType: 'sold',
                    referenceType: 'Invoice',
                    referenceId: inv._id,
                    referenceLabel: refLabel,
                    customerName,
                }));
                await SerialHistory.insertMany(historyDocs, session ? { session } : undefined);
            }

            // Decrement Product.quantity (SKU-based) and Purchase.items.quantity (non-serial lines).
            await decrementProductQuantitiesWithSession(itemsIn, session, { enforceNonNegative: !allowNegativeStock });
            await decrementPurchaseItemQuantitiesWithSession(itemsIn, session, { enforceNonNegative: !allowNegativeStock });

            return inv;
        });
    } catch (err) {
        const msg = err && err.message ? err.message : 'Invoice creation failed';
        if (msg.includes('already sold')) {
            return res.status(400).json({ success: false, message: msg });
        }
        if (msg.startsWith('Insufficient stock')) {
            return res.status(400).json({ success: false, message: msg });
        }
        throw err;
    }

    // [Invoice sold] Log every line on this invoice: product, qty sold, serials, and remaining stock.
    try {
        const lines = Array.isArray(invoice.items) ? invoice.items : [];
        if (lines.length > 0) {
            const linesWithPurchase = lines.filter((i) => i.purchaseId && i.purchaseItemId);
            const purchaseIds = [...new Set(linesWithPurchase.map((i) => String(i.purchaseId)))]
                .map((id) => new mongoose.Types.ObjectId(id));
            const purchases = purchaseIds.length > 0
                ? await Purchase.find({ _id: { $in: purchaseIds } })
                    .select('items._id items.quantity items.imeis')
                    .lean()
                : [];
            const remainingByKey = new Map();
            for (const p of purchases) {
                for (const it of (p.items || [])) {
                    const qty = Number(it.quantity) || 0;
                    const imeiCount = Array.isArray(it.imeis) ? it.imeis.length : 0;
                    remainingByKey.set(`${p._id}\t${it._id}`, { qty, imeiCount });
                }
            }
            const snapshot = lines.map((i) => {
                const serials = Array.isArray(i.serialNumbers) ? i.serialNumbers.filter(Boolean) : [];
                const isSerial = serials.length > 0;
                const key = (i.purchaseId && i.purchaseItemId) ? `${i.purchaseId}\t${i.purchaseItemId}` : null;
                const rem = key ? remainingByKey.get(key) : null;
                return {
                    name: i.name,
                    sku: i.sku,
                    type: isSerial ? 'serial' : 'non-serial',
                    soldThisInvoice: Number(i.quantity) || 0,
                    serials: isSerial ? serials : undefined,
                    remainingQty: rem ? rem.qty : null,
                    remainingSerials: rem ? rem.imeiCount : null,
                };
            });
            console.info('[Invoice sold]', {
                reference: invoice.reference,
                customer: invoice.customerName || null,
                totalItems: snapshot.length,
                totalQty: snapshot.reduce((s, l) => s + l.soldThisInvoice, 0),
                lines: snapshot,
            });
        }
    } catch (err) {
        console.warn('[Invoice sold] snapshot failed:', err.message);
    }

    // Create-invoice grid uses GET /purchases?forSales=1 (30s in-memory cache). Without this,
    // sold-out lines like a single-qty "Test" item still appear until the cache TTL expires.
    await invalidateInventoryListCaches(tenantId).catch((e) => {
        console.warn('[createInvoice] cache invalidation failed (non-fatal):', e.message);
    });

    const refLabel = invoice.reference || `Invoice ${invoice._id}`;
    const customerName = invoice.customerName ? String(invoice.customerName).trim() : '';
    const soldSerials = itemsIn.flatMap((item) =>
        (Array.isArray(item.serialNumbers) ? item.serialNumbers : [])
            .map((s) => (s && String(s).trim()) || '')
            .filter(Boolean)
    );
    for (const serial of soldSerials) {
        serialIndexService.upsertSerialIndex(tenantId, {
            serial,
            status: 'sold',
            saleId: invoice._id,
            saleReferenceSnapshot: refLabel,
            customerNameSnapshot: customerName,
        }).catch(() => {});
    }
    if (soldSerials.length > 0) {
        stockItemService.markSold(soldSerials, {
            tenantId,
            saleId: invoice._id,
            customerName,
            saleReference: refLabel,
        }).catch(() => {});
    }
    for (const item of itemsIn) {
        const serials = Array.isArray(item.serialNumbers) ? item.serialNumbers : [];
        if (serials.length > 0) continue;
        const qty = Number(item.quantity) || 0;
        if (qty > 0 && item.purchaseId && item.purchaseItemId) {
            stockItemService.decrementNonSerialQty(tenantId, item.purchaseId, item.purchaseItemId, qty).catch(() => {});
        }
    }

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

    if (body.payments !== undefined) {
        invoice.payments = normalizePaymentBreakdown(body.payments);
    }
    invoice.amountDue = computeRemainingAmountDue({
        total: invoice.total,
        discount: invoice.discount,
        previousBalance: invoice.previousBalance,
        payments: invoice.payments,
    });

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

const INVC_REF_REGEX = /^INVC-(\d{6})$/;

/** Next free INVC-###### (starts after `afterRef` when provided, else after highest in DB). */
async function computeNextInvoiceReference(afterRef) {
    let seq = 1;
    const after = String(afterRef || '').trim().toUpperCase();
    const afterMatch = after.match(INVC_REF_REGEX);
    if (afterMatch) {
        seq = parseInt(afterMatch[1], 10) + 1;
    } else {
        const last = await Invoice.findOne({ reference: /^INVC-\d{6}$/ })
            .sort({ reference: -1 })
            .select('reference')
            .lean();
        if (last?.reference) {
            const m = last.reference.match(INVC_REF_REGEX);
            if (m) seq = parseInt(m[1], 10) + 1;
        }
    }
    for (let attempt = 0; attempt < 10000; attempt += 1) {
        const candidate = `INVC-${String(seq).padStart(6, '0')}`;
        const taken = await Invoice.exists({ reference: candidate });
        if (!taken) return candidate;
        seq += 1;
    }
    throw new Error('Could not allocate invoice reference');
}

const checkReference = asyncHandler(async (req, res) => {
    const ref = String(req.query.reference || '').trim().toUpperCase();
    const excludeId = req.query.excludeId ? String(req.query.excludeId).trim() : '';
    if (!ref) {
        return res.status(200).json({ success: true, data: { valid: false, exists: false } });
    }
    if (!/^[A-Z0-9\-\/_]{1,32}$/.test(ref)) {
        return res.status(200).json({ success: true, data: { valid: false, exists: false } });
    }
    const existing = await Invoice.findOne({ reference: ref }).select('_id').lean();
    const exists = Boolean(
        existing && (!excludeId || String(existing._id) !== excludeId)
    );
    let nextAvailable;
    if (exists) {
        try {
            nextAvailable = await computeNextInvoiceReference(ref);
        } catch {
            nextAvailable = undefined;
        }
    }
    res.status(200).json({
        success: true,
        data: {
            reference: ref,
            valid: true,
            exists,
            ...(nextAvailable ? { nextAvailable } : {}),
        },
    });
});

const getNextReference = asyncHandler(async (req, res) => {
    const after = String(req.query.after || '').trim().toUpperCase();
    const nextAvailable = await computeNextInvoiceReference(after || undefined);
    res.status(200).json({ success: true, data: { reference: nextAvailable } });
});

const sendInvoiceByEmail = asyncHandler(async (req, res) => {
    const invoice = await Invoice.findById(req.params.id).lean();
    if (!invoice) {
        return res.status(404).json({ success: false, message: 'Invoice not found' });
    }

    const { to, pdfBase64, filename } = req.body || {};
    const toTrim = String(to || '').trim();
    if (!toTrim) {
        return res.status(400).json({ success: false, message: 'Recipient email is required' });
    }
    if (!/^\S+@\S+\.\S+$/.test(toTrim)) {
        return res.status(400).json({ success: false, message: 'Invalid email address' });
    }
    if (!pdfBase64) {
        return res.status(400).json({ success: false, message: 'PDF attachment is required' });
    }

    const settings = await EmailSettings.getSettings();
    if (!settings || !settings.smtpHost) {
        return res.status(503).json({
            success: false,
            message: 'Email is not configured. Go to Settings → Email and save your SMTP settings.',
        });
    }

    let pdfBuffer;
    try {
        pdfBuffer = Buffer.from(String(pdfBase64), 'base64');
    } catch {
        return res.status(400).json({ success: false, message: 'Invalid PDF data' });
    }
    if (!pdfBuffer.length || pdfBuffer.length < 100) {
        return res.status(400).json({ success: false, message: 'PDF attachment is empty or invalid' });
    }

    const ref = invoice.reference || 'invoice';
    const customer = invoice.customerName || 'Customer';
    const safeFilename = String(filename || `invoice-${ref}.pdf`).replace(/[/\\]/g, '_');
    const subject = `Invoice ${ref} — ${customer}`;
    const text = `Please find attached invoice ${ref} for ${customer}.`;
    const html = `<p>Please find attached invoice <strong>${ref}</strong> for <strong>${customer}</strong>.</p>`;

    try {
        await emailService.sendWithPdfAttachment(settings, {
            to: toTrim,
            subject,
            text,
            html,
            pdfBuffer,
            filename: safeFilename,
        });
    } catch (err) {
        return res.status(502).json({
            success: false,
            message: err.message || 'Failed to send email',
        });
    }

    res.status(200).json({
        success: true,
        message: `Invoice emailed to ${toTrim}`,
    });
});

module.exports = {
    getInvoices,
    getInvoiceById,
    createInvoice,
    updateInvoice,
    voidInvoice,
    deleteInvoice,
    checkReference,
    getNextReference,
    sendInvoiceByEmail,
};
