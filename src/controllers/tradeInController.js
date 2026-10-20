const TradeIn = require('../models/TradeIn');
const TradeInFile = require('../models/TradeInFile');
const NotesTermsSettings = require('../models/NotesTermsSettings');
const AboutSettings = require('../models/AboutSettings');
const asyncHandler = require('../middleware/asyncHandler');
const { getTenantIdFromReq } = require('../middleware/auth');
const activityLogService = require('../services/activityLogService');
const { createPurchaseRecord } = require('./purchaseController');
const svc = require('../services/tradeInService');
const { resolveLocationForPrint } = require('../utils/printLocationHelper');

const userIdOf = (req) => (req.user && (req.user._id || req.user.id)) || null;

function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function notFound(res) {
    return res.status(404).json({
        success: false,
        message: 'Trade-in not found. Unfinished trade-ins are removed after 24 hours — please start a new one.'
    });
}

/** Strip fields we never want from the client before handing items to the purchase code. */
function sanitizeItems(items) {
    const allowed = [
        'name', 'barcode', 'sendTo', 'tax', 'category', 'subCategory', 'grade', 'brand', 'brandModel',
        'capacity', 'colour', 'variantValues', 'purchasePrice', 'salePrice', 'quantity', 'isOtherItem', 'note'
    ];
    return (items || []).map((raw) => {
        const it = {};
        for (const k of allowed) {
            if (raw[k] !== undefined && raw[k] !== null && raw[k] !== '') it[k] = raw[k];
        }
        it.isOtherItem = !!raw.isOtherItem;
        if (!it.isOtherItem) {
            it.imeis = (Array.isArray(raw.imeis) ? raw.imeis : [])
                .map((x) => String(x || '').trim())
                .filter(Boolean);
        }
        return it;
    });
}

async function loadFilesMeta(tradeInId) {
    const files = await TradeInFile.find({ tradeInId }).select('-data').sort({ kind: 1 }).lean();
    return files.map(svc.fileMeta);
}

function publicTradeIn(doc) {
    const t = doc.toObject ? doc.toObject() : { ...doc };
    delete t.uploadTokenHash;
    delete t.completing;
    delete t.completingAt;
    return t;
}

/** Save (or replace) one image on a draft trade-in and push the draft's expiry forward. */
async function saveDraftFile(draft, kind, dataUrl, { uploadedVia, uploadedBy }) {
    const img = await svc.processUploadedImage(kind, dataUrl);
    const expiresAt = svc.draftExpiry();
    const file = await TradeInFile.findOneAndUpdate(
        { tradeInId: draft._id, kind },
        {
            $set: {
                mimeType: img.mimeType,
                data: img.data,
                size: img.size,
                width: img.width,
                height: img.height,
                uploadedVia,
                uploadedBy: uploadedBy || null,
                tenantId: draft.tenantId,
                expiresAt
            }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true, projection: { data: 0 } }
    );
    await TradeIn.updateOne({ _id: draft._id }, { $set: { expiresAt } });
    return svc.fileMeta(file);
}

// ───────────────────────────── Staff endpoints ─────────────────────────────

// @desc    List trade-ins (completed by default)
// @route   GET /api/trade-ins?search=&status=completed|draft|all&page=&limit=
// @access  Private (tradein.view)
exports.getTradeIns = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const status = String(req.query.status || 'completed').toLowerCase();

    const filter = { tenantId };
    if (status === 'completed' || status === 'draft') filter.status = status;

    const search = String(req.query.search || '').trim();
    if (search) {
        const rx = new RegExp(escapeRegex(search), 'i');
        filter.$or = [
            { reference: rx },
            { purchaseNumber: rx },
            { 'customer.name': rx },
            { 'customer.phone': rx },
            { 'customer.email': rx },
            { 'items.imeis': rx },
            { 'items.description': rx }
        ];
    }

    const sort = filter.status === 'draft' ? { createdAt: -1 } : { completedAt: -1, createdAt: -1 };
    const [data, total] = await Promise.all([
        TradeIn.find(filter)
            .select('-termsText -uploadTokenHash -completing -completingAt')
            .populate('completedBy', 'name')
            .sort(sort)
            .skip((page - 1) * limit)
            .limit(limit)
            .lean(),
        TradeIn.countDocuments(filter)
    ]);

    res.json({ success: true, data, total, page, pages: Math.max(1, Math.ceil(total / limit)) });
});

