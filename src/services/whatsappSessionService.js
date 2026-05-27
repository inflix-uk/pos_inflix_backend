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

const sessions = new Map(); // tenantId -> { sock, status, qrDataUrl, qrRaw, jid, startedAt, lastError }

async function startSession(tenantId) {
    const key = String(tenantId || 'default');
    const existing = sessions.get(key);
    if (existing && (existing.status === 'connecting' || existing.status === 'qr' || existing.status === 'connected')) {
        return existing;
    }

    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = loadBaileys();

    const dir = sessionDir(key);
    fs.mkdirSync(dir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(dir);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

    const sock = makeWASocket({
        auth: state,
        version,
        printQRInTerminal: false,
        browser: ['POS Inflix', 'Chrome', '1.0'],
    });

    const session = {
        sock,
        status: 'connecting',
        qrDataUrl: null,
        qrRaw: null,
        jid: null,
        startedAt: Date.now(),
        lastError: null,
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
        }
        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            const loggedOut = code === DisconnectReason.loggedOut;
            session.status = loggedOut ? 'disconnected' : 'connecting';
            session.qrDataUrl = null;
            session.qrRaw = null;
            session.lastError = lastDisconnect?.error?.message || null;
            if (loggedOut) {
                sessions.delete(key);
                try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
            } else {
                // Auto-retry on transient drops
                setTimeout(() => {
                    sessions.delete(key);
                    startSession(key).catch(() => {});
                }, 1500);
            }
        }
    });

    return session;
}

function getStatus(tenantId) {
    const key = String(tenantId || 'default');
    const s = sessions.get(key);
    if (!s) return { status: 'disconnected', qrDataUrl: null, jid: null };
    return {
        status: s.status,
        qrDataUrl: s.qrDataUrl,
        jid: s.jid,
        lastError: s.lastError,
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
