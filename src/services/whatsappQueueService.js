/**
 * WhatsApp outbound queue — the only path a WhatsApp message takes out of the POS.
 *
 * Enqueue applies the checks that can be answered immediately (duplicate guard,
 * per-recipient daily cap) so the user gets feedback straight away. Delivery is
 * done by services/whatsappQueueWorker.js, one message at a time per tenant,
 * gated by the random delay, hourly limit and daily limit, with the
 * per-recipient cap re-checked at send time.
 *
 * Must be called inside a tenant context (request or worker) — models route to
 * the tenant DB via lib/tenantModel.
 */
const crypto = require('crypto');
const mongoose = require('mongoose');
const WhatsappMessage = require('../models/WhatsappMessage');
const WhatsappSettings = require('../models/WhatsappSettings');
const { getLondonDayStart } = require('../utils/dateKey');
const { WHATSAPP_SAFETY_BOUNDS } = require('../config/whatsappSafety');

const { WHATSAPP_MESSAGE_STATUSES } = WhatsappMessage;

const HOUR_MS = 60 * 60 * 1000;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_LENGTH = 4000;
// WhatsApp truncates document captions at ~1024 characters.
const MAX_CAPTION_LENGTH = 1000;
const SETTINGS_FIELDS = Object.keys(WHATSAPP_SAFETY_BOUNDS);

class WhatsappQueueError extends Error {
    constructor(message, code, status) {
        super(message);
        this.code = code;
        this.status = status;
    }
}

/**
 * Normalise a phone number to WhatsApp's international digits-only form.
 * Numbers without an international prefix are treated as UK numbers
 * (07700 900000 → 447700900000). Returns '' when the result isn't plausible.
 */
function normalizePhone(raw) {
    const trimmed = String(raw || '').trim();
    let digits = trimmed.replace(/\D/g, '');
    if (!trimmed.startsWith('+')) {
        if (digits.startsWith('00')) digits = digits.slice(2);
        else if (digits.startsWith('0')) digits = `44${digits.slice(1)}`;
    }
    // "+44 (0)7700 900000" — UK numbers never have a 0 after the country code.
    if (digits.startsWith('440')) digits = `44${digits.slice(3)}`;
    return /^[1-9]\d{7,14}$/.test(digits) ? digits : '';
}

function textDedupeKey(text) {
    return `text:${crypto.createHash('sha256').update(String(text).trim()).digest('hex')}`;
}

function invoiceDedupeKey(invoiceId) {
    return `invoice:${invoiceId}`;
}

function toSettingsDto(settings) {
    const dto = {};
    for (const field of SETTINGS_FIELDS) dto[field] = settings[field];
    return dto;
}

/**
 * Validate a settings update against WHATSAPP_SAFETY_BOUNDS and the current values.
 * Returns only the fields to change; throws WhatsappQueueError(400) on invalid input.
 */
function validateSettingsUpdate(body, current) {
    const changes = {};
    for (const field of SETTINGS_FIELDS) {
        if (body == null || body[field] === undefined) continue;
        const { min, max, label } = WHATSAPP_SAFETY_BOUNDS[field];
        const value = Number(body[field]);
        if (!Number.isInteger(value) || value < min || value > max) {
            throw new WhatsappQueueError(`${label} must be a whole number between ${min} and ${max}`, 'INVALID_SETTINGS', 400);
        }
        changes[field] = value;
    }
    const merged = { ...toSettingsDto(current), ...changes };
    if (merged.messageDelayMinSeconds > merged.messageDelayMaxSeconds) {
        throw new WhatsappQueueError('Minimum message delay cannot be greater than the maximum delay', 'INVALID_SETTINGS', 400);
    }
    return changes;
}

