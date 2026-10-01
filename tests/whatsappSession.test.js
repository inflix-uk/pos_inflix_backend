/**
 * WhatsApp session: which disconnects keep the pairing, re-sending messages a phone asks
 * for again, one socket per tenant, restoring pairings at boot and stopping cleanly for a
 * deploy. Baileys is replaced by a fake socket and the DB-backed pairing store by an
 * in-memory one (no network, no DB).
 */

jest.mock('../src/lib/loadBaileys', () => {
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
            end: jest.fn(),
        };
        sockets.push(sock);
        return sock;
    });
    // Stand-in for Baileys' protobuf encoder: JSON with Buffers revived — enough to check a round trip.
    const reviveBuffers = (k, v) => (v && v.type === 'Buffer' && Array.isArray(v.data) ? Buffer.from(v.data) : v);
    const fake = {
        default: makeWASocket,
        fetchLatestBaileysVersion: jest.fn(async () => ({ version: [2, 3000, 1] })),
        makeCacheableSignalKeyStore: jest.fn((keys) => keys),
        Browsers: { macOS: (name) => ['Mac OS', name, '14.4.1'] },
        // Baileys' own close codes (DisconnectReason).
        DisconnectReason: {
            connectionClosed: 428, connectionLost: 408, connectionReplaced: 440, loggedOut: 401,
            badSession: 500, restartRequired: 515, multideviceMismatch: 411,
        },
        proto: {
            Message: {
                fromObject: (o) => o,
                encode: (m) => ({ finish: () => Buffer.from(JSON.stringify(m)) }),
                decode: (buf) => JSON.parse(Buffer.from(buf).toString('utf8'), reviveBuffers),
            },
        },
        __sockets: sockets,
    };
    const load = jest.fn(async () => fake);
    load.fake = fake;
    return load;
});
// Pairings live in memory instead of the tenant DB: tenant -> creds.
jest.mock('../src/services/whatsappAuthStore', () => {
    const saved = new Map();
    return {
        __saved: saved,
        hasPairedCreds: jest.fn(async (tenant) => !!(saved.get(tenant)?.me?.id)),
        clearAuth: jest.fn(async (tenant) => { saved.delete(tenant); }),
        useMongoAuthState: jest.fn(async (tenant) => {
            const creds = saved.get(tenant) || {};
            return { state: { creds, keys: {} }, saveCreds: jest.fn(async () => { saved.set(tenant, creds); }) };
        }),
    };
});
// Run tenant work inline so the model mocks below are hit (no tenant DB connection).
jest.mock('../src/lib/runInTenant', () => jest.fn((tenantId, fn) => fn()));

const loadBaileys = require('../src/lib/loadBaileys');
const authStore = require('../src/services/whatsappAuthStore');
const WhatsappMessage = require('../src/models/WhatsappMessage');
const Tenant = require('../src/models/Tenant');
const session = require('../src/services/whatsappSessionService');

const { DisconnectReason, proto } = loadBaileys.fake;
const sockets = loadBaileys.fake.__sockets;
const saved = authStore.__saved;

let tenantSeq = 0;
// A tenant with a completed pairing saved.
function pairedTenant() {
    const tenant = `t${++tenantSeq}`;
    saved.set(tenant, { me: { id: '447700900000:1@s.whatsapp.net' } });
    return tenant;
}
const lastSocket = () => sockets[sockets.length - 1];
const open = (sock) => sock.ev.emit('connection.update', { connection: 'open' });
const close = (sock, statusCode, message = 'closed') =>
    sock.ev.emit('connection.update', {
        connection: 'close',
        lastDisconnect: { error: Object.assign(new Error(message), { output: { statusCode } }) },
    });
