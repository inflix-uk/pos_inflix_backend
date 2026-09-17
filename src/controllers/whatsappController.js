const whatsappSession = require('../services/whatsappSessionService');
const whatsappQueue = require('../services/whatsappQueueService');
const whatsappWorker = require('../services/whatsappQueueWorker');
const WhatsappSettings = require('../models/WhatsappSettings');
const rbacService = require('../services/rbacService');
const { getTenantIdFromReq } = require('../middleware/auth');
const { WHATSAPP_SAFETY_DEFAULTS, WHATSAPP_SAFETY_BOUNDS } = require('../config/whatsappSafety');

// The session key must be the tenant whose DB the request uses — the queue
// worker sends each tenant's messages from that tenant's DB.
function getTenantKey(req) {
    return getTenantIdFromReq(req);
}

function canManage(req) {
    return !!req.user && (req.user.role === 'admin' || rbacService.can(req.user, 'settings.edit'));
}

function sendError(res, e) {
    if (e instanceof whatsappQueue.WhatsappQueueError) {
        return res.status(e.status).json({ success: false, code: e.code, message: e.message });
    }
    const status = e.code === 'WA_NOT_CONNECTED' ? 409 : e.code === 'WA_DEP_MISSING' ? 501 : 500;
    return res.status(status).json({ success: false, code: e.code, message: e.message });
}

function statusFor(req) {
    const status = whatsappSession.getStatus(getTenantKey(req));
    // The pairing QR links a phone to this business account — only show it to managers.
    return canManage(req) ? status : { ...status, qrDataUrl: null };
}

exports.startSession = async (req, res) => {
    try {
        await whatsappSession.startSession(getTenantKey(req));
        return res.json({ success: true, data: statusFor(req) });
    } catch (e) {
        return sendError(res, e);
    }
};

exports.getStatus = async (req, res) => {
    try {
        return res.json({ success: true, data: statusFor(req) });
    } catch (e) {
        return sendError(res, e);
    }
};

exports.logout = async (req, res) => {
    try {
        const out = await whatsappSession.logoutSession(getTenantKey(req));
        return res.json({ success: true, data: out });
    } catch (e) {
        return sendError(res, e);
    }
};

exports.sendTest = async (req, res) => {
    try {
        const tenantId = getTenantKey(req);
        if (!whatsappSession.isConnected(tenantId)) {
            return res.status(409).json({ success: false, code: 'WA_NOT_CONNECTED', message: 'WhatsApp not connected. Scan the QR first.' });
        }
        const { phone, text } = req.body || {};
        const message = String(text || 'Test message from your POS — WhatsApp gateway is working.');
        const out = await whatsappQueue.enqueueMessage({
            phone,
            text: message,
            source: 'test',
            dedupeKey: whatsappQueue.textDedupeKey(message),
            createdByUserId: req.user && req.user._id,
        });
        whatsappWorker.kick(tenantId);
        return res.status(202).json({ success: true, message: 'Test message queued', data: out });
    } catch (e) {
        return sendError(res, e);
    }
};

exports.getSettings = async (req, res) => {
    try {
        const settings = await WhatsappSettings.getSettings();
        const usage = await whatsappQueue.getUsage(settings);
        return res.json({
            success: true,
            data: {
                settings: whatsappQueue.toSettingsDto(settings),
                defaults: WHATSAPP_SAFETY_DEFAULTS,
                bounds: WHATSAPP_SAFETY_BOUNDS,
                usage,
            },
        });
    } catch (e) {
        return sendError(res, e);
    }
};

exports.updateSettings = async (req, res) => {
    try {
        const current = await WhatsappSettings.getSettings();
        const changes = whatsappQueue.validateSettingsUpdate(req.body, current);
        const updated = await WhatsappSettings.findOneAndUpdate(
            { _id: current._id },
            { $set: { ...changes, updatedByUserId: (req.user && req.user._id) || null } },
            { new: true }
        );
        const usage = await whatsappQueue.getUsage(updated);
        return res.json({
            success: true,
            message: 'WhatsApp safety settings saved',
            data: {
                settings: whatsappQueue.toSettingsDto(updated),
                defaults: WHATSAPP_SAFETY_DEFAULTS,
                bounds: WHATSAPP_SAFETY_BOUNDS,
                usage,
            },
        });
    } catch (e) {
        return sendError(res, e);
    }
};

exports.getQueue = async (req, res) => {
    try {
        const messages = await whatsappQueue.listMessages({ status: req.query.status, limit: req.query.limit });
        return res.json({ success: true, data: messages });
    } catch (e) {
        return sendError(res, e);
    }
};

exports.cancelMessage = async (req, res) => {
    try {
        const message = await whatsappQueue.cancelMessage(req.params.id);
        return res.json({ success: true, message: 'Message cancelled', data: message });
    } catch (e) {
        return sendError(res, e);
    }
};

exports.retryMessage = async (req, res) => {
    try {
        const message = await whatsappQueue.retryMessage(req.params.id);
        whatsappWorker.kick(getTenantKey(req));
        return res.json({ success: true, message: 'Message queued again', data: message });
    } catch (e) {
        return sendError(res, e);
    }
};
