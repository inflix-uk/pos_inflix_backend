const GeneralSettings = require('../models/GeneralSettings');
const Customer = require('../models/Customer');
const Supplier = require('../models/Supplier');
const asyncHandler = require('../middleware/asyncHandler');
const activityLogService = require('../services/activityLogService');
const mongoose = require('mongoose');
const { getTenantIdFromReq } = require('../middleware/auth');
const cache = require('../lib/cache');
const TTL = require('../lib/cacheTTL');

const GENERAL_SETTINGS_NS = 'settings:general';
async function invalidateGeneralSettingsCache(tenantId) {
    await cache.bumpNs(GENERAL_SETTINGS_NS, tenantId);
}

/**
 * Find an active account (Customer or Supplier) by id. Returns { doc, type: 'Customer'|'Supplier' } or null.
 */
async function findActiveAccountById(id) {
    if (!id || !mongoose.Types.ObjectId.isValid(id)) return null;
    const customer = await Customer.findOne({ _id: id, isActive: true }).select('_id name').lean();
    if (customer) return { doc: customer, type: 'Customer' };
    const supplier = await Supplier.findOne({ _id: id, isActive: true }).select('_id name').lean();
    if (supplier) return { doc: supplier, type: 'Supplier' };
    return null;
}

// @desc    Get general settings (including sales auto-select)
// @route   GET /api/settings/general
// @access  Private (settings.view)
exports.getGeneralSettings = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const data = await cache.cached(
        { ns: GENERAL_SETTINGS_NS, tenantId, params: {}, ttlSec: TTL.REFERENCE },
        async () => {
            const settings = await GeneralSettings.getSettings();
            const out = {
                salesAutoSelectAccountEnabled: !!settings.salesAutoSelectAccountEnabled,
                defaultSalesAccountId: settings.defaultSalesAccountId ? settings.defaultSalesAccountId.toString() : null,
                retailModeEnabled: !!settings.retailModeEnabled,
                allowNegativeStock: !!settings.allowNegativeStock,
                updatedAtUtc: settings.updatedAt
            };
            if (settings.defaultSalesAccountId) {
                const account = await findActiveAccountById(settings.defaultSalesAccountId);
                if (account) {
                    out.defaultAccount = { _id: account.doc._id.toString(), name: account.doc.name };
                }
            }
            return out;
        }
    );
    res.status(200).json({
        success: true,
        data
    });
});

// @desc    Update sales auto-select account settings
// @route   PUT /api/settings/general/sales-auto-select-account
// @access  Private (settings.manage)
exports.updateSalesAutoSelectAccount = asyncHandler(async (req, res) => {
    const { enabled, defaultSalesAccountId: rawId } = req.body;

    let settings = await GeneralSettings.findOne();
    if (!settings) {
        settings = await GeneralSettings.create({});
    }
    const before = {
        salesAutoSelectAccountEnabled: settings.salesAutoSelectAccountEnabled,
        defaultSalesAccountId: settings.defaultSalesAccountId ? settings.defaultSalesAccountId.toString() : null
    };

    if (typeof enabled === 'boolean') {
        settings.salesAutoSelectAccountEnabled = enabled;
    }

    if (rawId !== undefined) {
        if (rawId === null || rawId === '') {
            settings.defaultSalesAccountId = null;
        } else {
            const id = typeof rawId === 'string' ? rawId.trim() : String(rawId);
            if (!mongoose.Types.ObjectId.isValid(id)) {
                return res.status(400).json({ success: false, message: 'Invalid defaultSalesAccountId' });
            }
            const account = await findActiveAccountById(id);
            if (!account) {
                return res.status(400).json({ success: false, message: 'Account not found or inactive' });
            }
            settings.defaultSalesAccountId = account.doc._id;
        }
    }

    settings.updatedByUserId = req.user && req.user._id ? req.user._id : null;
    await settings.save();

    const after = {
        salesAutoSelectAccountEnabled: settings.salesAutoSelectAccountEnabled,
        defaultSalesAccountId: settings.defaultSalesAccountId ? settings.defaultSalesAccountId.toString() : null
    };

    await activityLogService.logFromReq(req, {
        action: 'SETTINGS_UPDATED',
        entityType: 'Settings',
        entityId: 'general-sales-auto-select',
        success: true,
        message: 'Sales auto-select account settings updated',
        diffJson: { before, after }
    });
    await invalidateGeneralSettingsCache(getTenantIdFromReq(req));

    const responseData = {
        salesAutoSelectAccountEnabled: settings.salesAutoSelectAccountEnabled,
        defaultSalesAccountId: settings.defaultSalesAccountId ? settings.defaultSalesAccountId.toString() : null
    };
    if (settings.defaultSalesAccountId) {
        const account = await findActiveAccountById(settings.defaultSalesAccountId);
        if (account) {
            responseData.defaultAccount = { _id: account.doc._id.toString(), name: account.doc.name };
        }
    }
    res.status(200).json({
        success: true,
        message: 'Settings updated',
        data: responseData
    });
});

