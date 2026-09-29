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

    it('keys invoices by id and version, so an edited invoice is a new message', () => {
        const saved = new Date('2026-09-28T14:35:00Z');
        const edited = new Date('2026-09-28T14:41:00Z');
        expect(queue.invoiceDedupeKey('abc', saved)).toBe(queue.invoiceDedupeKey('abc', new Date(saved)));
        expect(queue.invoiceDedupeKey('abc', saved)).not.toBe(queue.invoiceDedupeKey('abc', edited));
        expect(queue.invoiceDedupeKey('abc', 'not a date')).toBe('invoice:abc');
    });
});

describe('duplicateMessage', () => {
    const settings = { duplicateWindowMinutes: 10 };
    const now = new Date('2026-09-28T15:10:00Z');

    it('says when a sent message can go again', () => {
        const text = queue.duplicateMessage({ status: 'sent', sentAt: new Date('2026-09-28T15:05:00Z') }, '447700900000', settings, now);
        expect(text).toMatch(/already sent to \+447700900000/);
        expect(text).toMatch(/again in 5 min/);
        expect(text).toMatch(/once it has been changed/);
    });

    it('never says less than a minute', () => {
        const text = queue.duplicateMessage({ status: 'sent', sentAt: new Date('2026-09-28T15:00:01Z') }, '447700900000', settings, now);
        expect(text).toMatch(/again in 1 min/);
    });

    it('reports a message still in the queue', () => {
        expect(queue.duplicateMessage({ status: 'pending' }, '447700900000', settings, now)).toBe('This is already queued for +447700900000');
    });
});

describe('enqueueMessage', () => {
    const WhatsappSettingsModel = require('../src/models/WhatsappSettings');
    const settings = { ...WHATSAPP_SAFETY_DEFAULTS, nextSendEligibleAt: new Date(0) };
    const invoiceId = '65f0a1b2c3d4e5f6a7b8c9d0';
    // getSettings is a schema static (own property of the model): restore it, don't delete it.
    const originalGetSettings = WhatsappSettingsModel.getSettings;
    let findOne, countDocuments, updateMany, create, counts;

    beforeEach(() => {
        counts = { sentToday: 0, queued: 0, superseded: 0 };
        findOne = jest.fn(() => ({ select: () => ({ lean: async () => null }) }));
        countDocuments = jest.fn(async (filter) => {
            if (filter['sourceRef.invoiceId']) return counts.superseded;
            if (filter._id) return 0; // queued ahead
            if (filter.status === 'sent') return counts.sentToday;
            return counts.queued;
        });
        updateMany = jest.fn(async () => ({ modifiedCount: counts.superseded }));
        create = jest.fn(async (doc) => ({ _id: 'new', ...doc }));
        Object.assign(WhatsappMessage, { findOne, countDocuments, updateMany, create });
        WhatsappSettingsModel.getSettings = jest.fn(async () => settings);
    });
    afterEach(() => {
        for (const m of ['findOne', 'countDocuments', 'updateMany', 'create']) delete WhatsappMessage[m];
        WhatsappSettingsModel.getSettings = originalGetSettings;
    });

    const enqueueInvoice = (updatedAt) => queue.enqueueMessage({
        phone: '07700 900000',
        text: 'Invoice INV-000141',
        attachment: { filename: 'inv.pdf', mimetype: 'application/pdf', data: Buffer.from('%PDF-1.4 test') },
        source: 'invoice',
        sourceRef: { invoiceId, reference: 'INV-000141' },
        dedupeKey: queue.invoiceDedupeKey(invoiceId, updatedAt),
    });

    it('refuses the same unchanged invoice within the window', async () => {
        findOne.mockReturnValue({ select: () => ({ lean: async () => ({ status: 'sent', sentAt: new Date() }) }) });
        await expect(enqueueInvoice(new Date('2026-09-28T14:35:00Z'))).rejects.toMatchObject({ code: 'DUPLICATE', status: 409 });
        expect(create).not.toHaveBeenCalled();
    });

    it('replaces an older copy of the invoice still waiting to be sent', async () => {
        counts.queued = 1;
        counts.superseded = 1;
        const updatedAt = new Date('2026-09-28T14:41:00Z');
        await enqueueInvoice(updatedAt);

        expect(updateMany).toHaveBeenCalledTimes(1);
        const [filter, update] = updateMany.mock.calls[0];
        expect(filter).toEqual({
            recipientPhone: '447700900000',
            'sourceRef.invoiceId': invoiceId,
            dedupeKey: { $ne: queue.invoiceDedupeKey(invoiceId, updatedAt) },
            status: 'pending',
        });
        expect(update.$set.status).toBe('cancelled');
        expect(create).toHaveBeenCalledTimes(1);
    });

    it('does not count the replaced copy towards the recipient daily cap', async () => {
        counts.sentToday = settings.dailyCapPerRecipient - 1;
        counts.queued = 1;
        counts.superseded = 1;
        await expect(enqueueInvoice(new Date('2026-09-28T14:41:00Z'))).resolves.toBeDefined();
    });

    it('keeps the older copy when the cap refuses the new one', async () => {
        counts.sentToday = settings.dailyCapPerRecipient;
        counts.queued = 1;
        counts.superseded = 1;
        await expect(enqueueInvoice(new Date('2026-09-28T14:41:00Z'))).rejects.toMatchObject({ code: 'RECIPIENT_DAILY_CAP' });
        expect(updateMany).not.toHaveBeenCalled();
    });

    it('leaves other messages alone for test messages', async () => {
        await queue.enqueueMessage({ phone: '07700 900000', text: 'hello', source: 'test', dedupeKey: queue.textDedupeKey('hello') });
        expect(updateMany).not.toHaveBeenCalled();
    });
});

describe('markSent', () => {
    let updateOne;
    beforeEach(() => {
        updateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 });
        WhatsappMessage.updateOne = updateOne;
    });
    afterEach(() => {
        delete WhatsappMessage.updateOne;
    });

    it('stores the sent message so it can be re-sent', async () => {
        const encoded = Buffer.from([1, 2, 3]);
        await queue.markSent('m1', '3EB0AAA', encoded);
        const [filter, update] = updateOne.mock.calls[0];
        expect(filter).toEqual({ _id: 'm1', status: 'sending' });
        expect(update.$set).toMatchObject({ status: 'sent', providerMessageId: '3EB0AAA', providerMessage: encoded });
        expect(update.$unset).toEqual({ 'attachment.data': 1, error: 1 });
    });

    it('still marks the message sent without a stored copy', async () => {
        await queue.markSent('m1', '3EB0AAA');
        expect(updateOne.mock.calls[0][1].$set).not.toHaveProperty('providerMessage');
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
