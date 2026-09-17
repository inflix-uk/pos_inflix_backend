/**
 * WhatsApp session manager — lightweight wrapper around Baileys for pairing
 * a tenant's WhatsApp account via QR. One in-process session per tenant; auth
 * is persisted on disk so the session survives restarts.
 */
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');

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

const sessions = new Map(); // tenantId -> { sock, status, qrDataUrl, qrRaw, jid, startedAt, lastError, retries }

async function startSession(tenantId) {
    const key = String(tenantId || 'default');
    const existing = sessions.get(key);
    if (existing && (existing.status === 'connecting' || existing.status === 'qr' || existing.status === 'connected')) {
        return existing;
    }

    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = loadBaileys();

    const dir = sessionDir(key);
    fs.mkdirSync(dir, { recursive: true });
    // Only wipe stale auth on a fresh start (no `existing` carry-over) — never during
    // an internal retry, which may be finishing a pair that's still in progress.
    if (!existing) clearStaleAuthIfUnpaired(dir);
    const { state, saveCreds } = await useMultiFileAuthState(dir);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

    // No-op logger satisfies Baileys' pino interface without spamming app logs.
    const noopLogger = {
        level: 'silent',
        fatal() {}, error() {}, warn() {}, info() {}, debug() {}, trace() {},
        child() { return noopLogger; },
    };

    const sock = makeWASocket({
        auth: state,
        version,
        logger: noopLogger,
        printQRInTerminal: false,
        // Browsers.macOS('Desktop') sends a WA-recognised client string; custom arrays
        // sometimes get rejected by the pair-device flow ("Couldn't link device").
        browser: Browsers?.macOS ? Browsers.macOS('Desktop') : ['Mac OS', 'Desktop', '10.15.7'],
        markOnlineOnConnect: false,
        syncFullHistory: false,
    });

    const prevRetries = existing?.retries || 0;
    const session = {
        sock,
        status: 'connecting',
        qrDataUrl: null,
        qrRaw: null,
        jid: null,
        startedAt: Date.now(),
        lastError: null,
        retries: prevRetries,
    };
    sessions.set(key, session);

    sock.ev.on('creds.update', saveCreds);

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
        }
        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            // Codes that mean the persisted auth is unusable — wipe and force a fresh QR.
            const fatalCodes = new Set([
                DisconnectReason.loggedOut,
                DisconnectReason.badSession,
                DisconnectReason.multideviceMismatch,
                DisconnectReason.connectionReplaced,
            ]);
            const isFatal = fatalCodes.has(code);
            session.qrDataUrl = null;
            session.qrRaw = null;
            session.lastError = lastDisconnect?.error?.message || null;

            if (isFatal) {
                session.status = 'disconnected';
                // A superseded socket (e.g. closing after a manual logout) must not
                // delete or wipe a newer session the user has already started.
                if (sessions.get(key) === session) {
                    sessions.delete(key);
                    wipeAuthDir(dir);
                }
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
                sessions.set(key, { retries: carryRetries, status: 'restarting' });
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

    try {
        const sent = await s.sock.sendMessage(jid, content);
        return { jid, providerMessageId: (sent && sent.key && sent.key.id) || null };
    } catch (e) {
        throw codedError(e.message || 'WhatsApp send failed', 'WA_SEND_FAILED');
    }
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