// saveCreds of the pairing store handed to the newest socket.
const lastSaveCreds = async () => (await authStore.useMongoAuthState.mock.results.at(-1).value).saveCreds;

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
    delete Tenant.find;
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
        expect(saved.has(tenant)).toBe(true);
        expect(session.getStatus(tenant).status).toBe('connecting');

        await jest.advanceTimersByTimeAsync(60 * 1000);
        expect(lastSocket()).not.toBe(first);
        open(lastSocket());
        expect(session.getStatus(tenant).status).toBe('connected');
    });

    it('logged out on the phone (401) clears the pairing and stays disconnected', async () => {
        const tenant = pairedTenant();
        await session.startSession(tenant);
        const sock = lastSocket();
        open(sock);

        close(sock, DisconnectReason.loggedOut);
        await jest.advanceTimersByTimeAsync(0);
        expect(authStore.clearAuth).toHaveBeenCalledWith(tenant);
        expect(saved.has(tenant)).toBe(false);
        expect(session.getStatus(tenant).status).toBe('disconnected');

        const socketsBefore = sockets.length;
        await jest.advanceTimersByTimeAsync(5 * 60 * 1000);
        expect(sockets.length).toBe(socketsBefore);
    });

    it('a late credentials update after the pairing was cleared is not saved back', async () => {
        const tenant = pairedTenant();
        await session.startSession(tenant);
        const sock = lastSocket();
        const saveCreds = await lastSaveCreds();
        open(sock);

        close(sock, DisconnectReason.loggedOut);
        sock.ev.emit('creds.update', {});
        await jest.advanceTimersByTimeAsync(0);
        expect(saveCreds).not.toHaveBeenCalled();
        expect(saved.has(tenant)).toBe(false);
    });

    it('connection replaced (440) keeps the pairing and takes the connection back after a pause', async () => {
        const tenant = pairedTenant();
        await session.startSession(tenant);
        const first = lastSocket();
        open(first);

        close(first, DisconnectReason.connectionReplaced);
        expect(saved.has(tenant)).toBe(true);

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
        expect(saved.has(tenant)).toBe(true);

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
        await jest.advanceTimersByTimeAsync(0);
        expect(saved.has(tenant)).toBe(true);
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

    it('a fresh start clears a saved pair that never completed', async () => {
        const tenant = `t${++tenantSeq}`;
        saved.set(tenant, { noiseKey: {} }); // creds without `me`: the QR was never scanned
        await session.startSession(tenant);
        expect(authStore.clearAuth).toHaveBeenCalledWith(tenant);
        expect(saved.has(tenant)).toBe(false);
    });

    it('a failing credentials save does not reject unhandled', async () => {
        const tenant = pairedTenant();
        const saveCreds = jest.fn(async () => { throw new Error('Mongo write failed'); });
        authStore.useMongoAuthState.mockResolvedValueOnce({
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

    it('wraps the saved keys in the memory cache', async () => {
        const tenant = pairedTenant();
        await session.startSession(tenant);
        expect(loadBaileys.fake.makeCacheableSignalKeyStore).toHaveBeenCalled();
        expect(lastSocket().config.auth.creds).toEqual(saved.get(tenant));
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

describe('restoreSessions (boot)', () => {
    it('reconnects only the tenants with a completed pairing saved', async () => {
        const paired = pairedTenant();
        const neverPaired = `t${++tenantSeq}`;
        Tenant.find = jest.fn(() => ({ select: () => ({ lean: async () => [{ tenantId: paired }, { tenantId: neverPaired }] }) }));
        const before = sockets.length;

        const restored = await session.restoreSessions();
        expect(restored).toEqual([paired]);
        expect(sockets.length).toBe(before + 1);
    });

    it('a failing tenant lookup does not throw', async () => {
        Tenant.find = jest.fn(() => ({ select: () => ({ lean: async () => { throw new Error('db down'); } }) }));
        await expect(session.restoreSessions()).resolves.toEqual([]);
    });
});

// Last: shutting down is one-way for the module.
describe('shutdownSessions (deploy)', () => {
    it('closes sockets without logging out, keeps the pairing and never reconnects', async () => {
        const tenant = pairedTenant();
        await session.startSession(tenant);
        const sock = lastSocket();
        open(sock);
        authStore.clearAuth.mockClear();

        session.shutdownSessions();
        expect(sock.end).toHaveBeenCalled();
        expect(sock.logout).not.toHaveBeenCalled();

        const before = sockets.length;
        close(sock, DisconnectReason.connectionClosed);
        await jest.advanceTimersByTimeAsync(5 * 60 * 1000);
        expect(sockets.length).toBe(before);
        expect(authStore.clearAuth).not.toHaveBeenCalled();
        expect(saved.has(tenant)).toBe(true);
        await expect(session.startSession(tenant)).rejects.toMatchObject({ code: 'WA_SHUTTING_DOWN' });
    });
});
