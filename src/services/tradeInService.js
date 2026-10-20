/**
 * Trade-in helpers: reference numbers, the system "Trade-in" supplier account,
 * phone upload tokens and image clean-up (ID photos + signature).
 */

const crypto = require('crypto');
const sharp = require('sharp');
const TradeIn = require('../models/TradeIn');
const Supplier = require('../models/Supplier');
const { formatProductName } = require('../utils/formatProductName');

const FILE_KINDS = ['id_front', 'id_back', 'signature'];
const PAYOUT_METHODS = ['cash', 'bank', 'card'];

/** An unfinished draft (and its photos) is deleted this long after its last activity. */
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
/** A phone upload QR code works for this long. */
const UPLOAD_LINK_TTL_MS = 30 * 60 * 1000;
/** A "Complete" lock older than this is treated as abandoned (crashed request). */
const COMPLETE_LOCK_STALE_MS = 2 * 60 * 1000;

/** Largest decoded upload we accept before resizing (phone cameras are ~3–8 MB). */
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
const ALLOWED_UPLOAD_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);

function draftExpiry(now = Date.now()) {
    return new Date(now + DRAFT_TTL_MS);
}

function newUploadToken() {
    return crypto.randomBytes(24).toString('base64url');
}

function hashToken(token) {
    return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

/** TI-000001, TI-000002, … (highest existing + 1; callers retry on duplicate key). */
async function getNextTradeInReference(tenantId) {
    const last = await TradeIn.findOne({ tenantId: tenantId || 'default', reference: /^TI-\d{6}$/ })
        .sort({ reference: -1 })
        .select('reference')
        .lean();
    let seq = 1;
    const m = last && last.reference ? last.reference.match(/^TI-(\d{6})$/) : null;
    if (m) seq = parseInt(m[1], 10) + 1;
    return `TI-${String(seq).padStart(6, '0')}`;
}

/**
 * The single supplier account all trade-in purchases are booked under. Created on first use.
 * Found by the isTradeIn flag, so renaming it in Suppliers is safe.
 */
async function getOrCreateTradeInSupplier() {
    const existing = await Supplier.findOne({ isTradeIn: true });
    if (existing) return existing;
    try {
        return await Supplier.create({
            name: 'Trade-in',
            phone: 'N/A',
            contactPerson: 'Walk-in trade-in customers',
            isTradeIn: true,
            isActive: true
        });
    } catch (err) {
        // Two first trade-ins at the same moment: the unique index lets one win; use it.
        if (err && err.code === 11000) {
            const winner = await Supplier.findOne({ isTradeIn: true });
            if (winner) return winner;
        }
        throw err;
    }
}

/** Parse "data:image/png;base64,…" → { mime, buffer }. Throws a 400-style error when invalid. */
function decodeImageDataUrl(dataUrl) {
    const s = typeof dataUrl === 'string' ? dataUrl : '';
    const match = s.match(/^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/i);
    if (!match) throw badRequest('Image must be sent as a base64 data URL.');
    const mime = match[1].toLowerCase();
    if (!ALLOWED_UPLOAD_MIME.has(mime)) throw badRequest('Only JPG, PNG or WEBP images are allowed.');
    const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
    if (buffer.length === 0) throw badRequest('Image is empty.');
    if (buffer.length > MAX_UPLOAD_BYTES) throw badRequest('Image is too large (max 12 MB).');
    return { mime, buffer };
}

/**
 * Re-encode an uploaded image so we never store the original bytes:
 * ID photos → auto-rotated JPEG, max 1600px; signature → PNG on white, max 1200×500.
 * Re-encoding also strips EXIF (GPS etc.) and rejects anything that isn't really an image.
 */
async function processUploadedImage(kind, dataUrl) {
    if (!FILE_KINDS.includes(kind)) throw badRequest('Unknown file type.');
    const { buffer } = decodeImageDataUrl(dataUrl);
    let pipeline;
    try {
        pipeline = sharp(buffer, { failOn: 'error' }).rotate();
    } catch (_) {
        throw badRequest('Could not read this image.');
    }
    try {
        if (kind === 'signature') {
            const out = await pipeline
                .resize({ width: 1200, height: 500, fit: 'inside', withoutEnlargement: true })
                .flatten({ background: '#ffffff' })
                .png({ compressionLevel: 9 })
                .toBuffer({ resolveWithObject: true });
            return { mimeType: 'image/png', data: out.data, size: out.data.length, width: out.info.width, height: out.info.height };
        }
        const out = await pipeline
            .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
            .flatten({ background: '#ffffff' })
            .jpeg({ quality: 80, mozjpeg: true })
            .toBuffer({ resolveWithObject: true });
        return { mimeType: 'image/jpeg', data: out.data, size: out.data.length, width: out.info.width, height: out.info.height };
    } catch (_) {
        throw badRequest('Could not read this image. Please take the photo again.');
    }
}

function fileToDataUrl(file) {
    if (!file || !file.data) return null;
    const buf = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data.buffer || file.data);
    return `data:${file.mimeType};base64,${buf.toString('base64')}`;
}