// @desc    Update sales mode (retail vs wholesale)
// @route   PUT /api/settings/general/sales-mode
// @access  Private (settings.manage)
exports.updateSalesMode = asyncHandler(async (req, res) => {
    const { retailModeEnabled } = req.body;
    if (typeof retailModeEnabled !== 'boolean') {
        return res.status(400).json({ success: false, message: 'retailModeEnabled must be a boolean' });
    }
    let settings = await GeneralSettings.findOne();
    if (!settings) {
        settings = await GeneralSettings.create({});
    }
    const before = { retailModeEnabled: !!settings.retailModeEnabled };
    settings.retailModeEnabled = retailModeEnabled;
    settings.updatedByUserId = req.user && req.user._id ? req.user._id : null;
    await settings.save();
    const after = { retailModeEnabled: !!settings.retailModeEnabled };
    await activityLogService.logFromReq(req, {
        action: 'SETTINGS_UPDATED',
        entityType: 'Settings',
        entityId: 'general-sales-mode',
        success: true,
        message: 'Sales mode updated',
        diffJson: { before, after }
    });
    await invalidateGeneralSettingsCache(getTenantIdFromReq(req));
    const data = {
        salesAutoSelectAccountEnabled: !!settings.salesAutoSelectAccountEnabled,
        defaultSalesAccountId: settings.defaultSalesAccountId ? settings.defaultSalesAccountId.toString() : null,
        retailModeEnabled: !!settings.retailModeEnabled,
        allowNegativeStock: !!settings.allowNegativeStock,
        updatedAtUtc: settings.updatedAt
    };
    if (settings.defaultSalesAccountId) {
        const account = await findActiveAccountById(settings.defaultSalesAccountId);
        if (account) {
            data.defaultAccount = { _id: account.doc._id.toString(), name: account.doc.name };
        }
    }
    res.status(200).json({
        success: true,
        message: 'Settings updated',
        data
    });
});

// @desc    Update negative stock allowance (non-IMEI products)
// @route   PUT /api/settings/general/negative-stock
// @access  Private (settings.manage)
exports.updateNegativeStock = asyncHandler(async (req, res) => {
    const { allowNegativeStock } = req.body;
    if (typeof allowNegativeStock !== 'boolean') {
        return res.status(400).json({ success: false, message: 'allowNegativeStock must be a boolean' });
    }
    let settings = await GeneralSettings.findOne();
    if (!settings) {
        settings = await GeneralSettings.create({});
    }
    const before = { allowNegativeStock: !!settings.allowNegativeStock };
    settings.allowNegativeStock = allowNegativeStock;
    settings.updatedByUserId = req.user && req.user._id ? req.user._id : null;
    await settings.save();
    const after = { allowNegativeStock: !!settings.allowNegativeStock };
    await activityLogService.logFromReq(req, {
        action: 'SETTINGS_UPDATED',
        entityType: 'Settings',
        entityId: 'general-negative-stock',
        success: true,
        message: 'Negative stock allowance updated',
        diffJson: { before, after }
    });
    await invalidateGeneralSettingsCache(getTenantIdFromReq(req));
    const data = {
        salesAutoSelectAccountEnabled: !!settings.salesAutoSelectAccountEnabled,
        defaultSalesAccountId: settings.defaultSalesAccountId ? settings.defaultSalesAccountId.toString() : null,
        retailModeEnabled: !!settings.retailModeEnabled,
        allowNegativeStock: !!settings.allowNegativeStock,
        updatedAtUtc: settings.updatedAt
    };
    if (settings.defaultSalesAccountId) {
        const account = await findActiveAccountById(settings.defaultSalesAccountId);
        if (account) {
            data.defaultAccount = { _id: account.doc._id.toString(), name: account.doc.name };
        }
    }
    res.status(200).json({
        success: true,
        message: 'Settings updated',
        data
    });
});
<<<<<<< HEAD

// @desc    Update refund OTP threshold
// @route   PUT /api/settings/general/refund-otp-threshold
// @access  Private (settings.manage)
exports.updateRefundOtpThreshold = asyncHandler(async (req, res) => {
    const { refundOtpThreshold } = req.body;
    const value = Number(refundOtpThreshold);
    if (!Number.isFinite(value) || value < 0) {
        return res.status(400).json({ success: false, message: 'refundOtpThreshold must be a non-negative number' });
    }
    let settings = await GeneralSettings.findOne();
    if (!settings) {
        settings = await GeneralSettings.create({});
    }
    const before = { refundOtpThreshold: typeof settings.refundOtpThreshold === 'number' ? settings.refundOtpThreshold : 50 };
    settings.refundOtpThreshold = Math.round(value * 100) / 100;
    settings.updatedByUserId = req.user && req.user._id ? req.user._id : null;
    await settings.save();
    const after = { refundOtpThreshold: settings.refundOtpThreshold };
    await activityLogService.logFromReq(req, {
        action: 'SETTINGS_UPDATED',
        entityType: 'Settings',
        entityId: 'general-refund-otp-threshold',
        success: true,
        message: 'Refund OTP threshold updated',
        diffJson: { before, after }
    });
    await invalidateGeneralSettingsCache(getTenantIdFromReq(req));
    res.status(200).json({
        success: true,
        message: 'Threshold updated',
        data: { refundOtpThreshold: settings.refundOtpThreshold }
    });
});

