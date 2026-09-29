/**
 * WhatsApp session manager — lightweight wrapper around Baileys for pairing
 * a tenant's WhatsApp account via QR. One in-process session per tenant; auth
 * is persisted on disk so the session survives restarts.
 */
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const runInTenant = require('../lib/runInTenant');
const WhatsappMessage = require('../models/WhatsappMessage');

let baileysModule = null;
function loadBaileys() {
    if (baileysModule) return baileysModule;
    try {
        baileysModule = require('@whiskeysockets/baileys');
    } catch (e) {
        const err = new Error(
            'WhatsApp gateway dependency not installed. Run `npm install @whiskeysockets/baileys` in pos_inflix_backend.'
        );
        err.code = 'WA_DEP_MISSING';
        throw err;
    }
    return baileysModule;
}

const SESSIONS_ROOT = path.resolve(process.cwd(), 'data', 'whatsapp-sessions');
function sessionDir(tenantId) {
    return path.join(SESSIONS_ROOT, String(tenantId || 'default'));
}

function wipeAuthDir(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// Baileys logs in with saved creds when `creds.me` is set and otherwise starts a new
// QR registration. (`creds.registered` is only set by the pairing-code flow and stays
// false for QR pairing, so it can't be used to detect a completed pair.)
function readPairedCreds(dir) {
    try {
        const creds = JSON.parse(fs.readFileSync(path.join(dir, 'creds.json'), 'utf8'));
        return creds && creds.me && creds.me.id ? creds : null;
    } catch {
        return null;
    }
}

// If creds.json exists but the previous pair never completed, the saved state is
// unusable. Wipe so the next start is a clean pair.
function clearStaleAuthIfUnpaired(dir) {
    if (!fs.existsSync(path.join(dir, 'creds.json'))) return;
    if (!readPairedCreds(dir)) wipeAuthDir(dir);
}

const sessions = new Map(); // tenantId -> { sock, status, qrDataUrl, qrRaw, jid, startedAt, openedAt, lastError, retries, replacedCount }
// tenantId -> promise of the session being created, so concurrent starts share one socket
// (two sockets on the same auth make WhatsApp drop one with "connection replaced").
const starting = new Map();

// Baileys' pino-style logger: surface errors (stream errors, decrypt / re-send failures)
// as one line each; everything below error level is dropped.
function makeLogger(tenantKey) {
    const log = (obj, msg) => {
        const text = typeof obj === 'string' ? obj : (msg || '');
        const err = obj && typeof obj === 'object' ? (obj instanceof Error ? obj : obj.err || obj.error) : null;
        console.warn(`[whatsapp] tenant=${tenantKey} ${text}${err && err.message ? ` (${err.message})` : ''}`);
    };
    const logger = {
        level: 'error',
        fatal: log, error: log, warn() {}, info() {}, debug() {}, trace() {},
        child() { return logger; },
    };
    return logger;
}

// Small TTL cache with Baileys' CacheStore interface (get / set / del / flushAll).
function createTtlCache(ttlMs, maxEntries) {
    const store = new Map();
    return {
        get(k) {
            const entry = store.get(k);
            if (!entry) return undefined;
            if (entry.expiresAt < Date.now()) {
                store.delete(k);
                return undefined;
            }
            return entry.value;
        },
        set(k, value) {
            store.delete(k);
            store.set(k, { value, expiresAt: Date.now() + ttlMs });
            if (store.size > maxEntries) store.delete(store.keys().next().value);
        },
        del(k) { store.delete(k); },
        flushAll() { store.clear(); },
    };
}

// Per-tenant retry counters, kept outside the socket so they survive reconnects and a
// message can't be re-requested / re-sent forever (Baileys caps each at maxMsgRetryCount).
const retryCounters = new Map();
function retryCounterCache(tenantKey) {
    if (!retryCounters.has(tenantKey)) retryCounters.set(tenantKey, createTtlCache(60 * 60 * 1000, 5000));
    return retryCounters.get(tenantKey);
}

// Messages sent by this process, by `<tenant>:<WhatsApp message id>`. When a phone can't
// decrypt a message (shown as "Waiting for this message") it asks for it again and Baileys
// re-sends whatever getMessage returns; the DB copy covers restarts.
const recentSent = createTtlCache(24 * 60 * 60 * 1000, 1000);

async function getSentMessage(tenantKey, id) {
    if (!id) return undefined;
    const cached = recentSent.get(`${tenantKey}:${id}`);
    if (cached) return cached;
    try {
        const doc = await runInTenant(tenantKey, () =>
            WhatsappMessage.findOne({ providerMessageId: id }).select('+providerMessage')
        );
        if (!doc || !doc.providerMessage || !doc.providerMessage.length) return undefined;
        return loadBaileys().proto.Message.decode(doc.providerMessage);
    } catch (e) {
        console.warn(`[whatsapp] tenant=${tenantKey} could not load message ${id} to send again: ${e.message}`);
        return undefined;
    }
}

// Only these mean the saved pairing can never log in again: the device was removed on the
// phone / logged out (401), or the account can't use linked devices (411). Every other close,
// including 500 (Baileys' code for any unrecognised stream or socket error), is a dropped
// connection and must reconnect with the saved pairing.
const TERMINAL_CLOSE_CODES = [401, 411];
// 440: this pairing connected from somewhere else (e.g. the old and new server overlapping
// during a deploy). WhatsApp keeps the newest connection; wait before taking it back so two
// processes don't fight over it, and stop after repeated takeovers.
const REPLACED_RETRY_DELAY_MS = 60 * 1000;
const MAX_REPLACED_RETRIES = 5;
// A connection that stayed open this long wasn't part of a takeover loop.
const STABLE_CONNECTION_MS = 10 * 60 * 1000;

function startSession(tenantId) {
    const key = String(tenantId || 'default');
    const existing = sessions.get(key);
    if (existing && (existing.status === 'connecting' || existing.status === 'qr' || existing.status === 'connected')) {
        return Promise.resolve(existing);
    }
    if (starting.has(key)) return starting.get(key);
    const pending = createSession(key, existing).finally(() => starting.delete(key));
    starting.set(key, pending);
    return pending;
}

async function createSession(key, existing) {
    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = loadBaileys();

    const dir = sessionDir(key);
    fs.mkdirSync(dir, { recursive: true });
    // Only wipe stale auth on a fresh start (no `existing` carry-over) — never during
    // an internal retry, which may be finishing a pair that's still in progress.
    if (!existing) clearStaleAuthIfUnpaired(dir);
    const { state, saveCreds } = await useMultiFileAuthState(dir);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

    const sock = makeWASocket({
        auth: state,
        version,
        logger: makeLogger(key),
        printQRInTerminal: false,
        // Browsers.macOS('Desktop') sends a WA-recognised client string; custom arrays
        // sometimes get rejected by the pair-device flow ("Couldn't link device").
        browser: Browsers?.macOS ? Browsers.macOS('Desktop') : ['Mac OS', 'Desktop', '10.15.7'],
        markOnlineOnConnect: false,
        syncFullHistory: false,
        getMessage: (msgKey) => getSentMessage(key, msgKey && msgKey.id),
        msgRetryCounterCache: retryCounterCache(key),
    });

    const session = {
        sock,
        status: 'connecting',
        qrDataUrl: null,
        qrRaw: null,
        jid: null,
        startedAt: Date.now(),
        openedAt: null,
        lastError: null,
        retries: existing?.retries || 0,
        replacedCount: existing?.replacedCount || 0,
    };
    sessions.set(key, session);

    // Saving can fail if the auth folder was removed under a closing socket (logout);
    // an unhandled rejection here would take the whole API down.
    sock.ev.on('creds.update', () => {
        saveCreds().catch((e) => console.warn(`[whatsapp] tenant=${key} could not save credentials: ${e.message}`));
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            try {
                session.qrRaw = qr;
                session.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, scale: 6 });
                session.status = 'qr';
            } catch (e) {
                session.lastError = e.message;
            }
        }
        if (connection === 'open') {
            session.status = 'connected';
            session.qrDataUrl = null;
            session.qrRaw = null;
            session.jid = sock.user?.id || null;
            session.retries = 0;
            session.openedAt = Date.now();
        }
        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            session.qrDataUrl = null;
            session.qrRaw = null;
            session.lastError = lastDisconnect?.error?.message || null;
            const current = sessions.get(key) === session;
            console.warn(
                `[whatsapp] tenant=${key} connection closed (code ${code ?? 'none'}: ${session.lastError || 'no reason given'})`
                + (current ? '' : ' — superseded socket, ignoring')
            );

            if (TERMINAL_CLOSE_CODES.includes(code)) {
                session.status = 'disconnected';
                // A superseded socket (e.g. closing after a manual logout) must not
                // delete or wipe a newer session the user has already started.
                if (current) {
                    sessions.delete(key);
                    wipeAuthDir(dir);
                }
                return;
            }

            if (code === DisconnectReason.connectionReplaced) {
                session.status = 'disconnected';
                // The pairing is still valid (another connection is using it) — never wipe it.
                if (!current) return;
                const stable = session.openedAt && Date.now() - session.openedAt >= STABLE_CONNECTION_MS;
                const replacedCount = (stable ? 0 : session.replacedCount || 0) + 1;
                if (replacedCount > MAX_REPLACED_RETRIES) {
                    // Left in place as 'disconnected' so the settings page shows why.
                    session.lastError = 'WhatsApp was opened from another connection using this pairing. '
                        + 'Press "Generate QR code" to reconnect here — the saved pairing is reused, no new scan needed.';
                    return;
                }
                const carryRetries = session.retries || 0;
                setTimeout(() => {
                    if (sessions.get(key) !== session) return;
                    sessions.set(key, { retries: carryRetries, replacedCount, status: 'restarting' });
                    startSession(key).catch(() => {});
                }, REPLACED_RETRY_DELAY_MS);
                session.status = 'connecting';
                return;
            }

            // Transient drops or restartRequired: retry. An unfinished pair is capped so it
            // can't loop forever (then wiped for a fresh QR). A paired session keeps retrying
            // with backoff — a network blip must not unlink the account or strand the queue.
            const paired = !!(state.creds && state.creds.me && state.creds.me.id);
            session.retries = (session.retries || 0) + 1;
            const MAX_RETRIES = 5;
            if (!paired && session.retries > MAX_RETRIES) {
                session.status = 'disconnected';
                session.lastError = 'WhatsApp pairing failed repeatedly — try again to generate a fresh QR.';
                sessions.delete(key);
                wipeAuthDir(dir);
                return;
            }
            session.status = 'connecting';
            const carryRetries = session.retries;
            const retryDelayMs = paired && code !== DisconnectReason.restartRequired
                ? Math.min(5000 * 2 ** Math.min(carryRetries - 1, 4), 60000)
                : 1500;
            setTimeout(() => {
                // Logged out (or replaced) while waiting — don't resurrect the session.
                if (sessions.get(key) !== session) return;
                // Carry the retry count forward via a shadow entry so the next
                // startSession picks it up via `existing?.retries`.
                sessions.set(key, { retries: carryRetries, replacedCount: session.replacedCount, status: 'restarting' });
                startSession(key).catch(() => {});
            }, retryDelayMs);
        }
    });

    return session;
}

