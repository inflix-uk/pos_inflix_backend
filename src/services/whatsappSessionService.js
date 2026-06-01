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

// If creds.json exists but the previous pair never completed (`registered: false`),
// the saved state is unusable and Baileys will loop "attempting registration..." without
// ever emitting a QR. Wipe so the next start is a clean pair.
function clearStaleAuthIfUnregistered(dir) {
    const credsPath = path.join(dir, 'creds.json');
    if (!fs.existsSync(credsPath)) return;
    try {
        const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
        if (creds && creds.registered !== true) wipeAuthDir(dir);
    } catch {
        wipeAuthDir(dir);
    }
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
    // Only wipe stale auth on a fresh user-initiated start (no `existing` carry-over).
    // During an internal retry after `restartRequired`, the just-paired creds
    // legitimately have `registered: false` until the reconnect finalizes them —
    // wiping there would destroy the user's pairing mid-flow.
    if (!existing) clearStaleAuthIfUnregistered(dir);
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
                sessions.delete(key);
                wipeAuthDir(dir);
                return;
            }

            // Transient drops or restartRequired: retry, but cap attempts so a bad
            // session can't loop forever. After the cap, wipe and require user action.
            session.retries = (session.retries || 0) + 1;
            const MAX_RETRIES = 5;
            if (session.retries > MAX_RETRIES) {
                session.status = 'disconnected';
                session.lastError = 'WhatsApp pairing failed repeatedly — try again to generate a fresh QR.';
                sessions.delete(key);
                wipeAuthDir(dir);
                return;
            }
            session.status = 'connecting';
            const carryRetries = session.retries;
            setTimeout(() => {
                // Carry the retry count forward via a shadow entry so the next
                // startSession picks it up via `existing?.retries`.
                sessions.set(key, { retries: carryRetries, status: 'restarting' });
                startSession(key).catch(() => {});
            }, 1500);
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

async function sendMessage(tenantId, phoneE164, text) {
    const key = String(tenantId || 'default');
    const s = sessions.get(key);
    if (!s || s.status !== 'connected' || !s.sock) {
        const err = new Error('WhatsApp not connected. Scan the QR first.');
        err.code = 'WA_NOT_CONNECTED';
        throw err;
    }
    const jid = `${String(phoneE164).replace(/\D/g, '')}@s.whatsapp.net`;
    await s.sock.sendMessage(jid, { text });
    return { sentTo: jid };
}

module.exports = { startSession, getStatus, logoutSession, sendMessage };