// --- Admin Google Authenticator (TOTP) for refund approval ---

const TOTP_ISSUER = 'Inflix POS';

function verifyTotpCode(secretBase32, code) {
    if (!secretBase32 || !code) return false;
    const cleaned = String(code).replace(/\s+/g, '');
    if (!/^\d{6}$/.test(cleaned)) return false;
    return speakeasy.totp.verify({
        secret: secretBase32,
        encoding: 'base32',
        token: cleaned,
        window: 1
    });
}

exports.verifyAdminTotpCode = verifyTotpCode;

// @desc    Begin admin 2FA setup — returns a fresh secret + QR (does NOT enable yet)
// @route   POST /api/settings/general/2fa/setup
// @access  Private (settings.manage)
exports.setupAdminTotp = asyncHandler(async (req, res) => {
    const label = (req.user && (req.user.email || req.user.name)) || 'admin';
    const secret = speakeasy.generateSecret({
        length: 20,
        name: `${TOTP_ISSUER} (${label})`,
        issuer: TOTP_ISSUER
    });
    let settings = await GeneralSettings.findOne();
    if (!settings) {
        settings = await GeneralSettings.create({});
    }
    settings.adminTotpSecret = secret.base32;
    settings.adminTotpEnabled = false;
    settings.updatedByUserId = req.user && req.user._id ? req.user._id : null;
    await settings.save();
    await invalidateGeneralSettingsCache(getTenantIdFromReq(req));

    const otpauthUrl = secret.otpauth_url;
    const qrDataUrl = await qrcode.toDataURL(otpauthUrl);
    res.status(200).json({
        success: true,
        data: {
            otpauthUrl,
            qrDataUrl,
            secret: secret.base32
        }
    });
});

// @desc    Confirm setup by submitting the first code from Google Authenticator — enables 2FA
// @route   POST /api/settings/general/2fa/verify-enable
// @access  Private (settings.manage)
exports.verifyAndEnableAdminTotp = asyncHandler(async (req, res) => {
    const { code } = req.body || {};
    const settings = await GeneralSettings.getSettings();
    if (!settings.adminTotpSecret) {
        return res.status(400).json({ success: false, message: 'Start setup first to generate a secret' });
    }
    if (!verifyTotpCode(settings.adminTotpSecret, code)) {
        return res.status(400).json({ success: false, message: 'Invalid code — open Google Authenticator and try the current 6-digit code' });
    }
    settings.adminTotpEnabled = true;
    settings.updatedByUserId = req.user && req.user._id ? req.user._id : null;
    await settings.save();
    await invalidateGeneralSettingsCache(getTenantIdFromReq(req));

    await activityLogService.logFromReq(req, {
        action: 'SETTINGS_UPDATED',
        entityType: 'Settings',
        entityId: 'general-admin-totp',
        success: true,
        message: 'Admin Google Authenticator enabled'
    });
    res.status(200).json({
        success: true,
        message: 'Google Authenticator enabled',
        data: { adminTotpEnabled: true }
    });
});

// @desc    Disable admin 2FA (clears the stored secret). Requires a current valid code if currently enabled.
// @route   POST /api/settings/general/2fa/disable
// @access  Private (settings.manage)
exports.disableAdminTotp = asyncHandler(async (req, res) => {
    const { code } = req.body || {};
    const settings = await GeneralSettings.getSettings();
    if (settings.adminTotpEnabled) {
        if (!verifyTotpCode(settings.adminTotpSecret, code)) {
            return res.status(400).json({ success: false, message: 'Enter a valid current code to disable 2FA' });
        }
    }
    settings.adminTotpSecret = null;
    settings.adminTotpEnabled = false;
    settings.updatedByUserId = req.user && req.user._id ? req.user._id : null;
    await settings.save();
    await invalidateGeneralSettingsCache(getTenantIdFromReq(req));

    await activityLogService.logFromReq(req, {
        action: 'SETTINGS_UPDATED',
        entityType: 'Settings',
        entityId: 'general-admin-totp',
        success: true,
        message: 'Admin Google Authenticator disabled'
    });
    res.status(200).json({
        success: true,
        message: 'Google Authenticator disabled',
        data: { adminTotpEnabled: false }
    });
});
=======
>>>>>>> 691dc86c5ee9cf77e6201fb400f473562185f26d