/** File list for API responses (no image bytes). */
function fileMeta(file) {
    return {
        _id: file._id,
        kind: file.kind,
        mimeType: file.mimeType,
        size: file.size,
        width: file.width,
        height: file.height,
        uploadedVia: file.uploadedVia,
        updatedAt: file.updatedAt || file.createdAt
    };
}

/** Snapshot of the completed purchase's lines, kept on the trade-in for the list / PDF. */
function buildItemSnapshots(populatedPurchase) {
    const items = (populatedPurchase && populatedPurchase.items) || [];
    return items.map((it) => {
        const category = it.category && typeof it.category === 'object' ? (it.category.name || '') : '';
        const location = it.sendTo && typeof it.sendTo === 'object' ? it.sendTo : null;
        const parts = [it.brand, it.brandModel, it.capacity, it.colour].filter(Boolean);
        const description = formatProductName(parts.length > 0 ? parts.join(' ') : (it.name || category || 'Item'));
        return {
            purchaseItemId: it._id || null,
            description,
            category,
            grade: it.grade || '',
            brand: it.brand || '',
            brandModel: it.brandModel || '',
            capacity: it.capacity || '',
            colour: it.colour || '',
            imeis: Array.isArray(it.imeis) ? it.imeis.map(String) : [],
            isOtherItem: !!it.isOtherItem,
            barcode: it.barcode || '',
            quantity: it.isOtherItem ? (Number(it.quantity) || 0) : (Array.isArray(it.imeis) ? it.imeis.length : 0),
            purchasePrice: Number(it.purchasePrice) || 0,
            salePrice: Number(it.salePrice) || 0,
            locationId: location ? location._id : (it.sendTo || null),
            locationName: location ? (location.name || '') : '',
            note: it.note || ''
        };
    });
}

/** Validate the customer block of a completion request. Returns { value } or { error }. */
function validateCustomer(input) {
    const c = input && typeof input === 'object' ? input : {};
    const name = String(c.name || '').trim();
    const phone = String(c.phone || '').trim();
    const email = String(c.email || '').trim().toLowerCase();
    if (!name) return { error: 'Customer name is required.' };
    if (name.length > 100) return { error: 'Customer name cannot exceed 100 characters.' };
    if (!phone) return { error: 'Customer mobile number is required.' };
    if (phone.length > 40) return { error: 'Mobile number is too long.' };
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return { error: 'Please enter a valid email address.' };
    return { value: { name, phone, email } };
}

/** Every line needs at least one IMEI/serial, or a quantity for non-serial lines. */
function validateItems(items) {
    if (!Array.isArray(items) || items.length === 0) return 'Add at least one item.';
    for (let i = 0; i < items.length; i++) {
        const it = items[i] || {};
        if (it.isOtherItem) {
            if (!(Number(it.quantity) > 0)) return `Item ${i + 1}: quantity must be at least 1.`;
        } else {
            const imeis = Array.isArray(it.imeis) ? it.imeis.filter((x) => String(x || '').trim()) : [];
            if (imeis.length === 0) return `Item ${i + 1}: add the IMEI / serial number.`;
        }
    }
    return null;
}

function badRequest(message) {
    const err = new Error(message);
    err.statusCode = 400;
    return err;
}

module.exports = {
    FILE_KINDS,
    PAYOUT_METHODS,
    DRAFT_TTL_MS,
    UPLOAD_LINK_TTL_MS,
    COMPLETE_LOCK_STALE_MS,
    draftExpiry,
    newUploadToken,
    hashToken,
    getNextTradeInReference,
    getOrCreateTradeInSupplier,
    decodeImageDataUrl,
    processUploadedImage,
    fileToDataUrl,
    fileMeta,
    buildItemSnapshots,
    validateCustomer,
    validateItems,
    badRequest
};