function randomDelaySeconds(settings) {
    const lo = Math.min(settings.messageDelayMinSeconds, settings.messageDelayMaxSeconds);
    const hi = Math.max(settings.messageDelayMinSeconds, settings.messageDelayMaxSeconds);
    return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function toMessageDto(doc) {
    const m = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
    if (m.attachment) {
        const { data, ...meta } = m.attachment;
        m.attachment = meta.filename ? meta : undefined;
    }
    return m;
}

function countSentSince(since, extra = {}) {
    return WhatsappMessage.countDocuments({ status: 'sent', sentAt: { $gte: since }, ...extra });
}

/** Live counters for the settings page and for the worker's send gate. */
async function getUsage(settings, now = new Date()) {
    const hourStart = new Date(now.getTime() - HOUR_MS);
    const dayStart = getLondonDayStart(now);
    // Days are 23–25h long around DST changes; +26h always lands inside the next day.
    const nextDayStart = getLondonDayStart(new Date(dayStart.getTime() + 26 * HOUR_MS));

    const [hourlyUsed, dailyUsed, oldestInHour, statusCounts] = await Promise.all([
        countSentSince(hourStart),
        countSentSince(dayStart),
        WhatsappMessage.findOne({ status: 'sent', sentAt: { $gte: hourStart } }).sort({ sentAt: 1 }).select('sentAt').lean(),
        WhatsappMessage.aggregate([
            { $match: { status: { $in: ['pending', 'sending', 'blocked', 'failed'] } } },
            { $group: { _id: '$status', count: { $sum: 1 } } },
        ]),
    ]);

    const queue = { pending: 0, sending: 0, blocked: 0, failed: 0 };
    for (const row of statusCounts) queue[row._id] = row.count;

    const nextSendAt = settings.nextSendEligibleAt ? new Date(settings.nextSendEligibleAt) : new Date(0);
    const cooldownSeconds = Math.max(0, Math.ceil((nextSendAt.getTime() - now.getTime()) / 1000));

    return {
        hourly: {
            used: hourlyUsed,
            limit: settings.hourlyLimit,
            // Seconds until the oldest send in the rolling hour drops out.
            resetInSeconds: oldestInHour
                ? Math.max(0, Math.ceil((new Date(oldestInHour.sentAt).getTime() + HOUR_MS - now.getTime()) / 1000))
                : 0,
        },
        daily: {
            used: dailyUsed,
            limit: settings.dailyLimit,
            resetInSeconds: Math.max(0, Math.ceil((nextDayStart.getTime() - now.getTime()) / 1000)),
        },
        cooldown: {
            active: cooldownSeconds > 0,
            remainingSeconds: cooldownSeconds,
            nextSendAt: cooldownSeconds > 0 ? nextSendAt : null,
        },
        queue,
    };
}

/** Worker gate: may this tenant send a message right now? */
async function checkSendGate(settings, now = new Date()) {
    const nextSendAt = settings.nextSendEligibleAt ? new Date(settings.nextSendEligibleAt).getTime() : 0;
    if (nextSendAt > now.getTime()) {
        return { ok: false, rule: 'messageDelay' };
    }
    const hourlyUsed = await countSentSince(new Date(now.getTime() - HOUR_MS));
    if (hourlyUsed >= settings.hourlyLimit) {
        return { ok: false, rule: 'hourlyLimit' };
    }
    const dailyUsed = await countSentSince(getLondonDayStart(now));
    if (dailyUsed >= settings.dailyLimit) {
        return { ok: false, rule: 'dailyLimit' };
    }
    return { ok: true };
}

function countRecipientSentToday(phone, now = new Date()) {
    return countSentSince(getLondonDayStart(now), { recipientPhone: phone });
}

/**
 * Queue a message. Throws WhatsappQueueError for invalid input, duplicates
 * (409) or when the recipient's daily cap is already used up (429).
 */
async function enqueueMessage({
    phone,
    recipientName = '',
    text = '',
    attachment = null,
    source,
    sourceRef,
    dedupeKey,
    createdByUserId,
}) {
    const recipientPhone = normalizePhone(phone);
    if (!recipientPhone) {
        throw new WhatsappQueueError(
            'Enter a valid WhatsApp number, e.g. +44 7700 900000 (numbers starting with 0 are treated as UK numbers)',
            'INVALID_PHONE',
            400
        );
    }
    const body = String(text || '').trim();
    const maxLength = attachment ? MAX_CAPTION_LENGTH : MAX_TEXT_LENGTH;
    if (body.length > maxLength) {
        throw new WhatsappQueueError(`Message cannot exceed ${maxLength} characters`, 'INVALID_TEXT', 400);
    }
    if (!attachment && !body) {
        throw new WhatsappQueueError('Message text is required', 'INVALID_TEXT', 400);
    }
    if (attachment && (!attachment.data || !attachment.data.length)) {
        throw new WhatsappQueueError('Attachment is empty', 'INVALID_ATTACHMENT', 400);
    }
    if (attachment && attachment.data.length > MAX_ATTACHMENT_BYTES) {
        throw new WhatsappQueueError('Attachment is too large to send over WhatsApp (max 8 MB)', 'INVALID_ATTACHMENT', 400);
    }

    const settings = await WhatsappSettings.getSettings();
    const now = new Date();

    const duplicate = await WhatsappMessage.findOne({
        recipientPhone,
        dedupeKey,
        $or: [
            { status: { $in: ['pending', 'sending'] } },
            { status: 'sent', sentAt: { $gte: new Date(now.getTime() - settings.duplicateWindowMinutes * 60 * 1000) } },
        ],
    }).select('status').lean();
    if (duplicate) {
        throw new WhatsappQueueError(
            duplicate.status === 'sent'
                ? `This was already sent to +${recipientPhone} in the last ${settings.duplicateWindowMinutes} min`
                : `This is already queued for +${recipientPhone}`,
            'DUPLICATE',
            409
        );
    }

    const [sentToday, queuedForRecipient] = await Promise.all([
        countRecipientSentToday(recipientPhone, now),
        WhatsappMessage.countDocuments({ recipientPhone, status: { $in: ['pending', 'sending'] } }),
    ]);
    if (sentToday + queuedForRecipient >= settings.dailyCapPerRecipient) {
        throw new WhatsappQueueError(
            `Daily limit for +${recipientPhone} reached (${settings.dailyCapPerRecipient} messages per day). Try again tomorrow.`,
            'RECIPIENT_DAILY_CAP',
            429
        );
    }

    const doc = await WhatsappMessage.create({
        recipientPhone,
        recipientName: String(recipientName || '').trim(),
        text: body,
        attachment: attachment
            ? {
                filename: attachment.filename,
                mimetype: attachment.mimetype,
                size: attachment.data.length,
                data: attachment.data,
            }
            : undefined,
        source,
        sourceRef,
        dedupeKey,
        scheduledAt: now,
        createdByUserId,
    });

    const queuedAhead = await WhatsappMessage.countDocuments({
        _id: { $ne: doc._id },
        status: { $in: ['pending', 'sending'] },
        scheduledAt: { $lte: doc.scheduledAt },
    });

    const nextSendEligibleAt = settings.nextSendEligibleAt ? new Date(settings.nextSendEligibleAt) : new Date(0);
    return {
        message: toMessageDto(doc),
        queuedAhead,
        nextSendAt: nextSendEligibleAt > now ? nextSendEligibleAt : now,
    };
}

async function listMessages({ status, limit } = {}) {
    const query = WHATSAPP_MESSAGE_STATUSES.includes(status) ? { status } : {};
    const size = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const docs = await WhatsappMessage.find(query)
        .sort({ createdAt: -1 })
        .limit(size)
        .select('-attachment.data')
        .lean();
    return docs.map(toMessageDto);
}

async function transitionMessage(id, fromStatuses, update, actionLabel) {
    if (!mongoose.isValidObjectId(id)) {
        throw new WhatsappQueueError('Message not found', 'NOT_FOUND', 404);
    }
    const doc = await WhatsappMessage.findOneAndUpdate(
        { _id: id, status: { $in: fromStatuses } },
        update,
        { new: true }
    ).select('-attachment.data').lean();
    if (doc) return toMessageDto(doc);

    const existing = await WhatsappMessage.findById(id).select('status').lean();
    if (!existing) throw new WhatsappQueueError('Message not found', 'NOT_FOUND', 404);
    throw new WhatsappQueueError(
        `Only ${fromStatuses.join(', ')} messages can be ${actionLabel} (this one is ${existing.status})`,
        'INVALID_STATUS',
        409
    );
}

function cancelMessage(id) {
    return transitionMessage(
        id,
        ['pending', 'blocked', 'failed'],
        { $set: { status: 'cancelled' }, $unset: { 'attachment.data': 1 } },
        'cancelled'
    );
}

function retryMessage(id) {
    return transitionMessage(
        id,
        ['blocked', 'failed'],
        { $set: { status: 'pending', scheduledAt: new Date(), attempts: 0 }, $unset: { error: 1, blockedByRule: 1 } },
        'retried'
    );
}

// ---- Worker helpers --------------------------------------------------------

/**
 * Put messages stranded in `sending` (process died mid-send) back in the queue,
 * or fail them once they have used up their attempts.
 */
async function reclaimStaleSending(staleAfterMs, maxAttempts) {
    const staleBefore = new Date(Date.now() - staleAfterMs);
    await WhatsappMessage.updateMany(
        { status: 'sending', updatedAt: { $lte: staleBefore }, attempts: { $gte: maxAttempts } },
        { $set: { status: 'failed', error: 'Sending was interrupted too many times' } }
    );
    await WhatsappMessage.updateMany(
        { status: 'sending', updatedAt: { $lte: staleBefore } },
        { $set: { status: 'pending', scheduledAt: new Date() } }
    );
}

/** Atomically claim the oldest eligible pending message (includes attachment data). */
function claimNextPending(now = new Date()) {
    return WhatsappMessage.findOneAndUpdate(
        { status: 'pending', scheduledAt: { $lte: now } },
        { $set: { status: 'sending', lastAttemptAt: now }, $inc: { attempts: 1 } },
        { sort: { scheduledAt: 1, createdAt: 1 }, new: true }
    );
}

function markSent(id, providerMessageId) {
    return WhatsappMessage.updateOne(
        { _id: id, status: 'sending' },
        {
            $set: { status: 'sent', sentAt: new Date(), providerMessageId: providerMessageId || null },
            $unset: { 'attachment.data': 1, error: 1 },
        }
    );
}

function markBlocked(id, rule, reason) {
    return WhatsappMessage.updateOne(
        { _id: id, status: 'sending' },
        { $set: { status: 'blocked', blockedByRule: rule, error: reason }, $inc: { attempts: -1 } }
    );
}

/**
 * Record a failed delivery attempt. `err.code`:
 *   WA_NOT_CONNECTED                           nothing was attempted — back to pending, attempt not counted
 *   WA_NOT_ON_WHATSAPP, WA_ATTACHMENT_MISSING  permanent — failed
 *   anything else                              retried with backoff until attempts run out
 */
const PERMANENT_SEND_ERRORS = ['WA_NOT_ON_WHATSAPP', 'WA_ATTACHMENT_MISSING'];

function markSendFailure(message, err, { maxAttempts, retryBackoffMs }) {
    const error = String((err && err.message) || 'WhatsApp send failed').slice(0, 500);
    if (err && err.code === 'WA_NOT_CONNECTED') {
        return WhatsappMessage.updateOne(
            { _id: message._id, status: 'sending' },
            { $set: { status: 'pending', error }, $inc: { attempts: -1 } }
        );
    }
    const permanent = !!err && PERMANENT_SEND_ERRORS.includes(err.code);
    if (!permanent && message.attempts < maxAttempts) {
        return WhatsappMessage.updateOne(
            { _id: message._id, status: 'sending' },
            { $set: { status: 'pending', error, scheduledAt: new Date(Date.now() + retryBackoffMs * message.attempts) } }
        );
    }
    return WhatsappMessage.updateOne(
        { _id: message._id, status: 'sending' },
        { $set: { status: 'failed', error } }
    );
}

/** Start the random pause before the tenant's next message. */
async function armNextDelay(settings) {
    const seconds = randomDelaySeconds(settings);
    await WhatsappSettings.updateOne(
        { _id: settings._id },
        { $set: { nextSendEligibleAt: new Date(Date.now() + seconds * 1000) } }
    );
    return seconds;
}

module.exports = {
    WhatsappQueueError,
    MAX_ATTACHMENT_BYTES,
    normalizePhone,
    textDedupeKey,
    invoiceDedupeKey,
    toSettingsDto,
    validateSettingsUpdate,
    randomDelaySeconds,
    getUsage,
    checkSendGate,
    countRecipientSentToday,
    enqueueMessage,
    listMessages,
    cancelMessage,
    retryMessage,
    reclaimStaleSending,
    claimNextPending,
    markSent,
    markBlocked,
    markSendFailure,
    armNextDelay,
};