// @desc    Terms text + shop details for the trade-in page and PDF (staff may not have Settings access)
// @route   GET /api/trade-ins/meta
// @access  Private (tradein.view | tradein.create)
exports.getTradeInMeta = asyncHandler(async (req, res) => {
    const [settings, about] = await Promise.all([
        NotesTermsSettings.getSettings().catch(() => null),
        AboutSettings.getSettings().catch(() => null)
    ]);
    res.json({
        success: true,
        data: {
            termsText: String((settings && settings.tradeInTerms) || '').trim(),
            about: {
                appName: (about && about.appName) || '',
                appTitle: (about && about.appTitle) || '',
                companyAddress: (about && about.companyAddress) || '',
                companyNumber: (about && about.companyNumber) || '',
                vatNumber: (about && about.vatNumber) || '',
                logo: (about && about.logo) || null
            }
        }
    });
});

// @desc    Start a draft trade-in (needed before photos / phone QR / completion)
// @route   POST /api/trade-ins/drafts
// @access  Private (tradein.create)
exports.createDraft = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const draft = await TradeIn.create({
        tenantId,
        status: 'draft',
        createdBy: userIdOf(req),
        expiresAt: svc.draftExpiry()
    });
    res.status(201).json({ success: true, data: publicTradeIn(draft) });
});

// @desc    Get one trade-in with its file list (no image bytes)
// @route   GET /api/trade-ins/:id
// @access  Private (tradein.view | tradein.create)
exports.getTradeIn = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const doc = await TradeIn.findOne({ _id: req.params.id, tenantId })
        .populate('createdBy', 'name')
        .populate('completedBy', 'name')
        .lean();
    if (!doc) return notFound(res);
    const files = await loadFilesMeta(doc._id);
    const data = publicTradeIn(doc);
    data.files = files;
    if (doc.status === 'completed') {
        // PDF header: the shop the devices went to (staff may not be allowed to read Locations).
        const firstLocationId = (doc.items || []).map((it) => it.locationId).find(Boolean) || null;
        const { location } = await resolveLocationForPrint(firstLocationId).catch(() => ({ location: null }));
        data.location = location || null;
    }
    data.uploadLinkActive = !!(doc.uploadTokenHash && doc.uploadTokenExpiresAt && new Date(doc.uploadTokenExpiresAt) > new Date());
    res.json({ success: true, data });
});

// @desc    Get trade-in images as data URLs (for preview + PDF)
// @route   GET /api/trade-ins/:id/files?kinds=id_front,id_back
// @access  Private (tradein.view | tradein.create)
exports.getTradeInFiles = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const exists = await TradeIn.exists({ _id: req.params.id, tenantId });
    if (!exists) return notFound(res);
    const filter = { tradeInId: req.params.id };
    const kinds = String(req.query.kinds || '').split(',').map((k) => k.trim()).filter((k) => svc.FILE_KINDS.includes(k));
    if (kinds.length > 0) filter.kind = { $in: kinds };
    const files = await TradeInFile.find(filter).lean();
    res.json({
        success: true,
        data: files.map((f) => ({ ...svc.fileMeta(f), dataUrl: svc.fileToDataUrl(f) }))
    });
});

// @desc    Upload / replace an image on a draft (staff computer)
// @route   PUT /api/trade-ins/:id/files/:kind   body { dataUrl }
// @access  Private (tradein.create)
exports.putTradeInFile = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const kind = req.params.kind;
    if (!svc.FILE_KINDS.includes(kind)) return res.status(400).json({ success: false, message: 'Unknown file type.' });
    const draft = await TradeIn.findOne({ _id: req.params.id, tenantId });
    if (!draft) return notFound(res);
    if (draft.status !== 'draft') {
        return res.status(409).json({ success: false, message: 'This trade-in is already completed.' });
    }
    const meta = await saveDraftFile(draft, kind, req.body && req.body.dataUrl, { uploadedVia: 'desktop', uploadedBy: userIdOf(req) });
    res.json({ success: true, data: meta });
});

