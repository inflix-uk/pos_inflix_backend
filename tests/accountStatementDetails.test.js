const { attachLineDetails } = require('../src/utils/accountStatement');

describe('attachLineDetails', () => {
    const sale = {
        _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
        reference: 'INV-000417',
        items: [{ name: 'iPhone 13 128GB', sku: 'IP13', price: 215, quantity: 2, serialNumbers: ['S1', '', 'S2'] }],
        total: 430,
        discount: 10,
        status: 'active'
    };
    const ret = {
        _id: 'bbbbbbbbbbbbbbbbbbbbbbbb',
        reference: 'SR-000023',
        linkedInvoiceRef: 'INV-000417',
        items: [{ product: 'iPhone 13 128GB', sku: 'IP13', netUnitPrice: 85, quantity: 1, subtotal: 85, serialNumbers: ['S1'] }],
        total: 85,
        discount: 0,
        grandTotal: 85
    };

    it('adds invoice items and net total to sale lines', () => {
        const [line] = attachLineDetails([{ _id: 'l1', referenceId: sale._id }], [sale], []);
        expect(line.details).toMatchObject({
            kind: 'invoice',
            reference: 'INV-000417',
            subtotal: 430,
            discount: 10,
            total: 420,
            items: [{ name: 'iPhone 13 128GB', quantity: 2, price: 215, total: 430, serialNumbers: ['S1', 'S2'] }]
        });
    });

    it('adds returned items to store-credit lines', () => {
        const [line] = attachLineDetails([{ _id: 'l2', referenceId: ret._id }], [], [ret]);
        expect(line.details).toMatchObject({
            kind: 'return',
            reference: 'SR-000023',
            linkedInvoiceRef: 'INV-000417',
            total: 85,
            items: [{ name: 'iPhone 13 128GB', quantity: 1, price: 85, total: 85, serialNumbers: ['S1'] }]
        });
    });

    it('leaves lines without a matching document unchanged', () => {
        const lines = [{ _id: 'l3' }, { _id: 'l4', referenceId: 'cccccccccccccccccccccccc' }];
        expect(attachLineDetails(lines, [sale], [ret])).toEqual(lines);
    });
});
