const PrintingSettings = require('../models/PrintingSettings');
const asyncHandler = require('../middleware/asyncHandler');
const activityLogService = require('../services/activityLogService');
const { getTenantIdFromReq } = require('../middleware/auth');
const cache = require('../lib/cache');
const TTL = require('../lib/cacheTTL');

const PRINTING_SETTINGS_NS = 'settings:printing';
async function invalidatePrintingSettingsCache(tenantId) {
    await cache.bumpNs(PRINTING_SETTINGS_NS, tenantId);
}

// @desc    Get printing settings for a device
// @route   GET /api/settings/printing?deviceId=xxx
// @access  Private (settings.view)
exports.getPrintingSettings = asyncHandler(async (req, res) => {
    const deviceId = (req.query.deviceId || '').toString().trim();
    if (!deviceId) {
        return res.status(400).json({ success: false, message: 'deviceId is required' });
    }
    const tenantId = getTenantIdFromReq(req);

    const responseData = await cache.cached(
        { ns: PRINTING_SETTINGS_NS, tenantId, params: { deviceId }, ttlSec: TTL.REFERENCE },
        async () => {
            let settings = await PrintingSettings.findOne({ deviceId }).lean();
            if (!settings) {
                settings = {
                    deviceId,
                    silentPrintingEnabled: false,
                    agentUrl: 'http://127.0.0.1:9123',
                    agentToken: '',
                    receiptPrinterName: '',
                    labelPrinterName: '',
                    a4PrinterName: '',
                    updatedByUserId: null,
                    createdAt: null,
                    updatedAt: null
                };
            }
            // Do not send token value to client for security (client stores it in localStorage)
            const { agentToken, ...safe } = settings;
            return { ...safe, hasAgentToken: !!agentToken };
        }
    );

    res.status(200).json({
        success: true,
        data: responseData
    });
});

// @desc    Update printing settings for a device
// @route   PUT /api/settings/printing
// @access  Private (settings.manage)
exports.updatePrintingSettings = asyncHandler(async (req, res) => {
    const deviceId = (req.body.deviceId || '').toString().trim();
    if (!deviceId) {
        return res.status(400).json({ success: false, message: 'deviceId is required' });
    }

    const before = await PrintingSettings.findOne({ deviceId }).lean();
    const updates = {
        silentPrintingEnabled: req.body.silentPrintingEnabled,
        agentUrl: req.body.agentUrl,
        receiptPrinterName: req.body.receiptPrinterName,
        labelPrinterName: req.body.labelPrinterName,
        a4PrinterName: req.body.a4PrinterName,
        updatedByUserId: req.user._id
    };
    if (req.body.agentToken !== undefined) {
        updates.agentToken = String(req.body.agentToken || '').trim();
    }

    let settings = await PrintingSettings.findOneAndUpdate(
        { deviceId },
        { $set: updates },
        { new: true, upsert: true, runValidators: true }
    ).lean();

    await activityLogService.logFromReq(req, {
        action: 'SETTINGS_PRINTING_UPDATED',
        entityType: 'Settings',
        entityId: settings._id,
        success: true,
        message: `Printing settings updated for device ${deviceId}`,
        metaJson: { deviceId },
        beforeJson: before || null,
        afterJson: settings
    });
    await invalidatePrintingSettingsCache(getTenantIdFromReq(req));

    const { agentToken: _at, ...safe } = settings;
    res.status(200).json({
        success: true,
        data: { ...safe, hasAgentToken: !!settings.agentToken }
    });
});