// @desc    Remove an image from a draft
// @route   DELETE /api/trade-ins/:id/files/:kind
// @access  Private (tradein.create)
exports.deleteTradeInFile = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const kind = req.params.kind;
    if (!svc.FILE_KINDS.includes(kind)) return res.status(400).json({ success: false, message: 'Unknown file type.' });
    const draft = await TradeIn.findOne({ _id: req.params.id, tenantId }).select('status').lean();
    if (!draft) return notFound(res);
    if (draft.status !== 'draft') {
        return res.status(409).json({ success: false, message: 'Files on a completed trade-in cannot be removed.' });
    }
    await TradeInFile.deleteOne({ tradeInId: draft._id, kind });
    res.json({ success: true });
});

// @desc    Record that the customer accepted the terms on the staff computer (or un-tick it)
// @route   PUT /api/trade-ins/:id/terms   body { accepted }
// @access  Private (tradein.create)
exports.setTermsAccepted = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const accepted = !!(req.body && req.body.accepted);
    const draft = await TradeIn.findOneAndUpdate(
        { _id: req.params.id, tenantId, status: 'draft' },
        {
            $set: accepted
                ? { termsAccepted: true, termsAcceptedAt: new Date(), termsAcceptedVia: 'desktop', expiresAt: svc.draftExpiry() }
                : { termsAccepted: false, termsAcceptedAt: null, termsAcceptedVia: null }
        },
        { new: true }
    ).lean();
    if (!draft) return notFound(res);
    res.json({ success: true, data: { termsAccepted: draft.termsAccepted, termsAcceptedVia: draft.termsAcceptedVia } });
});

// @desc    Create (or replace) the phone upload link shown as a QR code
// @route   POST /api/trade-ins/:id/upload-link
// @access  Private (tradein.create)
exports.createUploadLink = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const token = svc.newUploadToken();
    const expiresAt = new Date(Date.now() + svc.UPLOAD_LINK_TTL_MS);
    const draft = await TradeIn.findOneAndUpdate(
        { _id: req.params.id, tenantId, status: 'draft' },
        { $set: { uploadTokenHash: svc.hashToken(token), uploadTokenExpiresAt: expiresAt, expiresAt: svc.draftExpiry() } },
        { new: true }
    ).select('_id').lean();
    if (!draft) return notFound(res);
    res.json({ success: true, data: { token, expiresAt, tenantId } });
});

// @desc    Complete a trade-in: add the items to stock as a paid purchase under the Trade-in account
// @route   POST /api/trade-ins/:id/complete
//          body { customer: {name, phone, email}, notes, items: [purchase item payload], payoutMethod, termsAccepted }
// @access  Private (tradein.create)
exports.completeTradeIn = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const body = req.body || {};

    const customerCheck = svc.validateCustomer(body.customer);
    if (customerCheck.error) return res.status(400).json({ success: false, message: customerCheck.error });
    const customer = customerCheck.value;

    const itemsError = svc.validateItems(body.items);
    if (itemsError) return res.status(400).json({ success: false, message: itemsError });

    const payoutMethod = svc.PAYOUT_METHODS.includes(body.payoutMethod) ? body.payoutMethod : 'cash';
    const notes = String(body.notes || '').trim().slice(0, 2000);

    // Claim the draft so a double click can't book the same phones twice.
    const now = new Date();
    const draft = await TradeIn.findOneAndUpdate(
        {
            _id: req.params.id,
            tenantId,
            status: 'draft',
            $or: [
                { completing: { $ne: true } },
                { completingAt: { $lt: new Date(now.getTime() - svc.COMPLETE_LOCK_STALE_MS) } }
            ]
        },
        { $set: { completing: true, completingAt: now, expiresAt: svc.draftExpiry() } },
        { new: true }
    );
    if (!draft) {
        const existing = await TradeIn.findOne({ _id: req.params.id, tenantId }).select('status reference').lean();
        if (!existing) return notFound(res);
        if (existing.status === 'completed') {
            return res.status(409).json({
                success: false,
                message: `This trade-in is already completed (${existing.reference}).`,
                data: { _id: existing._id, reference: existing.reference }
            });
        }
        return res.status(409).json({ success: false, message: 'This trade-in is already being completed. Please wait a moment.' });
    }

    // Release the lock before replying, so an instant retry after an error isn't told "already being completed".
    let outcome;
    try {
        outcome = await completeClaimedDraft(req, draft, { tenantId, body, customer, payoutMethod, notes, now });
    } finally {
        if (!outcome || !outcome.completed) {
            await TradeIn.updateOne(
                { _id: draft._id, status: 'draft' },
                { $set: { completing: false, completingAt: null } }
            ).catch(() => {});
        }
    }
    res.status(outcome.status).json(outcome.body);
});

