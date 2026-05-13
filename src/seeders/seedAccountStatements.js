const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../../.env') });

const Customer = require('../models/Customer');
const Supplier = require('../models/Supplier');
const LedgerEntry = require('../models/LedgerEntry');

/**
 * Generate a random date between `from` and `to`.
 */
function randomDate(from, to) {
    return new Date(from.getTime() + Math.random() * (to.getTime() - from.getTime()));
}

const round2 = (n) => Math.round(n * 100) / 100;

const seed = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('MongoDB Connected');

        // ── 1. Ensure customers exist ──────────────────────────────────
        let customers = await Customer.find({ isActive: true }).lean();
        if (customers.length === 0) {
            console.log('No customers found — creating sample customers...');
            const sampleCustomers = [
                { name: 'Ali Hassan', email: 'ali.hassan@email.com', phone: '+44-7700-100001', address: { street: '12 High Street', city: 'London', state: '', zipCode: 'E1 6AN', country: 'United Kingdom' }, balance: 0, tenantId: 'default' },
                { name: 'Fatima Ahmed', email: 'fatima.ahmed@email.com', phone: '+44-7700-100002', address: { street: '45 Oxford Road', city: 'Manchester', state: '', zipCode: 'M1 5QS', country: 'United Kingdom' }, balance: 0, tenantId: 'default' },
                { name: 'James Wilson', email: 'james.wilson@email.com', phone: '+44-7700-100003', address: { street: '78 Park Lane', city: 'Birmingham', state: '', zipCode: 'B1 1BB', country: 'United Kingdom' }, balance: 0, tenantId: 'default' },
                { name: 'Sarah Khan', email: 'sarah.khan@email.com', phone: '+44-7700-100004', address: { street: '23 Queen Street', city: 'Leeds', state: '', zipCode: 'LS1 1BA', country: 'United Kingdom' }, balance: 0, tenantId: 'default' },
                { name: 'David Brown', email: 'david.brown@email.com', phone: '+44-7700-100005', address: { street: '9 Castle Road', city: 'Edinburgh', state: '', zipCode: 'EH1 2NG', country: 'United Kingdom' }, balance: 0, tenantId: 'default' },
            ];
            customers = await Customer.insertMany(sampleCustomers);
            console.log(`✓ ${customers.length} customers created`);
        } else {
            console.log(`Found ${customers.length} existing customers`);
        }

        // ── 2. Ensure suppliers exist ──────────────────────────────────
        let suppliers = await Supplier.find({ isActive: true }).lean();
        if (suppliers.length === 0) {
            console.log('No suppliers found — creating sample suppliers...');
            const sampleSuppliers = [
                { name: 'Global Electronics Ltd', email: 'sales@globalelec.co.uk', phone: '+44-20-7890-1234', address: { street: '50 Electronics Way', city: 'London', state: '', zipCode: 'EC1A 1BB', country: 'United Kingdom' }, contactPerson: 'James Circuit' },
                { name: 'Mobile Parts Direct', email: 'orders@mobilepartsdirect.co.uk', phone: '+44-20-7890-5678', address: { street: '15 Tech Park', city: 'Bristol', state: '', zipCode: 'BS1 4DJ', country: 'United Kingdom' }, contactPerson: 'Emma Screen' },
                { name: 'Accessory Wholesale UK', email: 'info@accessorywholesale.co.uk', phone: '+44-121-456-7890', address: { street: '8 Trade Centre', city: 'Birmingham', state: '', zipCode: 'B2 5NY', country: 'United Kingdom' }, contactPerson: 'Oliver Case' },
            ];
            suppliers = await Supplier.insertMany(sampleSuppliers);
            console.log(`✓ ${suppliers.length} suppliers created`);
        } else {
            console.log(`Found ${suppliers.length} existing suppliers`);
        }

        // ── 3. Clear existing ledger entries (so we can re-seed cleanly) ─
        await LedgerEntry.deleteMany({});
        console.log('✓ Cleared existing ledger entries');

        // ── 4. Seed customer ledger entries ────────────────────────────
        const now = new Date();
        const threeMonthsAgo = new Date(now);
        threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

        const customerEntries = [];
        const saleRefs = [
            'INV-001', 'INV-002', 'INV-003', 'INV-004', 'INV-005',
            'INV-006', 'INV-007', 'INV-008', 'INV-009', 'INV-010',
            'INV-011', 'INV-012', 'INV-013', 'INV-014', 'INV-015',
        ];
        const paymentMethods = ['cash', 'bank', 'card'];

        let refIdx = 0;
        for (const customer of customers.slice(0, 5)) {
            const custId = customer._id;

            // Opening balance
            const openingBal = round2(Math.random() * 500 + 100);
            const openDate = new Date(threeMonthsAgo);
            openDate.setDate(openDate.getDate() - 1);
            customerEntries.push({
                accountType: 'customer',
                accountId: custId,
                accountModel: 'Customer',
                type: 'opening_balance',
                amount: openingBal,
                referenceLabel: 'Balance brought forward',
                date: openDate,
                paymentMethod: '',
                note: 'Opening balance seeded',
            });

            let runningBalance = openingBal;

            // Generate 4-6 sales per customer
            const saleCount = Math.floor(Math.random() * 3) + 4;
            for (let i = 0; i < saleCount; i++) {
                const saleAmount = round2(Math.random() * 300 + 50);
                const saleDate = randomDate(threeMonthsAgo, now);
                const ref = saleRefs[refIdx % saleRefs.length];
                refIdx++;

                customerEntries.push({
                    accountType: 'customer',
                    accountId: custId,
                    accountModel: 'Customer',
                    type: 'sale',
                    amount: saleAmount,
                    referenceLabel: ref,
                    date: saleDate,
                    paymentMethod: '',
                    note: '',
                });
                runningBalance = round2(runningBalance + saleAmount);
            }

            // Generate 2-4 payments per customer
            const payCount = Math.floor(Math.random() * 3) + 2;
            for (let i = 0; i < payCount; i++) {
                const maxPay = Math.min(runningBalance, 400);
                if (maxPay <= 0) break;
                const payAmount = round2(Math.random() * maxPay * 0.6 + 20);
                const payDate = randomDate(threeMonthsAgo, now);
                const method = paymentMethods[Math.floor(Math.random() * paymentMethods.length)];

                customerEntries.push({
                    accountType: 'customer',
                    accountId: custId,
                    accountModel: 'Customer',
                    type: 'payment_in',
                    amount: round2(-payAmount),
                    referenceLabel: `Payment ${method}`,
                    date: payDate,
                    paymentMethod: method,
                    note: '',
                });
                runningBalance = round2(runningBalance - payAmount);
            }

            // Update customer balance
            await Customer.findByIdAndUpdate(custId, { balance: round2(runningBalance) });
        }

        // ── 5. Seed supplier ledger entries ────────────────────────────
        const supplierEntries = [];
        const purchaseRefs = [
            'PO-001', 'PO-002', 'PO-003', 'PO-004', 'PO-005',
            'PO-006', 'PO-007', 'PO-008', 'PO-009', 'PO-010',
        ];

        let poIdx = 0;
        for (const supplier of suppliers.slice(0, 3)) {
            const supId = supplier._id;

            // Generate 3-5 purchases per supplier
            const purchaseCount = Math.floor(Math.random() * 3) + 3;
            let supplierBalance = 0;

            for (let i = 0; i < purchaseCount; i++) {
                const purchaseAmount = round2(Math.random() * 1000 + 200);
                const purchaseDate = randomDate(threeMonthsAgo, now);
                const ref = purchaseRefs[poIdx % purchaseRefs.length];
                poIdx++;

                supplierEntries.push({
                    accountType: 'supplier',
                    accountId: supId,
                    accountModel: 'Supplier',
                    type: 'purchase',
                    amount: purchaseAmount,
                    referenceLabel: ref,
                    date: purchaseDate,
                    paymentMethod: '',
                    note: '',
                });
                supplierBalance = round2(supplierBalance + purchaseAmount);
            }

            // Generate 1-3 payments per supplier
            const payCount = Math.floor(Math.random() * 3) + 1;
            for (let i = 0; i < payCount; i++) {
                const maxPay = Math.min(supplierBalance, 800);
                if (maxPay <= 0) break;
                const payAmount = round2(Math.random() * maxPay * 0.5 + 100);
                const payDate = randomDate(threeMonthsAgo, now);
                const method = paymentMethods[Math.floor(Math.random() * paymentMethods.length)];

                supplierEntries.push({
                    accountType: 'supplier',
                    accountId: supId,
                    accountModel: 'Supplier',
                    type: 'payment_out',
                    amount: round2(-payAmount),
                    referenceLabel: `Payment ${method}`,
                    date: payDate,
                    paymentMethod: method,
                    note: '',
                });
                supplierBalance = round2(supplierBalance - payAmount);
            }
        }

        // ── 6. Insert all ledger entries ───────────────────────────────
        const allEntries = [...customerEntries, ...supplierEntries];
        const created = await LedgerEntry.insertMany(allEntries);
        console.log(`✓ ${created.length} ledger entries seeded (${customerEntries.length} customer, ${supplierEntries.length} supplier)`);

        // ── 7. Summary ────────────────────────────────────────────────
        console.log('\n--- Account Statement Seed Summary ---');
        console.log(`Customers with statements: ${Math.min(customers.length, 5)}`);
        console.log(`Suppliers with statements: ${Math.min(suppliers.length, 3)}`);
        console.log(`Total ledger entries: ${created.length}`);
        console.log('\n✅ Account statement seeding completed!\n');
        process.exit(0);
    } catch (error) {
        console.error('❌ Seeding failed:', error.message);
        process.exit(1);
    }
};

seed();
