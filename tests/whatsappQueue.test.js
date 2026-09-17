/**
 * WhatsApp queue: safety defaults, phone normalisation, settings validation,
 * pacing helpers and send-failure classification (no DB required).
 */

const { WHATSAPP_SAFETY_DEFAULTS, WHATSAPP_SAFETY_BOUNDS } = require('../src/config/whatsappSafety');
const WhatsappSettings = require('../src/models/WhatsappSettings');
const WhatsappMessage = require('../src/models/WhatsappMessage');
const queue = require('../src/services/whatsappQueueService');
const { getLondonDayStart } = require('../src/utils/dateKey');

describe('WhatsApp safety defaults', () => {
    it('matches the required technical configuration', () => {
        expect(WHATSAPP_SAFETY_DEFAULTS).toEqual({
            messageDelayMinSeconds: 240,
            messageDelayMaxSeconds: 420,
            hourlyLimit: 15,
            dailyLimit: 100,
            dailyCapPerRecipient: 5,
            duplicateWindowMinutes: 10,
        });
    });

    it('is what a new tenant settings document starts with', () => {
        const doc = new WhatsappSettings({});
        for (const [field, value] of Object.entries(WHATSAPP_SAFETY_DEFAULTS)) {
            expect(doc[field]).toBe(value);
        }
        expect(doc.nextSendEligibleAt.getTime()).toBe(0);
    });

    it('defaults sit inside the allowed bounds', () => {
        for (const [field, value] of Object.entries(WHATSAPP_SAFETY_DEFAULTS)) {
            expect(value).toBeGreaterThanOrEqual(WHATSAPP_SAFETY_BOUNDS[field].min);
            expect(value).toBeLessThanOrEqual(WHATSAPP_SAFETY_BOUNDS[field].max);
        }
    });

    it('queue messages start pending', () => {
        const doc = new WhatsappMessage({ recipientPhone: '447700900000', source: 'test', dedupeKey: 'k' });
        expect(doc.status).toBe('pending');
        expect(doc.attempts).toBe(0);
    });
});

describe('normalizePhone', () => {
    it.each([
        ['+44 7700 900000', '447700900000'],
        ['07700 900000', '447700900000'],
        ['0044 7700 900000', '447700900000'],
        ['447700900000', '447700900000'],
        ['+44 (0)7700 900000', '447700900000'],
        ['+1 (415) 555-2671', '14155552671'],
        ['+92 300 1234567', '923001234567'],
    ])('%s → %s', (input, expected) => {
        expect(queue.normalizePhone(input)).toBe(expected);
    });

    it.each([[''], [null], ['12345'], ['+0 7700 900000'], ['abc'], ['+44 7700 900000 1234567']])(
        'rejects %p',
        (input) => {
            expect(queue.normalizePhone(input)).toBe('');
        }
    );
});

describe('validateSettingsUpdate', () => {
    const current = { ...WHATSAPP_SAFETY_DEFAULTS };

    it('returns only the provided, valid fields', () => {
        expect(queue.validateSettingsUpdate({ hourlyLimit: '20', dailyLimit: 150, nextSendEligibleAt: 'x' }, current))
            .toEqual({ hourlyLimit: 20, dailyLimit: 150 });
    });

    it.each([
        [{ hourlyLimit: 0 }],
        [{ hourlyLimit: 1.5 }],
        [{ dailyLimit: 'abc' }],
        [{ messageDelayMinSeconds: 5 }],
        [{ duplicateWindowMinutes: 100000 }],
    ])('rejects out-of-bounds input %p', (body) => {
        expect(() => queue.validateSettingsUpdate(body, current)).toThrow(queue.WhatsappQueueError);
    });

    it('rejects a minimum delay above the maximum, including against saved values', () => {
        expect(() => queue.validateSettingsUpdate({ messageDelayMinSeconds: 500, messageDelayMaxSeconds: 400 }, current))
            .toThrow(/greater than the maximum/);
        expect(() => queue.validateSettingsUpdate({ messageDelayMinSeconds: 421 }, current))
            .toThrow(/greater than the maximum/);
    });

    it('reports errors as 400 INVALID_SETTINGS', () => {
        try {
            queue.validateSettingsUpdate({ hourlyLimit: -1 }, current);
            throw new Error('expected to throw');
        } catch (e) {
            expect(e.status).toBe(400);
            expect(e.code).toBe('INVALID_SETTINGS');
        }
    });
});