/** The work behind completeTradeIn once the draft is claimed. Returns { status, body, completed }. */
async function completeClaimedDraft(req, draft, { tenantId, body, customer, payoutMethod, notes, now }) {
    const settings = await NotesTermsSettings.getSettings().catch(() => null);
    const termsText = String((settings && settings.tradeInTerms) || '').trim();
    const termsAccepted = !!draft.termsAccepted || body.termsAccepted === true;
    if (termsText && !termsAccepted) {
        return { status: 400, body: { success: false, message: 'The customer must accept the trade-in terms first.' } };
    }
    const hasSignature = await TradeInFile.exists({ tradeInId: draft._id, kind: 'signature' });
    if (!hasSignature) {
        return { status: 400, body: { success: false, message: 'The customer must sign before the trade-in can be completed.' } };
    }

    // Reserve a TI- number (kept on the draft if stock-in fails, so a retry reuses it).
    let reference = draft.reference;
    for (let attempt = 0; !reference && attempt < 5; attempt++) {
        const candidate = await svc.getNextTradeInReference(tenantId);
        try {
            await TradeIn.updateOne({ _id: draft._id }, { $set: { reference: candidate } });
            reference = candidate;
        } catch (err) {
            if (err && err.code === 11000 && attempt < 4) continue;
            throw err;
        }
    }

    const supplier = await svc.getOrCreateTradeInSupplier();

    // Same code path as Add Purchase → stock, SIDs, serial index, ledger, caches all behave the same.
    const purchaseReq = Object.create(req);
    purchaseReq.body = {
        account: supplier._id,
        accountModel: 'Supplier',
        parcelNumber: reference,
        date: now,
        currency: 'GBP',
        note: `Trade-in ${reference} · ${customer.name} · ${customer.phone}`,
        items: sanitizeItems(body.items),
        status: 'Received',
        completionStatus: 'Completed'
    };
    const result = await createPurchaseRecord(purchaseReq, {
        markFullyPaid: true,
        initialPaymentMethod: payoutMethod,
        initialPaymentNote: `Trade-in payout (${payoutMethod}) ${reference}`
    });
    if (result.status !== 201) {
        return { status: result.status, body: result.body };
    }

    const purchase = result.populated || result.purchase;
    const items = svc.buildItemSnapshots(purchase);
    const totalUnits = items.reduce((s, it) => s + (it.isOtherItem ? (it.quantity || 0) : it.imeis.length), 0);
    const totalAmount = Number(purchase.grandTotal) || 0;
    const acceptedVia = termsAccepted ? (draft.termsAccepted ? draft.termsAcceptedVia : 'desktop') : null;

    const saved = await TradeIn.findOneAndUpdate(
        { _id: draft._id },
        {
            $set: {
                status: 'completed',
                reference,
                customer,
                notes,
                items,
                totalAmount,
                totalUnits,
                payoutMethod,
                purchaseId: purchase._id,
                purchaseNumber: purchase.purchaseNumber || '',
                termsText,
                termsAccepted,
                termsAcceptedAt: termsAccepted ? (draft.termsAcceptedAt || now) : null,
                termsAcceptedVia: acceptedVia,
                date: now,
                completedBy: userIdOf(req),
                completedAt: now,
                completing: false,
                completingAt: null,
                uploadTokenHash: null,
                uploadTokenExpiresAt: null,
                expiresAt: null
            }
        },
        { new: true }
    );

    // The stock is in and the trade-in is saved; nothing below may turn that into an error reply.
    await TradeInFile.updateMany({ tradeInId: draft._id }, { $set: { expiresAt: null } })
        .catch((err) => console.error('[tradeIn] could not keep files for', reference, err.message));
    await activityLogService.logFromReq(req, {
        action: 'CREATE',
        entityType: 'TradeIn',
        entityId: draft._id,
        success: true,
        message: `Trade-in ${reference} completed: ${totalUnits} item(s) from ${customer.name}, paid by ${payoutMethod} (${purchase.purchaseNumber})`,
        amount: totalAmount,
        paymentMethod: payoutMethod,
        afterJson: { reference, purchaseNumber: purchase.purchaseNumber, customer, totalAmount, totalUnits, items }
    }).catch(() => {});

    return { status: 201, body: { success: true, data: publicTradeIn(saved) }, completed: true };
}

