const { preservePurchaseItemSids, countNewImeis } = require('../src/utils/preservePurchaseItemSids');

describe('preservePurchaseItemSids', () => {
    const existing = [
        {
            imeis: ['351947259722368', '357136140438582'],
            imeiSerials: [
                { imei: '351947259722368', serialItemIdNumber: 'SID-000101' },
                { imei: '357136140438582', serialItemIdNumber: 'SID-000102' },
            ],
        },
        // Legacy line: one item-level SID for all its IMEIs.
        { imeis: ['359987253876978'], serialItemIdNumber: 'SID-000050' },
        // Older line that already lost its SIDs.
        { imeis: ['357136140106213'] },
        { isOtherItem: true, quantity: 3, barcode: 'CABLE-1' },
    ];

    it('keeps SIDs by IMEI when the edit page sends items without them (price change)', () => {
        const incoming = [
            { imeis: ['351947259722368', '357136140438582'], purchasePrice: 140, salePrice: 165 },
            { imeis: ['359987253876978'], purchasePrice: 315, salePrice: 340 },
        ];
        const { items, preserved, assigned } = preservePurchaseItemSids(incoming, existing, null);
        expect(items[0].imeiSerials).toEqual([
            { imei: '351947259722368', serialItemIdNumber: 'SID-000101' },
            { imei: '357136140438582', serialItemIdNumber: 'SID-000102' },
        ]);
        expect(items[1].imeiSerials).toEqual([{ imei: '359987253876978', serialItemIdNumber: 'SID-000050' }]);
        expect(items[0].purchasePrice).toBe(140);
        expect(preserved).toBe(3);
        expect(assigned).toBe(0);
    });

    it('follows an IMEI moved to another group', () => {
        const incoming = [
            { imeis: ['351947259722368'] },
            { imeis: ['357136140438582', '359987253876978'] },
        ];
        const { items } = preservePurchaseItemSids(incoming, existing, null);
        expect(items[1].imeiSerials.map((s) => s.serialItemIdNumber)).toEqual(['SID-000102', 'SID-000050']);
    });

    it('gives IMEIs added during the edit new SIDs, like a new purchase', () => {
        const incoming = [{ imeis: ['351947259722368', '356258482663295', '355700853232375'] }];
        expect(countNewImeis(incoming, existing)).toBe(2);
        const { items, assigned } = preservePurchaseItemSids(incoming, existing, 205);
        expect(items[0].imeiSerials).toEqual([
            { imei: '351947259722368', serialItemIdNumber: 'SID-000101' },
            { imei: '356258482663295', serialItemIdNumber: 'SID-000205' },
            { imei: '355700853232375', serialItemIdNumber: 'SID-000206' },
        ]);
        expect(assigned).toBe(2);
    });

    it('does not invent SIDs for IMEIs that were already on the purchase without one', () => {
        const incoming = [{ imeis: ['357136140106213'] }];
        expect(countNewImeis(incoming, existing)).toBe(0);
        const { items } = preservePurchaseItemSids(incoming, existing, 300);
        expect(items[0].imeiSerials).toEqual([]);
    });

    it('drops the legacy item-level SID in favour of per-IMEI SIDs', () => {
        const incoming = [{ imeis: ['359987253876978'], serialItemIdNumber: 'SID-000050' }];
        const { items } = preservePurchaseItemSids(incoming, existing, null);
        expect(items[0]).not.toHaveProperty('serialItemIdNumber');
    });

    it('leaves non-serial items untouched', () => {
        const other = { isOtherItem: true, quantity: 3, barcode: 'CABLE-1', purchasePrice: 2 };
        const { items } = preservePurchaseItemSids([other], existing, 1);
        expect(items[0]).toBe(other);
    });

    it('matches IMEIs ignoring surrounding spaces', () => {
        const { items } = preservePurchaseItemSids([{ imeis: [' 351947259722368 '] }], existing, null);
        expect(items[0].imeiSerials[0].serialItemIdNumber).toBe('SID-000101');
    });
});
