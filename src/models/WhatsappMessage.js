const mongoose = require('mongoose');

const WHATSAPP_MESSAGE_STATUSES = ['pending', 'sending', 'sent', 'failed', 'blocked', 'cancelled'];
const WHATSAPP_MESSAGE_SOURCES = ['invoice', 'test'];

/**
 * Outbound WhatsApp queue. Every WhatsApp message is stored here as `pending`
 * and delivered one at a time by services/whatsappQueueWorker.js, which moves
 * it to `sent`, `failed` (after retries) or `blocked` (safety limit at send time).
 */
const whatsappMessageSchema = new mongoose.Schema({
    // Digits only, international format without "+" (e.g. 447700900000).
    recipientPhone: { type: String, required: true, trim: true },
    recipientName: { type: String, trim: true, default: '' },
    // Message body, or the caption when an attachment is present.
    text: { type: String, default: '' },
    attachment: {
        filename: { type: String },
        mimetype: { type: String },
        size: { type: Number },
        // Removed once the message is sent or cancelled; kept for failed/blocked so they can be retried.
        data: { type: Buffer },
    },
    source: { type: String, enum: WHATSAPP_MESSAGE_SOURCES, required: true },
    sourceRef: {
        invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },
        reference: { type: String },
    },
    // Identifies "the same message" for the duplicate guard (e.g. invoice:<id>, text:<sha256>).
    dedupeKey: { type: String, required: true },
    status: { type: String, enum: WHATSAPP_MESSAGE_STATUSES, default: 'pending' },
    // The worker does not pick a message up before this time (used for retry backoff).
    scheduledAt: { type: Date, default: Date.now },
    attempts: { type: Number, default: 0 },
    lastAttemptAt: { type: Date },
    sentAt: { type: Date },
    providerMessageId: { type: String },
    error: { type: String },
    blockedByRule: { type: String },
    createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, {
    timestamps: true,
});

// Worker: oldest eligible pending message.
whatsappMessageSchema.index({ status: 1, scheduledAt: 1, createdAt: 1 });
// Hourly / daily counters.
whatsappMessageSchema.index({ status: 1, sentAt: 1 });
// Per-recipient daily cap and duplicate guard.
whatsappMessageSchema.index({ recipientPhone: 1, status: 1, sentAt: 1 });
whatsappMessageSchema.index({ recipientPhone: 1, dedupeKey: 1, status: 1 });
// Queue list (newest first).
whatsappMessageSchema.index({ createdAt: -1 });

module.exports = require('../lib/tenantModel')('WhatsappMessage', whatsappMessageSchema);
module.exports.WHATSAPP_MESSAGE_STATUSES = WHATSAPP_MESSAGE_STATUSES;
module.exports.WHATSAPP_MESSAGE_SOURCES = WHATSAPP_MESSAGE_SOURCES;