function getStatus(tenantId) {
    const key = String(tenantId || 'default');
    const s = sessions.get(key);
    if (!s) return { status: 'disconnected', qrDataUrl: null, jid: null };
    // 'restarting' is an internal carry-over state during retries — surface it as 'connecting' to the UI.
    const status = s.status === 'restarting' ? 'connecting' : s.status;
    return {
        status,
        qrDataUrl: s.qrDataUrl || null,
        jid: s.jid || null,
        lastError: s.lastError || null,
    };
}

async function logoutSession(tenantId) {
    const key = String(tenantId || 'default');
    const s = sessions.get(key);
    if (s?.sock) {
        try { await s.sock.logout(); } catch {}
    }
    sessions.delete(key);
    try { fs.rmSync(sessionDir(key), { recursive: true, force: true }); } catch {}
    return { status: 'disconnected' };
}

function isConnected(tenantId) {
    const s = sessions.get(String(tenantId || 'default'));
    return !!(s && s.status === 'connected' && s.sock);
}

function listConnectedTenants() {
    const keys = [];
    for (const [key, s] of sessions) {
        if (s.status === 'connected' && s.sock) keys.push(key);
    }
    return keys;
}

function codedError(message, code) {
    const err = new Error(message);
    err.code = code;
    return err;
}

