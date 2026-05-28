/**
 * Resolve which location's details to use for receipt/invoice printing.
 * Source of truth: Sale.locationId. Fallback: first active location, then "Unknown location".
 */
const Location = require('../models/Location');

/**
 * Build address lines from Location document (address, city, postcode, country, phone, email).
 * @param {Object} loc - Location doc (lean) with name, address, city, postcode, country, phone, email
 * @returns {string[]} Lines for header (max 6 lines)
 */
function getLocationPostalLines(loc) {
    if (!loc) return [];
    const lines = [];
    if (loc.address && String(loc.address).trim()) lines.push(String(loc.address).trim());
    if (loc.city && String(loc.city).trim()) lines.push(String(loc.city).trim());
    if (loc.postcode && String(loc.postcode).trim()) lines.push(String(loc.postcode).trim());
    if (loc.country && String(loc.country).trim()) lines.push(String(loc.country).trim());
    return lines.slice(0, 6);
}

/** Newline-separated postal lines only (no phone/email) — matches thermal/PDF layout toggles. */
function getLocationPostalBlock(loc) {
    return getLocationPostalLines(loc).join('\n');
}

function getLocationAddressLines(loc) {
    if (!loc) return [];
    const lines = getLocationPostalLines(loc);
    if (loc.phone && String(loc.phone).trim()) lines.push(`Tel: ${String(loc.phone).trim()}`);
    if (loc.email && String(loc.email).trim()) lines.push(String(loc.email).trim());
    return lines.slice(0, 6);
}

/**
 * Get a single line address string (e.g. for ESC/POS or PDF) from location.
 * @param {Object} loc - Location doc (lean)
 * @returns {string} Newline-separated address block
 */
function getLocationAddressBlock(loc) {
    return getLocationAddressLines(loc).join('\n');
}

/**
 * Resolve location for printing: by sale.locationId, else first active location.
 * @param {ObjectId|null} saleLocationId - Sale.locationId
 * @returns {Promise<{ location: Object|null, fallbackLabel: string|null }>}
 *   location: { name, address, city, postcode, country, phone, email } or null
 *   fallbackLabel: 'Unknown location' when no location could be resolved, else null
 */
async function resolveLocationForPrint(saleLocationId) {
    let location = null;
    if (saleLocationId) {
        location = await Location.findById(saleLocationId)
            .select('name address city postcode country phone email contactPerson companyNumber vatNumber')
            .lean();
    }
    if (!location) {
        const first = await Location.findOne({ isActive: true }).sort({ name: 1 }).select('name address city postcode country phone email contactPerson companyNumber vatNumber').lean();
        location = first;
    }
    if (!location) {
        return { location: null, fallbackLabel: 'Unknown location' };
    }
    return {
        location: {
            name: location.name || '',
            address: location.address || '',
            city: location.city || '',
            postcode: location.postcode || '',
            country: location.country || '',
            phone: location.phone || '',
            email: location.email || '',
            contactPerson: location.contactPerson || '',
            companyNumber: location.companyNumber || '',
            vatNumber: location.vatNumber || ''
        },
        fallbackLabel: null
    };
}

module.exports = {
    getLocationPostalLines,
    getLocationPostalBlock,
    getLocationAddressLines,
    getLocationAddressBlock,
    resolveLocationForPrint
};
