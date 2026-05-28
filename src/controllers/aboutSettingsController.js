const AboutSettings = require('../models/AboutSettings');
const asyncHandler = require('../middleware/asyncHandler');
const sharp = require('sharp');
const { getTenantIdFromReq } = require('../middleware/auth');
const cache = require('../lib/cache');
const TTL = require('../lib/cacheTTL');

const ABOUT_SETTINGS_NS = 'settings:about';
async function invalidateAboutSettingsCache(tenantId) {
    await cache.bumpNs(ABOUT_SETTINGS_NS, tenantId);
}

// @desc    Get about settings
// @route   GET /api/settings/about
// @access  Private
exports.getAboutSettings = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const settings = await cache.cached(
        { ns: ABOUT_SETTINGS_NS, tenantId, params: {}, ttlSec: TTL.REFERENCE },
        async () => await AboutSettings.getSettings()
    );

    res.status(200).json({
        success: true,
        data: settings
    });
});

// @desc    Create or Update about settings
// @route   POST /api/settings/about
// @access  Private/Admin/Manager
exports.saveAboutSettings = asyncHandler(async (req, res) => {
    const {
        appTitle,
        appName,
        logo,
        loginPageTitle,
        companyAddress,
        companyNumber,
        vatNumber,
        orderPdfTitle,
        invoicePdfTitle
    } = req.body;

    // Check if settings exist
    let settings = await AboutSettings.findOne();

    if (settings) {
        // Update existing settings
        settings = await AboutSettings.findByIdAndUpdate(
            settings._id,
            {
                appTitle,
                appName,
                logo,
                loginPageTitle,
                companyAddress,
                companyNumber: companyNumber ?? '',
                vatNumber: vatNumber ?? '',
                orderPdfTitle,
                invoicePdfTitle,
                updatedBy: req.user._id
            },
            {
                new: true,
                runValidators: true
            }
        );
        await invalidateAboutSettingsCache(getTenantIdFromReq(req));

        res.status(200).json({
            success: true,
            message: 'Settings updated successfully',
            data: settings
        });
    } else {
        // Create new settings
        settings = await AboutSettings.create({
            appTitle,
            appName,
            logo,
            loginPageTitle,
            companyAddress,
            companyNumber: companyNumber ?? '',
            vatNumber: vatNumber ?? '',
            orderPdfTitle,
            invoicePdfTitle,
            createdBy: req.user._id
        });
        await invalidateAboutSettingsCache(getTenantIdFromReq(req));

        res.status(201).json({
            success: true,
            message: 'Settings created successfully',
            data: settings
        });
    }
});

// @desc    Update about settings
// @route   PUT /api/settings/about
// @access  Private/Admin/Manager
exports.updateAboutSettings = asyncHandler(async (req, res) => {
    let settings = await AboutSettings.findOne();

    if (!settings) {
        return res.status(404).json({
            success: false,
            message: 'Settings not found. Please create settings first.'
        });
    }

    const updateData = { ...req.body, updatedBy: req.user._id };

    settings = await AboutSettings.findByIdAndUpdate(
        settings._id,
        updateData,
        {
            new: true,
            runValidators: true
        }
    );
    await invalidateAboutSettingsCache(getTenantIdFromReq(req));

    res.status(200).json({
        success: true,
        message: 'Settings updated successfully',
        data: settings
    });
});

// @desc    Delete about settings (reset to defaults)
// @route   DELETE /api/settings/about
// @access  Private/Admin
exports.deleteAboutSettings = asyncHandler(async (req, res) => {
    const settings = await AboutSettings.findOne();

    if (!settings) {
        return res.status(404).json({
            success: false,
            message: 'Settings not found'
        });
    }

    await settings.deleteOne();

    // Create new settings with defaults
    const newSettings = await AboutSettings.create({
        createdBy: req.user._id
    });
    await invalidateAboutSettingsCache(getTenantIdFromReq(req));

    res.status(200).json({
        success: true,
        message: 'Settings reset to defaults successfully',
        data: newSettings
    });
});

// @desc    Upload logo
// @route   POST /api/settings/about/logo
// @access  Private/Admin/Manager
exports.uploadLogo = asyncHandler(async (req, res) => {
    if (!req.file) {
        return res.status(400).json({
            success: false,
            message: 'Please upload a file'
        });
    }

    try {
        // Get image metadata to validate dimensions
        const metadata = await sharp(req.file.buffer).metadata();
        const maxWidth = 500;
        const maxHeight = 200;
        
        // Validate dimensions (recommended: max 500x200 for invoice/receipt)
        if (metadata.width > maxWidth || metadata.height > maxHeight) {
            // Resize if too large
            const resizedBuffer = await sharp(req.file.buffer)
                .resize(maxWidth, maxHeight, {
                    fit: 'inside',
                    withoutEnlargement: true
                })
                .png()
                .toBuffer();
            
            // Convert resized image to base64
            const base64Logo = `data:image/png;base64,${resizedBuffer.toString('base64')}`;
            
            let settings = await AboutSettings.findOne();
            
            if (settings) {
                settings = await AboutSettings.findByIdAndUpdate(
                    settings._id,
                    { logo: base64Logo, updatedBy: req.user._id },
                    { new: true }
                );
            } else {
                settings = await AboutSettings.create({
                    logo: base64Logo,
                    createdBy: req.user._id
                });
            }
            await invalidateAboutSettingsCache(getTenantIdFromReq(req));

            res.status(200).json({
                success: true,
                message: 'Logo uploaded and resized successfully',
                data: {
                    logo: base64Logo,
                    settings,
                    originalSize: { width: metadata.width, height: metadata.height },
                    resizedTo: { width: maxWidth, height: maxHeight }
                }
            });
        } else {
            // Image is within size limits, convert to base64 as-is
            const mimeType = req.file.mimetype || `image/${metadata.format || 'png'}`;
            const base64Logo = `data:${mimeType};base64,${req.file.buffer.toString('base64')}`;
            
            let settings = await AboutSettings.findOne();
            
            if (settings) {
                settings = await AboutSettings.findByIdAndUpdate(
                    settings._id,
                    { logo: base64Logo, updatedBy: req.user._id },
                    { new: true }
                );
            } else {
                settings = await AboutSettings.create({
                    logo: base64Logo,
                    createdBy: req.user._id
                });
            }
            await invalidateAboutSettingsCache(getTenantIdFromReq(req));

            res.status(200).json({
                success: true,
                message: 'Logo uploaded successfully',
                data: {
                    logo: base64Logo,
                    settings,
                    size: { width: metadata.width, height: metadata.height }
                }
            });
        }
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message || 'Failed to process logo image'
        });
    }
});

// @desc    Remove logo
// @route   DELETE /api/settings/about/logo
// @access  Private/Admin/Manager
exports.removeLogo = asyncHandler(async (req, res) => {
    let settings = await AboutSettings.findOne();

    if (!settings) {
        return res.status(404).json({
            success: false,
            message: 'Settings not found'
        });
    }

    settings = await AboutSettings.findByIdAndUpdate(
        settings._id,
        { logo: null, updatedBy: req.user._id },
        { new: true }
    );
    await invalidateAboutSettingsCache(getTenantIdFromReq(req));

    res.status(200).json({
        success: true,
        message: 'Logo removed successfully',
        data: settings
    });
});