// @desc    Delete an unfinished draft and its photos
// @route   DELETE /api/trade-ins/:id
// @access  Private (tradein.create)
exports.deleteDraft = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const draft = await TradeIn.findOne({ _id: req.params.id, tenantId }).select('status').lean();
    if (!draft) return notFound(res);
    if (draft.status !== 'draft') {
        return res.status(409).json({
            success: false,
            message: 'A completed trade-in cannot be deleted here. Its stock is a normal purchase — edit or return it from Purchases.'
        });
    }
    await TradeInFile.deleteMany({ tradeInId: draft._id });
    await TradeIn.deleteOne({ _id: draft._id, status: 'draft' });
    res.json({ success: true });
});

// ─────────────────────── Public phone-upload endpoints ───────────────────────
// No staff login: the QR code carries a random token (30 min) tied to one draft trade-in.
// The tenant comes from the X-Tenant-Id header the phone page sends (see tenantResolver).

async function loadDraftByToken(req) {
    const token = String(req.params.token || '');
    if (token.length < 20 || token.length > 100) return null;
    const draft = await TradeIn.findOne({ uploadTokenHash: svc.hashToken(token) });
    if (!draft || draft.status !== 'draft') return null;
    if (!draft.uploadTokenExpiresAt || new Date(draft.uploadTokenExpiresAt) <= new Date()) return null;
    return draft;
}

function linkExpired(res) {
    return res.status(410).json({
        success: false,
        message: 'This link has expired or the trade-in is already finished. Ask the staff to show a new QR code.'
    });
}

// @desc    What the phone page needs: shop name/logo, terms, what's uploaded so far
// @route   GET /api/trade-in-upload/:token
// @access  Public (token)
exports.publicGetSession = asyncHandler(async (req, res) => {
    const draft = await loadDraftByToken(req);
    if (!draft) return linkExpired(res);
    const [settings, about, files] = await Promise.all([
        NotesTermsSettings.getSettings().catch(() => null),
        AboutSettings.getSettings().catch(() => null),
        loadFilesMeta(draft._id)
    ]);
    res.json({
        success: true,
        data: {
            businessName: (about && (about.appName || about.appTitle)) || '',
            logo: (about && about.logo) || null,
            termsText: String((settings && settings.tradeInTerms) || '').trim(),
            termsAccepted: !!draft.termsAccepted,
            files: files.map((f) => ({ kind: f.kind, uploadedVia: f.uploadedVia, updatedAt: f.updatedAt })),
            expiresAt: draft.uploadTokenExpiresAt
        }
    });
});

// @desc    Upload an ID photo / signature from the phone
// @route   PUT /api/trade-in-upload/:token/files/:kind   body { dataUrl }
// @access  Public (token)
exports.publicPutFile = asyncHandler(async (req, res) => {
    const kind = req.params.kind;
    if (!svc.FILE_KINDS.includes(kind)) return res.status(400).json({ success: false, message: 'Unknown file type.' });
    const draft = await loadDraftByToken(req);
    if (!draft) return linkExpired(res);
    const meta = await saveDraftFile(draft, kind, req.body && req.body.dataUrl, { uploadedVia: 'phone', uploadedBy: null });
    res.json({ success: true, data: { kind: meta.kind, updatedAt: meta.updatedAt } });
});

// @desc    Customer ticks "I accept" on the phone
// @route   POST /api/trade-in-upload/:token/accept-terms   body { accepted: true }
// @access  Public (token)
exports.publicAcceptTerms = asyncHandler(async (req, res) => {
    if (!(req.body && req.body.accepted === true)) {
        return res.status(400).json({ success: false, message: 'Please tick the box to accept the terms.' });
    }
    const draft = await loadDraftByToken(req);
    if (!draft) return linkExpired(res);
    await TradeIn.updateOne(
        { _id: draft._id, status: 'draft' },
        { $set: { termsAccepted: true, termsAcceptedAt: new Date(), termsAcceptedVia: 'phone', expiresAt: svc.draftExpiry() } }
    );
    res.json({ success: true, data: { termsAccepted: true } });
});

exports._internals = { sanitizeItems, loadDraftByToken };