describe('randomDelaySeconds', () => {
    it('stays within the configured range as whole seconds', () => {
        const seen = new Set();
        for (let i = 0; i < 2000; i++) {
            const s = queue.randomDelaySeconds({ messageDelayMinSeconds: 240, messageDelayMaxSeconds: 420 });
            expect(Number.isInteger(s)).toBe(true);
            expect(s).toBeGreaterThanOrEqual(240);
            expect(s).toBeLessThanOrEqual(420);
            seen.add(s);
        }
        expect(seen.size).toBeGreaterThan(50);
    });

    it('handles equal bounds', () => {
        expect(queue.randomDelaySeconds({ messageDelayMinSeconds: 60, messageDelayMaxSeconds: 60 })).toBe(60);
    });
});

describe('dedupe keys', () => {
    it('treats the same text (ignoring surrounding whitespace) as the same message', () => {
        expect(queue.textDedupeKey(' hello ')).toBe(queue.textDedupeKey('hello'));
        expect(queue.textDedupeKey('hello')).not.toBe(queue.textDedupeKey('hello!'));
    });

    it('keys invoices by id', () => {
        expect(queue.invoiceDedupeKey('abc')).toBe('invoice:abc');
    });
});

describe('getLondonDayStart', () => {
    it.each([
        ['2026-01-10T12:00:00Z', '2026-01-10T00:00:00.000Z'], // GMT
        ['2026-07-10T12:00:00Z', '2026-07-09T23:00:00.000Z'], // BST
        ['2026-07-09T23:30:00Z', '2026-07-09T23:00:00.000Z'], // just after London midnight in BST
        ['2026-03-29T12:00:00Z', '2026-03-29T00:00:00.000Z'], // clocks go forward
        ['2026-10-25T12:00:00Z', '2026-10-24T23:00:00.000Z'], // clocks go back
    ])('%s → %s', (input, expected) => {
        expect(getLondonDayStart(new Date(input)).toISOString()).toBe(expected);
    });
});

describe('markSendFailure', () => {
    let updateOne;
    const opts = { maxAttempts: 3, retryBackoffMs: 120000 };

    // Models are Proxies (lib/tenantModel), which jest.spyOn can't wrap — assign the
    // mock on the underlying model and delete it afterwards to restore the inherited method.
    beforeEach(() => {
        updateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 });
        WhatsappMessage.updateOne = updateOne;
    });
    afterEach(() => {
        delete WhatsappMessage.updateOne;
    });

    const lastUpdate = () => updateOne.mock.calls[updateOne.mock.calls.length - 1][1];

    it('puts the message back without counting the attempt when not connected', async () => {
        await queue.markSendFailure({ _id: 'm1', attempts: 1 }, Object.assign(new Error('x'), { code: 'WA_NOT_CONNECTED' }), opts);
        expect(lastUpdate().$set.status).toBe('pending');
        expect(lastUpdate().$inc).toEqual({ attempts: -1 });
    });

    it('retries transient failures with backoff while attempts remain', async () => {
        const before = Date.now();
        await queue.markSendFailure({ _id: 'm1', attempts: 2 }, Object.assign(new Error('timeout'), { code: 'WA_SEND_FAILED' }), opts);
        const { $set } = lastUpdate();
        expect($set.status).toBe('pending');
        expect($set.scheduledAt.getTime()).toBeGreaterThanOrEqual(before + 2 * 120000);
    });

    it('fails once attempts are used up', async () => {
        await queue.markSendFailure({ _id: 'm1', attempts: 3 }, Object.assign(new Error('timeout'), { code: 'WA_SEND_FAILED' }), opts);
        expect(lastUpdate().$set.status).toBe('failed');
    });

    it.each(['WA_NOT_ON_WHATSAPP', 'WA_ATTACHMENT_MISSING'])('fails %s immediately', async (code) => {
        await queue.markSendFailure({ _id: 'm1', attempts: 1 }, Object.assign(new Error('nope'), { code }), opts);
        expect(lastUpdate().$set.status).toBe('failed');
    });
});
