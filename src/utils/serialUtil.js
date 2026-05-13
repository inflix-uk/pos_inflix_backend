/**
 * Shared serial/IMEI normalization. Must match logic used in stock adjustment, transfer, labels.
 * Used by SerialIndex, backfill, find-in-stock-serials.
 */
function normalizeSerial(str) {
    if (str == null) return '';
    return String(str).trim().replace(/\s+/g, ' ');
}

module.exports = { normalizeSerial };
