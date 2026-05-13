/**
 * System-wide activity/audit log. Append-only; write inside transaction when session provided.
 * All timestamps UTC; store fast-filter columns for powerful querying.
 */

const crypto = require('crypto');
const AuditEvent = require('../models/AuditEvent');

function sha256(str) {
    return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

/**
 * Build context from Express req (after protect middleware).
 */
function contextFromReq(req) {
    if (!req) return { actorUserId: null, actorName: '', actorRole: '', source: 'API', ipAddress: '', userAgent: '' };
    const user = req.user;
    const ip = (req.headers && req.headers['x-forwarded-for'])
        ? req.headers['x-forwarded-for'].split(',')[0].trim()
        : (req.connection && req.connection.remoteAddress) || '';
    const userAgent = (req.headers && req.headers['user-agent']) || '';
    return {
        actorUserId: user && user._id ? user._id : null,
        actorName: (user && user.name) ? String(user.name) : '',
        actorRole: (user && user.role) ? String(user.role) : '',
        source: (req.headers && req.headers['x-audit-source']) === 'UI' ? 'UI' : 'API',
        ipAddress: ip,
        userAgent
    };
}

/**
 * Write one audit event. Optionally pass mongoose session to write inside transaction.
 * @param {Object} opts
 * @param {Date} [opts.occurredAtUtc]
 * @param {ObjectId} [opts.actorUserId]
 * @param {string} [opts.actorName]
 * @param {string} [opts.actorRole]
 * @param {string} opts.action - LOGIN, CREATE_SALE, EDIT_SALE, etc.
 * @param {string} opts.entityType - Sale, Product, etc.
 * @param {*} opts.entityId
 * @param {boolean} [opts.success=true]
 * @param {string} [opts.message]
 * @param {ObjectId} [opts.customerId]
 * @param {ObjectId} [opts.saleId]
 * @param {string} [opts.invoiceNo]
 * @param {ObjectId} [opts.productId]
 * @param {string} [opts.imei]
 * @param {number} [opts.amount]
 * @param {string} [opts.paymentMethod]
 * @param {string} [opts.source]
 * @param {string} [opts.ipAddress]
 * @param {string} [opts.deviceId]
 * @param {Object} [opts.diffJson]
 * @param {Object} [opts.beforeJson]
 * @param {Object} [opts.afterJson]
 * @param {Object} [opts.metaJson]
 * @param {string} [opts.tenantId] - tenant for isolation; default 'default'
 * @param {Object} [opts.session] - mongoose session for transactional write
 */
async function log(opts) {
    const {
        occurredAtUtc = new Date(),
        actorUserId = null,
        actorName = '',
        actorRole = '',
        action,
        entityType,
        entityId,
        success = true,
        message = '',
        customerId = null,
        saleId = null,
        invoiceNo = '',
        productId = null,
        imei = '',
        amount = null,
        paymentMethod = null,
        source = 'API',
        ipAddress = '',
        deviceId = '',
        userAgent = '',
        diffJson,
        beforeJson,
        afterJson,
        metaJson,
        tenantId = 'default',
        session
    } = opts;

    if (!action || !entityType || entityId === undefined) return null;

    const payload = {
        occurredAtUtc,
        actorUserId,
        actorName,
        actorRole,
        action,
        entityType,
        entityId,
        success,
        message: message || summarize(action, entityType, entityId),
        customerId: customerId || undefined,
        saleId: saleId || undefined,
        invoiceNo: (invoiceNo && String(invoiceNo).trim()) || undefined,
        productId: productId || undefined,
        imei: (imei && String(imei).trim()) || undefined,
        amount: amount != null ? Number(amount) : undefined,
        paymentMethod: paymentMethod || undefined,
        source,
        ipAddress: ipAddress || '',
        deviceId: deviceId || '',
        userAgent: userAgent || '',
        diffJson: diffJson || undefined,
        beforeJson: beforeJson || undefined,
        afterJson: afterJson || undefined,
        metaJson: metaJson || undefined,
        tenantId: tenantId || 'default'
    };

    if (session) {
        const last = await AuditEvent.findOne().sort({ occurredAtUtc: -1 }).session(session).select('hash').lean();
        const prevHash = last && last.hash ? last.hash : null;
        const hashPayload = JSON.stringify({ prevHash, ...payload });
        payload.prevHash = prevHash;
        payload.hash = sha256(hashPayload);
    }

    const doc = await AuditEvent.create([payload], session ? { session } : {});
    return doc[0] || doc;
}

function summarize(action, entityType, entityId) {
    const id = entityId && typeof entityId === 'object' && entityId.toString ? entityId.toString() : String(entityId);
    return `${action} ${entityType} ${id}`.slice(0, 200);
}

/**
 * Log from Express req (after protect). Merges contextFromReq with opts; sets tenantId from req.
 */
async function logFromReq(req, opts) {
    const ctx = contextFromReq(req);
    const getTenantIdFromReq = require('../middleware/auth').getTenantIdFromReq;
    const tenantId = (req && getTenantIdFromReq(req)) || 'default';
    return log({
        ...opts,
        tenantId: opts.tenantId ?? tenantId,
        actorUserId: opts.actorUserId ?? ctx.actorUserId,
        actorName: opts.actorName ?? ctx.actorName,
        actorRole: opts.actorRole ?? ctx.actorRole,
        source: opts.source ?? ctx.source,
        ipAddress: opts.ipAddress ?? ctx.ipAddress,
        userAgent: opts.userAgent ?? ctx.userAgent
    });
}

/**
 * Convenience: log sale event with sale doc (extracts customerId, invoiceNo, etc.).
 */
async function logSaleEvent(req, action, sale, extra = {}, session) {
    const saleId = sale && sale._id;
    const invoiceNo = (sale && sale.reference) ? String(sale.reference).trim() : '';
    const customerId = sale && sale.customerId ? sale.customerId : null;
    return logFromReq(req, {
        action,
        entityType: 'Sale',
        entityId: saleId,
        saleId,
        invoiceNo,
        customerId,
        success: true,
        message: extra.message || `${action} ${invoiceNo || saleId}`,
        afterJson: sale && sale.toObject ? sale.toObject() : sale,
        beforeJson: extra.before,
        diffJson: extra.diff,
        metaJson: extra.meta,
        session
    });
}

/**
 * Log return/refund event.
 */
async function logReturnEvent(req, action, salesReturn, extra = {}, session) {
    const id = salesReturn && salesReturn._id;
    const invoiceNo = (salesReturn && salesReturn.linkedInvoiceRef) ? String(salesReturn.linkedInvoiceRef).trim() : '';
    return logFromReq(req, {
        action,
        entityType: 'SalesReturn',
        entityId: id,
        invoiceNo: invoiceNo || (salesReturn && salesReturn.reference) || '',
        success: true,
        message: extra.message || `${action} ${salesReturn && salesReturn.reference}`,
        afterJson: salesReturn && salesReturn.toObject ? salesReturn.toObject() : salesReturn,
        beforeJson: extra.before,
        amount: extra.amount,
        metaJson: extra.meta,
        session
    });
}

/**
 * Log product event (optionally with imei in meta).
 */
async function logProductEvent(req, action, product, extra = {}, session) {
    const productId = product && product._id;
    return logFromReq(req, {
        action,
        entityType: 'Product',
        entityId: productId,
        productId,
        success: true,
        message: extra.message || `${action} product`,
        afterJson: product && product.toObject ? product.toObject() : product,
        beforeJson: extra.before,
        diffJson: extra.diff,
        metaJson: extra.meta,
        imei: extra.imei || '',
        session
    });
}

/**
 * Log parcel/purchase event.
 */
async function logParcelEvent(req, action, purchase, extra = {}, session) {
    const id = purchase && purchase._id;
    const invoiceNo = (purchase && purchase.purchaseNumber) ? String(purchase.purchaseNumber).trim() : '';
    return logFromReq(req, {
        action,
        entityType: 'Purchase',
        entityId: id,
        invoiceNo,
        success: true,
        message: extra.message || `${action} parcel ${invoiceNo || id}`,
        afterJson: purchase && purchase.toObject ? purchase.toObject() : purchase,
        beforeJson: extra.before,
        metaJson: extra.meta,
        session
    });
}

/**
 * Log auth event (no req.user for failed login).
 */
async function logAuthEvent(opts) {
    return log({
        action: opts.action,
        entityType: 'User',
        entityId: opts.userId || opts.email || 'unknown',
        success: opts.success !== false,
        message: opts.message || opts.action,
        actorUserId: opts.userId || null,
        actorName: opts.actorName || '',
        actorRole: opts.actorRole || '',
        source: opts.source || 'API',
        ipAddress: opts.ipAddress || '',
        userAgent: opts.userAgent || '',
        metaJson: opts.meta || null
    });
}

module.exports = {
    log,
    logFromReq,
    logSaleEvent,
    logReturnEvent,
    logProductEvent,
    logParcelEvent,
    logAuthEvent,
    contextFromReq
};
