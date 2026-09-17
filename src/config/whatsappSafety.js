/**
 * WhatsApp sending safety limits.
 *
 * Messages go out through a QR-linked (unofficial) WhatsApp session. Sending
 * too fast or too much gets the number flagged or banned, so every message is
 * queued and paced by these limits. DEFAULTS apply to every tenant until an
 * admin changes them in Settings → WhatsApp; BOUNDS stop the limits from being
 * set to values that would effectively disable the protection.
 */

const WHATSAPP_SAFETY_DEFAULTS = Object.freeze({
    messageDelayMinSeconds: 240,
    messageDelayMaxSeconds: 420,
    hourlyLimit: 15,
    dailyLimit: 100,
    dailyCapPerRecipient: 5,
    duplicateWindowMinutes: 10,
});

const WHATSAPP_SAFETY_BOUNDS = Object.freeze({
    messageDelayMinSeconds: { min: 30, max: 3600, label: 'Minimum message delay (seconds)' },
    messageDelayMaxSeconds: { min: 30, max: 3600, label: 'Maximum message delay (seconds)' },
    hourlyLimit: { min: 1, max: 200, label: 'Hourly limit' },
    dailyLimit: { min: 1, max: 2000, label: 'Daily limit' },
    dailyCapPerRecipient: { min: 1, max: 100, label: 'Per-recipient daily cap' },
    duplicateWindowMinutes: { min: 1, max: 1440, label: 'Duplicate window (minutes)' },
});

module.exports = { WHATSAPP_SAFETY_DEFAULTS, WHATSAPP_SAFETY_BOUNDS };
