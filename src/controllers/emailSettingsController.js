const EmailSettings = require('../models/EmailSettings');
const emailService = require('../lib/emailService');
const asyncHandler = require('../middleware/asyncHandler');
const { getTenantIdFromReq } = require('../middleware/auth');
const cache = require('../lib/cache');
const TTL = require('../lib/cacheTTL');

const EMAIL_SETTINGS_NS = 'settings:email';
async function invalidateEmailSettingsCache(tenantId) {
    await cache.bumpNs(EMAIL_SETTINGS_NS, tenantId);
}

// @desc    Get email settings
// @route   GET /api/settings/email
// @access  Private
exports.getEmailSettings = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const payload = await cache.cached(
        { ns: EMAIL_SETTINGS_NS, tenantId, params: {}, ttlSec: TTL.REFERENCE },
        async () => {
            const settings = await EmailSettings.getSettings();
            if (!settings) {
                return { found: false };
            }
            // Mask password for security
            const masked = {
                ...settings.toObject(),
                smtpPassword: settings.smtpPassword ? '********' : ''
            };
            return { found: true, data: masked };
        }
    );

    if (!payload.found) {
        return res.status(200).json({
            success: true,
            data: null,
            message: 'No email settings configured'
        });
    }

    res.status(200).json({
        success: true,
        data: payload.data
    });
});

// @desc    Create or Update email settings
// @route   POST /api/settings/email
// @access  Private/Admin/Manager
exports.saveEmailSettings = asyncHandler(async (req, res) => {
    const {
        smtpHost,
        smtpPort,
        smtpSecure,
        smtpUsername,
        smtpPassword,
        fromEmail,
        fromName,
        replyToEmail,
        replyToName,
        enableEmailNotifications
    } = req.body;

    // Check if settings exist
    let settings = await EmailSettings.findOne();

    if (settings) {
        // Update existing settings
        const updateData = {
            smtpHost,
            smtpPort,
            smtpSecure,
            smtpUsername,
            fromEmail,
            fromName,
            replyToEmail,
            replyToName,
            enableEmailNotifications,
            updatedBy: req.user._id
        };

        // Only update password if provided and not masked
        if (smtpPassword && smtpPassword !== '********') {
            updateData.smtpPassword = smtpPassword;
        }

        settings = await EmailSettings.findByIdAndUpdate(
            settings._id,
            updateData,
            {
                new: true,
                runValidators: true
            }
        );
        await invalidateEmailSettingsCache(getTenantIdFromReq(req));

        res.status(200).json({
            success: true,
            message: 'Email settings updated successfully',
            data: {
                ...settings.toObject(),
                smtpPassword: '********'
            }
        });
    } else {
        // Create new settings
        settings = await EmailSettings.create({
            smtpHost,
            smtpPort,
            smtpSecure,
            smtpUsername,
            smtpPassword,
            fromEmail,
            fromName,
            replyToEmail,
            replyToName,
            enableEmailNotifications,
            createdBy: req.user._id
        });
        await invalidateEmailSettingsCache(getTenantIdFromReq(req));

        res.status(201).json({
            success: true,
            message: 'Email settings created successfully',
            data: {
                ...settings.toObject(),
                smtpPassword: '********'
            }
        });
    }
});

// @desc    Update email settings
// @route   PUT /api/settings/email
// @access  Private/Admin/Manager
exports.updateEmailSettings = asyncHandler(async (req, res) => {
    let settings = await EmailSettings.findOne();

    if (!settings) {
        return res.status(404).json({
            success: false,
            message: 'Email settings not found. Please create settings first.'
        });
    }

    const updateData = { ...req.body, updatedBy: req.user._id };

    // Don't update password if it's masked
    if (updateData.smtpPassword === '********') {
        delete updateData.smtpPassword;
    }

    settings = await EmailSettings.findByIdAndUpdate(
        settings._id,
        updateData,
        {
            new: true,
            runValidators: true
        }
    );
    await invalidateEmailSettingsCache(getTenantIdFromReq(req));

    res.status(200).json({
        success: true,
        message: 'Email settings updated successfully',
        data: {
            ...settings.toObject(),
            smtpPassword: '********'
        }
    });
});

// @desc    Delete email settings
// @route   DELETE /api/settings/email
// @access  Private/Admin
exports.deleteEmailSettings = asyncHandler(async (req, res) => {
    const settings = await EmailSettings.findOne();

    if (!settings) {
        return res.status(404).json({
            success: false,
            message: 'Email settings not found'
        });
    }

    await settings.deleteOne();
    await invalidateEmailSettingsCache(getTenantIdFromReq(req));

    res.status(200).json({
        success: true,
        message: 'Email settings deleted successfully'
    });
});

// @desc    Test email settings
// @route   POST /api/settings/email/test
// @access  Private/Admin/Manager
exports.testEmailSettings = asyncHandler(async (req, res) => {
    const stored = await EmailSettings.findOne();

    if (!stored) {
        return res.status(404).json({
            success: false,
            message: 'Email settings not found. Please configure email settings first.',
        });
    }

    const { testEmail } = req.body;
    const body = req.body || {};

    if (!testEmail) {
        return res.status(400).json({
            success: false,
            message: 'Test email address is required',
        });
    }

    // Use current form values when provided so Test works before Save (password kept from DB if masked).
    const settings = stored.toObject();
    const mergeFields = [
        'smtpHost', 'smtpPort', 'smtpSecure', 'smtpUsername',
        'fromEmail', 'fromName', 'replyToEmail', 'replyToName',
    ];
    for (const key of mergeFields) {
        if (body[key] != null && String(body[key]).trim() !== '') {
            settings[key] = body[key];
        }
    }
    if (body.smtpPort != null && String(body.smtpPort).trim() !== '') {
        settings.smtpPort = Number(body.smtpPort);
    }
    if (body.smtpPassword && String(body.smtpPassword).trim() && body.smtpPassword !== '********') {
        settings.smtpPassword = body.smtpPassword;
    }

    try {
        await emailService.sendTestEmail(settings, testEmail);
    } catch (err) {
        const message = err && err.message ? String(err.message) : 'Failed to send test email';
        return res.status(502).json({
            success: false,
            message,
        });
    }

    res.status(200).json({
        success: true,
        message: `Test email sent to ${testEmail}`,
    });
});
