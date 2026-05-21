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

module.exports = { getEffectiveRetailModeEnabled };
