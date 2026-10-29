/**
 * Shared serial/IMEI normalization. Must match logic used in stock adjustment, transfer, labels.
 * Used by SerialIndex, backfill, find-in-stock-serials.
 */

// Zero-width spaces/joiners, word joiner, BOM and soft hyphen ride along when a serial is
// copied from WhatsApp or Excel. They are never part of a serial.
const INVISIBLE_CHARS = /[​-‍⁠﻿­]/g;

function normalizeSerial(str) {
    if (str == null) return '';
    return String(str).replace(INVISIBLE_CHARS, '').trim().replace(/\s+/g, ' ');
}

/**
 * Serials to try, in order, when a scanned/typed serial has no exact match:
 * as entered → upper case (scanner with Caps Lock on types lower case) →
 * without a leading "S" (Apple box barcodes print "S" + serial).
 */
function serialLookupCandidates(str) {
    const base = normalizeSerial(str);
    if (!base) return [];
    const out = [base, base.toUpperCase()];
    if (/^s[a-z0-9]{10,}$/i.test(base)) {
        const rest = base.slice(1);
        out.push(rest, rest.toUpperCase());
    }
    return [...new Set(out)];
}

module.exports = { normalizeSerial, serialLookupCandidates };
