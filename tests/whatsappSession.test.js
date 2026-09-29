/**
 * WhatsApp session: which disconnects keep the pairing, re-sending messages a phone asks
 * for again, and one socket per tenant. Baileys is replaced by a fake socket (no network,
 * no DB); only its real DisconnectReason codes and proto encoder are used.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('@whiskeysockets/baileys', () => {
    const actual = jest.requireActual('@whiskeysockets/baileys');
    const { EventEmitter } = require('events');
    const sockets = [];
    const makeWASocket = jest.fn((config) => {
        const sock = {
            config,
            ev: new EventEmitter(),
            user: { id: '447700900000:1@s.whatsapp.net' },
            onWhatsApp: jest.fn(),
            sendMessage: jest.fn(),
            logout: jest.fn(),
        };
        sockets.push(sock);
        return sock;
    });
    return {
        default: makeWASocket,
        useMultiFileAuthState: jest.fn(async () => ({
            state: { creds: { me: { id: '447700900000:1@s.whatsapp.net' } }, keys: {} },
            saveCreds: jest.fn(async () => {}),
        })),
        fetchLatestBaileysVersion: jest.fn(async () => ({ version: [2, 3000, 1] })),
        DisconnectReason: actual.DisconnectReason,
        Browsers: actual.Browsers,
        proto: actual.proto,
        __sockets: sockets,
    };
});
// Run tenant work inline so the model mocks below are hit (no tenant DB connection).
jest.mock('../src/lib/runInTenant', () => jest.fn((tenantId, fn) => fn()));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-session-test-'));
jest.spyOn(process, 'cwd').mockReturnValue(tmpRoot);

const baileys = require('@whiskeysockets/baileys');
const WhatsappMessage = require('../src/models/WhatsappMessage');
const session = require('../src/services/whatsappSessionService');

const { DisconnectReason, proto } = baileys;
const sockets = baileys.__sockets;

let tenantSeq = 0;
function sessionDirFor(tenant) {
    return path.join(tmpRoot, 'data', 'whatsapp-sessions', tenant);
}
// A tenant with a completed pairing on disk.
function pairedTenant() {
    const tenant = `t${++tenantSeq}`;
    fs.mkdirSync(sessionDirFor(tenant), { recursive: true });
    fs.writeFileSync(
        path.join(sessionDirFor(tenant), 'creds.json'),
        JSON.stringify({ me: { id: '447700900000:1@s.whatsapp.net' } })
    );
    return tenant;
}
const lastSocket = () => sockets[sockets.length - 1];
const open = (sock) => sock.ev.emit('connection.update', { connection: 'open' });
const close = (sock, statusCode, message = 'closed') =>
    sock.ev.emit('connection.update', {
        connection: 'close',
        lastDisconnect: { error: Object.assign(new Error(message), { output: { statusCode } }) },
    });

let warnSpy;
beforeEach(() => {
    jest.useFakeTimers();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    warnSpy.mockRestore();
    delete WhatsappMessage.findOne;
});
afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('disconnects', () => {
    it.each([
        ['badSession / unknown stream error', DisconnectReason.badSession],
        ['connection lost', DisconnectReason.connectionLost],
        ['connection closed', DisconnectReason.connectionClosed],
        ['restart required', DisconnectReason.restartRequired],
    ])('%s keeps the pairing and reconnects', async (_label, code) => {
        const tenant = pairedTenant();
        await session.startSession(tenant);
        const first = lastSocket();
        open(first);

        close(first, code);
        expect(fs.existsSync(path.join(sessionDirFor(tenant), 'creds.json'))).toBe(true);
        expect(session.getStatus(tenant).status).toBe('connecting');

        await jest.advanceTimersByTimeAsync(60 * 1000);
        expect(lastSocket()).not.toBe(first);
        open(lastSocket());
        expect(session.getStatus(tenant).status).toBe('connected');
    });

    it('logged out on the phone (401) wipes the pairing and stays disconnected', async () => {
        const tenant = pairedTenant();
        await session.startSession(tenant);
        const sock = lastSocket();
        open(sock);

        close(sock, DisconnectReason.loggedOut);
        expect(fs.existsSync(sessionDirFor(tenant))).toBe(false);
        expect(session.getStatus(tenant).status).toBe('disconnected');

        const socketsBefore = sockets.length;
        await jest.advanceTimersByTimeAsync(5 * 60 * 1000);
        expect(sockets.length).toBe(socketsBefore);
    });

    it('connection replaced (440) keeps the pairing and takes the connection back after a pause', async () => {
        const tenant = pairedTenant();
        await session.startSession(tenant);
        const first = lastSocket();
        open(first);

        close(first, DisconnectReason.connectionReplaced);
        expect(fs.existsSync(path.join(sessionDirFor(tenant), 'creds.json'))).toBe(true);

        await jest.advanceTimersByTimeAsync(30 * 1000);
        expect(lastSocket()).toBe(first); // not straight away — another process may still hold it
        await jest.advanceTimersByTimeAsync(30 * 1000);
        expect(lastSocket()).not.toBe(first);
    });

    it('stops after repeated takeovers, keeps the pairing and explains why', async () => {
        const tenant = pairedTenant();
        await session.startSession(tenant);
        for (let i = 0; i < 6; i++) {
            const sock = lastSocket();
            open(sock);
            close(sock, DisconnectReason.connectionReplaced);
            await jest.advanceTimersByTimeAsync(60 * 1000);
        }
        const status = session.getStatus(tenant);
        expect(status.status).toBe('disconnected');
        expect(status.lastError).toMatch(/another connection/);
        expect(fs.existsSync(path.join(sessionDirFor(tenant), 'creds.json'))).toBe(true);

        // "Generate QR code" reconnects with the saved pairing.
        const socketsBefore = sockets.length;
        await session.startSession(tenant);
        expect(sockets.length).toBe(socketsBefore + 1);
    });

    it('a close on a superseded socket leaves the current session alone', async () => {
        const tenant = pairedTenant();
        await session.startSession(tenant);
        const old = lastSocket();
        open(old);
        close(old, DisconnectReason.badSession);
        await jest.advanceTimersByTimeAsync(60 * 1000);
        const current = lastSocket();
        open(current);

        close(old, DisconnectReason.loggedOut);
        expect(fs.existsSync(path.join(sessionDirFor(tenant), 'creds.json'))).toBe(true);
        expect(session.getStatus(tenant).status).toBe('connected');
    });
});

describe('startSession', () => {
    it('concurrent starts share one socket', async () => {
        const tenant = pairedTenant();
        const before = sockets.length;
        const [a, b] = await Promise.all([session.startSession(tenant), session.startSession(tenant)]);
        expect(a).toBe(b);
        expect(sockets.length).toBe(before + 1);
    });

    it('a failing credentials save does not reject unhandled', async () => {
        const tenant = pairedTenant();
        const saveCreds = jest.fn(async () => { throw new Error('ENOENT'); });
        baileys.useMultiFileAuthState.mockResolvedValueOnce({
            state: { creds: { me: { id: '447700900000:1@s.whatsapp.net' } }, keys: {} },
            saveCreds,
        });
        const unhandled = jest.fn();
        process.on('unhandledRejection', unhandled);
        try {
            await session.startSession(tenant);
            lastSocket().ev.emit('creds.update', {});
            await Promise.resolve();
            await Promise.resolve();
            expect(saveCreds).toHaveBeenCalled();
            expect(unhandled).not.toHaveBeenCalled();
        } finally {
            process.off('unhandledRejection', unhandled);
        }
    });
});

describe('re-sending a message a phone asks for again', () => {
    const documentMessage = () => proto.Message.fromObject({
        documentMessage: {
            url: 'https://mmg.whatsapp.net/d/f/abc.enc',
            mimetype: 'application/pdf',
            fileName: 'Business-Invoice-INV-000128.pdf',
            caption: 'Invoice INV-000128 for Manzar. Total: £110.00.',
            mediaKey: Buffer.alloc(32, 7),
            fileLength: 300000,
        },
    });

    async function connectedTenant() {
        const tenant = pairedTenant();
        await session.startSession(tenant);
        const sock = lastSocket();
        open(sock);
        sock.onWhatsApp.mockResolvedValue([{ exists: true, jid: '447700900001@s.whatsapp.net' }]);
        return { tenant, sock };
    }

    it('returns the encoded message with the send and serves it to getMessage', async () => {
        const { tenant, sock } = await connectedTenant();
        const message = documentMessage();
        sock.sendMessage.mockResolvedValue({ key: { id: '3EB0AAA111' }, message });

        const out = await session.sendQueuedMessage(tenant, {
            phone: '447700900001',
            text: 'Invoice',
            attachment: { data: Buffer.from('%PDF-1.4'), mimetype: 'application/pdf', filename: 'inv.pdf' },
        });
        expect(out.providerMessageId).toBe('3EB0AAA111');
        expect(proto.Message.decode(out.providerMessage).documentMessage.fileName).toBe('Business-Invoice-INV-000128.pdf');

        const again = await sock.config.getMessage({ remoteJid: '447700900001@s.whatsapp.net', id: '3EB0AAA111', fromMe: true });
        expect(again.documentMessage.caption).toBe(message.documentMessage.caption);
    });

    it('after a restart, loads the stored message from the queue', async () => {
        const { sock } = await connectedTenant();
        const stored = Buffer.from(proto.Message.encode(documentMessage()).finish());
        const select = jest.fn().mockResolvedValue({ providerMessage: stored });
        // Models are Proxies that hand out bound functions — keep the mock's own reference.
        const findOne = jest.fn(() => ({ select }));
        WhatsappMessage.findOne = findOne;

        const again = await sock.config.getMessage({ id: '3EB0NOTINMEMORY' });
        expect(findOne).toHaveBeenCalledWith({ providerMessageId: '3EB0NOTINMEMORY' });
        expect(select).toHaveBeenCalledWith('+providerMessage');
        expect(again.documentMessage.mediaKey).toEqual(Buffer.alloc(32, 7));
    });

    it('returns nothing for a message it never sent', async () => {
        const { sock } = await connectedTenant();
        WhatsappMessage.findOne = jest.fn(() => ({ select: jest.fn().mockResolvedValue(null) }));
        await expect(sock.config.getMessage({ id: 'UNKNOWN' })).resolves.toBeUndefined();
    });

    it('keeps retry counts across reconnects', async () => {
        const tenant = pairedTenant();
        await session.startSession(tenant);
        const first = lastSocket();
        open(first);
        first.config.msgRetryCounterCache.set('3EB0:447700900001@s.whatsapp.net', 3);
        close(first, DisconnectReason.connectionLost);
        await jest.advanceTimersByTimeAsync(60 * 1000);
        expect(lastSocket()).not.toBe(first);
        expect(lastSocket().config.msgRetryCounterCache.get('3EB0:447700900001@s.whatsapp.net')).toBe(3);
    });
});
