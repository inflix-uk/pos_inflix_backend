/**
 * GET /api/platform-connection/check — verify tenant backend can reach platform (admin only).
 */
const asyncHandler = require('../middleware/asyncHandler');
const platformClient = require('../lib/platformClient');
const config = require('../config');

exports.check = asyncHandler(async (req, res) => {
    if (!platformClient.isPlatformConfigured()) {
        return res.status(200).json({
            success: true,
            status: 'not_configured',
            message: 'Platform not configured (PLATFORM_BASE_URL unset)',
            tenantId: config.tenantId || 'default'
        });
    }
    const start = Date.now();
    try {
        await platformClient.fetchPlatformEntitlements();
        const latencyMs = Date.now() - start;
        return res.status(200).json({
            success: true,
            status: 'ok',
            tenantId: config.tenantId || 'default',
            latencyMs
        });
    } catch (e) {
        const latencyMs = Date.now() - start;
        return res.status(200).json({
            success: false,
            status: 'error',
            tenantId: config.tenantId || 'default',
            latencyMs,
            error: e.message || 'Platform request failed',
            code: e.code || null
        });
    }
});
