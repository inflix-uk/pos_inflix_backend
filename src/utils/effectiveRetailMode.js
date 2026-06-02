const User = require('../models/User');
const GeneralSettings = require('../models/GeneralSettings');

/**
 * Effective retail mode for a user: personal preference when set, otherwise company default.
 */
async function getEffectiveRetailModeEnabled(userId) {
    if (!userId) {
        const gs = await GeneralSettings.getSettings();
        return !!gs.retailModeEnabled;
    }
    const user = await User.findById(userId).select('preferredRetailModeEnabled').lean();
    if (user && typeof user.preferredRetailModeEnabled === 'boolean') {
        return user.preferredRetailModeEnabled;
    }
    const gs = await GeneralSettings.getSettings();
    return !!gs.retailModeEnabled;
}

/** Preferred + effective retail mode for API responses (always reads from DB). */
async function getUserSalesModeFields(userId) {
    if (!userId) {
        const gs = await GeneralSettings.getSettings();
        const effectiveRetailModeEnabled = !!gs.retailModeEnabled;
        return { preferredRetailModeEnabled: null, effectiveRetailModeEnabled };
    }
    const user = await User.findById(userId).select('preferredRetailModeEnabled').lean();
    const preferredRetailModeEnabled =
        user && typeof user.preferredRetailModeEnabled === 'boolean'
            ? user.preferredRetailModeEnabled
            : null;
    const effectiveRetailModeEnabled = await getEffectiveRetailModeEnabled(userId);
    return { preferredRetailModeEnabled, effectiveRetailModeEnabled };
}

module.exports = { getEffectiveRetailModeEnabled, getUserSalesModeFields };
