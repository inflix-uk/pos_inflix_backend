/**
 * READ-ONLY: verify the barcode-uniqueness fix against the per-tenant DB.
 *
 * Each tenant lives in its own DB (tenant_<id>). We query the raw collection so
 * we don't depend on the model proxy / AsyncLocalStorage that the request flow uses.
 *
 * Usage:
 *   node scripts/test-barcode-reuse.js B0912701           # uses TENANT_ID from .env
 *   node scripts/test-barcode-reuse.js B0912701 gnr
 *   node scripts/test-barcode-reuse.js B0912701 all       # scan every tenant_* db
 */
require('dotenv').config();
const mongoose = require('mongoose');

const barcodeArg = process.argv[2] || 'B0912701';
const tenantArg = (process.argv[3] || process.env.TENANT_ID || 'default').toLowerCase();
const dbPrefix = process.env.TENANT_DB_PREFIX || 'tenant_';

function oldValidator(purchases, barcode) {
    const first = purchases[0];
    if (!first) return { valid: true };
    const found = (first.items || []).find((it) => it.barcode && String(it.barcode).trim() === barcode);
    if (found) return { valid: false, line: { quantity: found.quantity, isOtherItem: found.isOtherItem } };
    return { valid: true };
}

function newValidator(purchases, barcode) {
    for (const p of purchases) {
        const found = (p.items || []).find((it) => {
            if (!it.barcode || String(it.barcode).trim() !== barcode) return false;
            if (it.isOtherItem) {
                const q = Number(it.quantity);
                if (Number.isFinite(q) && q <= 0) return false;
            }
            return true;
        });
        if (found) return { valid: false, line: { quantity: found.quantity, isOtherItem: found.isOtherItem } };
    }
    return { valid: true };
}

async function testTenant(dbName, barcode) {
    const db = mongoose.connection.useDb(dbName, { useCache: true });
    const Purchases = db.collection('purchases');
    const Products = db.collection('products');

    const inProduct = await Products.findOne({ barcode }, { projection: { barcode: 1 } });
    const purchases = await Purchases.find(
        { 'items.barcode': barcode },
        { projection: { purchaseNumber: 1, parcelNumber: 1, createdAt: 1, 'items.barcode': 1, 'items.quantity': 1, 'items.isOtherItem': 1, 'items.imeis': 1 } }
    ).sort({ createdAt: -1 }).toArray();

    console.log(`\n=== ${dbName} ===`);
    console.log(`Product collection match: ${inProduct ? 'YES (blocks reuse regardless of fix)' : 'no'}`);
    console.log(`Purchase docs containing barcode: ${purchases.length}`);
    for (const p of purchases) {
        const matching = (p.items || []).filter((it) => it.barcode && String(it.barcode).trim() === barcode);
        for (const it of matching) {
            console.log(
                `  parcel=${p.parcelNumber || p.purchaseNumber || p._id} ` +
                `qty=${it.quantity} isOtherItem=${!!it.isOtherItem} imeis=${(it.imeis || []).length}`
            );
        }
    }

    if (inProduct) {
        console.log('Both validators block via Product check (unchanged).');
        return;
    }

    const oldResult = oldValidator(purchases, barcode);
    const newResult = newValidator(purchases, barcode);
    console.log(`OLD validator: ${oldResult.valid ? 'ALLOW' : `REJECT (line: ${JSON.stringify(oldResult.line)})`}`);
    console.log(`NEW validator: ${newResult.valid ? 'ALLOW' : `REJECT (line: ${JSON.stringify(newResult.line)})`}`);

    if (!oldResult.valid && newResult.valid) console.log('=> Fix verified: was blocked, now allowed (depleted line).');
    else if (oldResult.valid && newResult.valid) console.log('=> No conflict either way.');
    else console.log('=> Both reject (line still has stock — correct behaviour).');
}

async function run() {
    if (!process.env.MONGODB_URI) {
        console.error('MONGODB_URI not set');
        process.exit(1);
    }
    await mongoose.connect(process.env.MONGODB_URI);
    console.log(`Connected. barcode="${barcodeArg}" tenant="${tenantArg}"`);

    if (tenantArg === 'all') {
        const admin = mongoose.connection.db.admin();
        const { databases } = await admin.listDatabases();
        for (const d of databases) {
            if (d.name.startsWith(dbPrefix)) await testTenant(d.name, barcodeArg);
        }
    } else {
        await testTenant(dbPrefix + tenantArg, barcodeArg);
    }
    await mongoose.disconnect();
}

run().catch((e) => { console.error(e); process.exit(1); });
