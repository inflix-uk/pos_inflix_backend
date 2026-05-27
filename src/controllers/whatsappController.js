const whatsappSession = require('../services/whatsappSessionService');

function getTenantKey(req) {
    return req.tenant?._id || req.user?.tenantId || 'default';
}

exports.startSession = async (req, res) => {
    try {
        await whatsappSession.startSession(getTenantKey(req));
        const status = whatsappSession.getStatus(getTenantKey(req));
        return res.json({ success: true, data: status });
    } catch (e) {
        return res
            .status(e.code === 'WA_DEP_MISSING' ? 501 : 500)
            .json({ success: false, code: e.code, message: e.message });
    }
};

exports.getStatus = async (req, res) => {
    try {
        const status = whatsappSession.getStatus(getTenantKey(req));
        return res.json({ success: true, data: status });
    } catch (e) {
        return res.status(500).json({ success: false, message: e.message });
    }
};

exports.logout = async (req, res) => {
    try {
        const out = await whatsappSession.logoutSession(getTenantKey(req));
        return res.json({ success: true, data: out });
    } catch (e) {
        return res.status(500).json({ success: false, message: e.message });
    }
};

exports.sendTest = async (req, res) => {
    try {
        const { phone, text } = req.body || {};
        if (!phone) return res.status(400).json({ success: false, message: 'phone is required' });
        const message = String(text || 'Test message from your POS — WhatsApp gateway is working.');
        const out = await whatsappSession.sendMessage(getTenantKey(req), phone, message);
        return res.json({ success: true, data: out });
    } catch (e) {
        const code = e.code === 'WA_NOT_CONNECTED' ? 409 : e.code === 'WA_DEP_MISSING' ? 501 : 500;
        return res.status(code).json({ success: false, code: e.code, message: e.message });
    }
};
