/**
 * WhatsApp queue worker. Every TICK_MS it visits each tenant with a connected
 * WhatsApp session and sends at most one queued message for that tenant, if:
 *   - the random delay since the previous send has elapsed,
 *   - the hourly limit (rolling 60 min) is not used up,
 *   - the daily limit (London calendar day) is not used up.
 * The per-recipient daily cap is re-checked before sending; a message over the
 * cap is marked `blocked` instead of being sent.
 *
 * Sessions live in this process (whatsappSessionService), so the worker runs
 * in-process too. Tenants are processed independently: a slow send for one
 * tenant never delays another.
 */
const mongoose = require('mongoose');
const config = require('../config');
const tenantContext = require('../lib/tenantContext');
const whatsappSession = require('./whatsappSessionService');
const queue = require('./whatsappQueueService');
const WhatsappSettings = require('../models/WhatsappSettings');

const TICK_MS = 15 * 1000;
const STALE_SENDING_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 2 * 60 * 1000;

let timer = null;
const busyTenants = new Set();

// Same DB resolution as middleware/tenantResolver, so the worker reads and writes
// exactly the database the tenant's own requests use.
function runInTenant(tenantId, fn) {
    const dbName = (config.tenantDbPrefix || 'tenant_') + tenantId;
    const tenantDb = mongoose.connection.useDb(dbName, { useCache: true });
    return tenantContext.run({ tenantDb, tenantId }, fn);
}

async function deliver(tenantId, message, settings) {
    const sentToday = await queue.countRecipientSentToday(message.recipientPhone);
    if (sentToday >= settings.dailyCapPerRecipient) {
        await queue.markBlocked(
            message._id,
            'recipientDailyCap',
            `Daily limit for this recipient reached (${settings.dailyCapPerRecipient} messages per day)`
        );
        return;
    }

    const hasAttachment = !!(message.attachment && message.attachment.filename);
    if (hasAttachment && !(message.attachment.data && message.attachment.data.length)) {
        await queue.markSendFailure(
            message,
            Object.assign(new Error('Attachment data is missing — queue the message again'), { code: 'WA_ATTACHMENT_MISSING' }),
            { maxAttempts: MAX_ATTEMPTS, retryBackoffMs: RETRY_BACKOFF_MS }
        );
        return;
    }

    let result;
    try {
        result = await whatsappSession.sendQueuedMessage(tenantId, {
            phone: message.recipientPhone,
            text: message.text,
            attachment: hasAttachment ? message.attachment : null,
        });
    } catch (err) {
        await queue.markSendFailure(message, err, { maxAttempts: MAX_ATTEMPTS, retryBackoffMs: RETRY_BACKOFF_MS });
        // The attempt reached WhatsApp — keep pacing so failures can't turn into rapid-fire retries.
        if (err.code === 'WA_SEND_FAILED') await queue.armNextDelay(settings);
        console.warn(`[whatsapp-queue] tenant=${tenantId} message=${message._id} not sent: ${err.message}`);
        return;
    }

    await queue.markSent(message._id, result.providerMessageId);
    const delaySeconds = await queue.armNextDelay(settings);
    console.log(`[whatsapp-queue] tenant=${tenantId} message=${message._id} sent; next send in ${delaySeconds}s`);
}

async function processTenant(tenantId) {
    if (busyTenants.has(tenantId)) return;
    busyTenants.add(tenantId);
    try {
        await runInTenant(tenantId, async () => {
            await queue.reclaimStaleSending(STALE_SENDING_MS, MAX_ATTEMPTS);
            if (!whatsappSession.isConnected(tenantId)) return;

            const settings = await WhatsappSettings.getSettings();
            const gate = await queue.checkSendGate(settings);
            if (!gate.ok) return;

            const message = await queue.claimNextPending();
            if (!message) return;
            await deliver(tenantId, message, settings);
        });
    } catch (err) {
        console.error(`[whatsapp-queue] tenant=${tenantId} tick failed: ${err.message}`);
    } finally {
        busyTenants.delete(tenantId);
    }
}

async function tick() {
    await Promise.allSettled(whatsappSession.listConnectedTenants().map(processTenant));
}

/** Process a tenant now instead of waiting for the next tick (e.g. right after enqueue). */
function kick(tenantId) {
    setImmediate(() => {
        processTenant(String(tenantId)).catch(() => {});
    });
}

function start() {
    if (timer) return;
    timer = setInterval(() => {
        tick().catch((err) => console.error(`[whatsapp-queue] tick failed: ${err.message}`));
    }, TICK_MS);
    if (timer.unref) timer.unref();
}

function stop() {
    if (timer) clearInterval(timer);
    timer = null;
}

module.exports = { start, stop, kick, tick, processTenant };