/**
 * Deliver one queued message. Only services/whatsappQueueWorker.js should call this —
 * everything else must enqueue so the safety limits apply.
 * Throws with code WA_NOT_CONNECTED, WA_NOT_ON_WHATSAPP or WA_SEND_FAILED.
 */
async function sendQueuedMessage(tenantId, { phone, text, attachment }) {
    const s = sessions.get(String(tenantId || 'default'));
    if (!s || s.status !== 'connected' || !s.sock) {
        throw codedError('WhatsApp not connected. Scan the QR first.', 'WA_NOT_CONNECTED');
    }
    const digits = String(phone).replace(/\D/g, '');
    let jid = `${digits}@s.whatsapp.net`;

    // onWhatsApp only returns numbers that are registered, so an empty list means
    // "not on WhatsApp". If the lookup itself fails, send to the plain JID.
    let lookup;
    try {
        lookup = await s.sock.onWhatsApp(jid);
    } catch {
        lookup = undefined;
    }
    if (Array.isArray(lookup)) {
        const match = lookup.find((r) => r && r.exists);
        if (!match) throw codedError(`+${digits} is not registered on WhatsApp.`, 'WA_NOT_ON_WHATSAPP');
        if (match.jid) jid = match.jid;
    }

    const content = attachment
        ? {
            document: Buffer.from(attachment.data),
            mimetype: attachment.mimetype || 'application/octet-stream',
            fileName: attachment.filename || 'document',
            ...(text ? { caption: text } : {}),
        }
        : { text };

    let sent;
    try {
        sent = await s.sock.sendMessage(jid, content);
    } catch (e) {
        throw codedError(e.message || 'WhatsApp send failed', 'WA_SEND_FAILED');
    }
    const providerMessageId = (sent && sent.key && sent.key.id) || null;
    // Keep what was sent so it can be re-sent if a phone asks for it again (see getSentMessage).
    let providerMessage = null;
    if (providerMessageId && sent.message) {
        const key = String(tenantId || 'default');
        recentSent.set(`${key}:${providerMessageId}`, sent.message);
        try {
            providerMessage = Buffer.from(loadBaileys().proto.Message.encode(sent.message).finish());
        } catch (e) {
            console.warn(`[whatsapp] tenant=${key} could not store sent message ${providerMessageId}: ${e.message}`);
        }
    }
    return { jid, providerMessageId, providerMessage };
}

/** Reconnect every tenant that has a completed pairing on disk (called once at boot). */
async function restoreSessions() {
    let entries;
    try {
        entries = fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true });
    } catch {
        return [];
    }
    const restored = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || !readPairedCreds(path.join(SESSIONS_ROOT, entry.name))) continue;
        try {
            await startSession(entry.name);
            restored.push(entry.name);
        } catch (e) {
            console.warn(`[whatsapp] could not restore session for tenant ${entry.name}: ${e.message}`);
        }
    }
    return restored;
}

module.exports = {
    startSession,
    getStatus,
    logoutSession,
    isConnected,
    listConnectedTenants,
    sendQueuedMessage,
    restoreSessions,
};
