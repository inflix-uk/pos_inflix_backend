const AuditLog = require('../models/AuditLog');

/**
 * Write an audit log entry. All timestamps stored in UTC.
 * @param {Object} opts
 * @param {string} opts.entityType - Sale | Payment | Product | Purchase | Refund | etc.
 * @param {string|ObjectId} opts.entityId
 * @param {string} opts.action - CREATE | UPDATE | DELETE | VOID | REFUND | etc.
 * @param {Object} [opts.changes] - { before, after } or patch
 * @param {ObjectId} [opts.performedBy] - user id
 * @param {Date} [opts.performedAt] - defaults to now (UTC)
 * @param {string} [opts.source] - UI | API | import | system
 * @param {string} [opts.ip]
 * @param {string} [opts.userAgent]
 * @param {string} [opts.sessionId]
 */
async function logAudit(opts) {
    const {
        entityType,
        entityId,
        action,
        changes,
        performedBy = null,
        performedAt = new Date(),
        source = 'API',
        ip = '',
        userAgent = '',
        sessionId = ''
    } = opts;
    if (!entityType || !entityId || !action) return;
    try {
        await AuditLog.create({
            entityType,
            entityId,
            action,
            changes: changes || undefined,
            performedBy,
            performedAt,
            source,
            ip,
            userAgent,
            sessionId
        });
    } catch (err) {
        console.error('[auditService] Failed to write audit log:', err.message);
    }
}

/**
 * Build audit context from Express req (after protect middleware).
 * @param {Object} req - Express request
 * @returns {{ performedBy: ObjectId|null, source: string, ip: string, userAgent: string }}
 */
function auditContextFromReq(req) {
    if (!req) return { performedBy: null, source: 'API', ip: '', userAgent: '' };
    const performedBy = req.user && req.user._id ? req.user._id : null;
    const ip = (req.headers && req.headers['x-forwarded-for'])
        ? req.headers['x-forwarded-for'].split(',')[0].trim()
        : (req.connection && req.connection.remoteAddress) || '';
    const userAgent = (req.headers && req.headers['user-agent']) || '';
    return { performedBy, source: 'API', ip, userAgent };
}

/**
 * Log and return; use in controllers after successful mutation.
 * Example: await auditService.logFromReq(req, 'Sale', doc._id, 'CREATE', { after: doc.toObject() });
 */
async function logFromReq(req, entityType, entityId, action, changes = null) {
    const ctx = auditContextFromReq(req);
    await logAudit({
        entityType,
        entityId,
        action,
        changes,
        performedBy: ctx.performedBy,
        source: ctx.source,
        ip: ctx.ip,
        userAgent: ctx.userAgent
    });
}

module.exports = {
    logAudit,
    logFromReq,
    auditContextFromReq
};
