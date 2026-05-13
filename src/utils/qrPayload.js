/**
 * Standard QR payload format for POS labels and scan flow.
 * Format: POSv1|<type>|<id>
 * Types: product | serial | location
 * Single parser used everywhere for consistency.
 */

const PREFIX = 'POSv1';
const TYPES = ['product', 'serial', 'location'];

/**
 * Parse a scanned or pasted QR payload.
 * @param {string} payload - Raw string (e.g. from QR or input)
 * @returns {{ type: 'product'|'serial'|'location', id: string } | null} - Parsed result or null if invalid
 */
function parseQrPayload(payload) {
    if (!payload || typeof payload !== 'string') return null;
    const s = payload.trim();
    // Support both "POSv1|type|id" and legacy "POS|type|id"
    const parts = s.split('|');
    if (parts.length < 3) return null;
    const [prefix, type, ...rest] = parts;
    const id = rest.join('|').trim(); // id may contain pipes in theory
    if (!id) return null;
    if ((prefix !== 'POSv1' && prefix !== 'POS') || !TYPES.includes(type)) return null;
    return { type, id };
}

/**
 * Build a QR payload string for encoding in a QR code.
 * @param {'product'|'serial'|'location'} type
 * @param {string} id - productId, IMEI/serial, or locationId
 * @returns {string}
 */
function buildQrPayload(type, id) {
    if (!TYPES.includes(type) || !id) return '';
    return `${PREFIX}|${type}|${id}`;
}

module.exports = { parseQrPayload, buildQrPayload, PREFIX, TYPES };
