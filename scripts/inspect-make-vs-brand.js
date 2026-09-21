/**
 * READ-ONLY inspection of the Make vs Brand variant attributes for one tenant.
 *
 * Writes nothing. Prints no credentials. Run this before migrate-make-to-brand.js
 * so the migration is planned against the real data shape, not assumptions.
 *
 * Usage:
 *   TENANT_ID=fonewarehouse node scripts/inspect-make-vs-brand.js
 *   TENANT_ID=fonefit      node scripts/inspect-make-vs-brand.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../src/config');
const tenantContext = require('../src/lib/tenantContext');

const TENANT_ID = process.env.TENANT_ID || 'fonewarehouse';
const SAMPLE = 15;

const line = (t) => console.log(t);
const head = (t) => console.log('\n' + '-'.repeat(72) + '\n' + t + '\n' + '-'.repeat(72));

async function run() {
    if (!process.env.MONGODB_URI) {
        console.error('MONGODB_URI missing in .env');
        process.exit(1);
    }
    await mongoose.connect(process.env.MONGODB_URI);

    const dbPrefix = config.tenantDbPrefix || 'tenant_';
    const dbName = dbPrefix + TENANT_ID;
    const tenantDb = mongoose.connection.useDb(dbName, { useCache: true });

    line('Tenant: ' + TENANT_ID + '  (db=' + dbName + ')');
    line('Mode: READ-ONLY (no writes)');

    await tenantContext.run({ tenantDb, tenantId: TENANT_ID }, async () => {
        const VariantAttribute = require('../src/models/VariantAttribute');
        const Category = require('../src/models/Category');
        const SubCategory = require('../src/models/SubCategory');
        const Purchase = require('../src/models/Purchase');
        const StockItem = require('../src/models/StockItem');
        const Sale = require('../src/models/Sale');
        const Product = require('../src/models/Product');

        // 1. Variant attributes ------------------------------------------------
        head('1. VARIANT ATTRIBUTES  (Inventory -> Variant Attributes)');
        const attrs = await VariantAttribute.find({}).lean();
        if (attrs.length === 0) line('  (none)');
        for (const a of attrs) {
            const vals = a.values || [];
            const withModels = vals.filter((v) => (v.models || []).length > 0).length;
            line('  _id=' + a._id + '  name="' + a.name + '"  slug="' + a.slug + '"  active=' + (a.isActive !== false));
            line('      values=' + vals.length + '  valuesWithModels=' + withModels);
            const sample = vals.slice(0, SAMPLE)
                .map((v) => v.name + '[' + v.slug + ']' + ((v.models || []).length ? '(' + v.models.length + 'm)' : ''))
                .join(', ');
            line('      sample: ' + (sample || '-'));
        }

        // 2. Categories --------------------------------------------------------
        head('2. CATEGORIES -> assigned variant attributes (first one holds the value tree)');
        const cats = await Category.find({}).populate('variantAttributes', 'name slug').lean();
        const attrById = new Map(attrs.map((a) => [String(a._id), a]));
        for (const c of cats) {
            const assigned = (c.variantAttributes || [])
                .map((a, i) => (i === 0 ? '*' : ' ') + (a && a.slug ? a.slug : String(a)));
            line('  ' + c.name + '  itemType=' + c.itemType + '  attrs=[' + assigned.join(', ') + ']   (* = tree holder)');
            for (const entry of c.variantAttributeValues || []) {
                const a = attrById.get(String(entry.attribute));
                const vals = entry.values || [];
                const nested = vals.reduce((n, v) => n + (v.models || []).length, 0);
                line('      values for "' + (a ? a.slug : entry.attribute) + '": ' + vals.length + ' values, ' + nested + ' nested models');
                line('         ' + (vals.slice(0, SAMPLE).map((v) => v.name).join(', ') || '-'));
            }
        }

        // 3. Purchase items: which slugs are actually stored --------------------
        head('3. PURCHASE ITEMS -> variantValues slug usage (source of truth)');
        const slugAgg = await Purchase.aggregate([
            { $match: { tenantId: TENANT_ID } },
            { $unwind: '$items' },
            { $unwind: '$items.variantValues' },
            { $group: { _id: { $toLower: '$items.variantValues.slug' }, items: { $sum: 1 } } },
            { $sort: { items: -1 } }
        ]);
        if (slugAgg.length === 0) line('  (no variantValues stored on any purchase item)');
        for (const s of slugAgg) line('  slug="' + s._id + '"  itemCount=' + s.items);

        // 4. Distinct values per interesting slug -------------------------------
        for (const slug of ['make', 'brands', 'brand']) {
            const valAgg = await Purchase.aggregate([
                { $match: { tenantId: TENANT_ID } },
                { $unwind: '$items' },
                { $unwind: '$items.variantValues' },
                { $match: { $expr: { $eq: [{ $toLower: '$items.variantValues.slug' }, slug] } } },
                { $group: { _id: '$items.variantValues.value', n: { $sum: 1 } } },
                { $sort: { n: -1 } }
            ]);
            head('4. PURCHASE ITEMS -> distinct values for slug "' + slug + '"  (' + valAgg.length + ' distinct)');
            for (const v of valAgg.slice(0, 40)) line('  ' + String(v._id).padEnd(28) + ' ' + v.n);
            if (valAgg.length > 40) line('  ... and ' + (valAgg.length - 40) + ' more');
        }

        // 5. Legacy flat fields on purchase items -------------------------------
        head('5. PURCHASE ITEMS -> legacy flat fields (brand / brandModel)');
        const nonEmpty = (path) => ({ $cond: [{ $gt: [{ $strLenCP: { $ifNull: [path, ''] } }, 0] }, 1, 0] });
        const flat = await Purchase.aggregate([
            { $match: { tenantId: TENANT_ID } },
            { $unwind: '$items' },
            {
                $group: {
                    _id: null,
                    total: { $sum: 1 },
                    withBrand: { $sum: nonEmpty('$items.brand') },
                    withBrandModel: { $sum: nonEmpty('$items.brandModel') },
                    withVv: { $sum: { $cond: [{ $gt: [{ $size: { $ifNull: ['$items.variantValues', []] } }, 0] }, 1, 0] } }
                }
            }
        ]);
        const f = flat[0] || { total: 0, withBrand: 0, withBrandModel: 0, withVv: 0 };
        line('  purchase items total:      ' + f.total);
        line('  with items.brand set:      ' + f.withBrand);
        line('  with items.brandModel set: ' + f.withBrandModel);
        line('  with variantValues:        ' + f.withVv);

        head('5b. PURCHASE ITEMS carrying slug "make" -> do they already have legacy brand/model?');
        const makeVsLegacy = await Purchase.aggregate([
            { $match: { tenantId: TENANT_ID } },
            { $unwind: '$items' },
            { $match: { 'items.variantValues.slug': { $regex: /^make$/i } } },
            {
                $group: {
                    _id: null,
                    n: { $sum: 1 },
                    brandSet: { $sum: nonEmpty('$items.brand') },
                    modelSet: { $sum: nonEmpty('$items.brandModel') }
                }
            }
        ]);
        const m = makeVsLegacy[0];
        if (!m) line('  (no items carry slug "make")');
        else line('  items with make=' + m.n + '   of those: items.brand set=' + m.brandSet + ', items.brandModel set=' + m.modelSet);

        // 6. StockItem ---------------------------------------------------------
        head('6. STOCK_ITEMS (denormalized index)');
        const siTotal = await StockItem.countDocuments({ tenantId: TENANT_ID });
        const siBrand = await StockItem.countDocuments({ tenantId: TENANT_ID, brand: { $nin: ['', null] } });
        const siMake = await StockItem.countDocuments({ tenantId: TENANT_ID, 'variantValues.slug': { $regex: /^make$/i } });
        line('  total=' + siTotal + '  withBrand=' + siBrand + '  carrying slug "make"=' + siMake);

        // 7. Sales snapshots ---------------------------------------------------
        head('7. SALES line snapshots (flat brand/brandModel only - no variantValues)');
        const saleAgg = await Sale.aggregate([
            { $match: { tenantId: TENANT_ID } },
            { $unwind: '$items' },
            {
                $group: {
                    _id: null,
                    total: { $sum: 1 },
                    withBrand: { $sum: nonEmpty('$items.brand') },
                    withBrandModel: { $sum: nonEmpty('$items.brandModel') }
                }
            }
        ]);
        const s = saleAgg[0] || { total: 0, withBrand: 0, withBrandModel: 0 };
        line('  sale line items=' + s.total + '  withBrand=' + s.withBrand + '  withBrandModel=' + s.withBrandModel);

        // 8. SubCategory -------------------------------------------------------
        head('8. SUB-CATEGORIES (purchases Add/Edit form labels this dropdown "Make")');
        const subs = await SubCategory.find({}).select('name category isActive').lean();
        line('  count=' + subs.length);
        line('  sample: ' + (subs.slice(0, SAMPLE).map((x) => x.name).join(', ') || '-'));
        const prodWithSub = await Product.countDocuments({ tenantId: TENANT_ID, subCategory: { $ne: null } });
        const prodWithBrand = await Product.countDocuments({ tenantId: TENANT_ID, brand: { $ne: null } });
        line('  products with subCategory set=' + prodWithSub + '   products with brand ref set=' + prodWithBrand);

        head('DONE - read-only, nothing was modified.');
    });

    await mongoose.disconnect();
}

run().catch((e) => { console.error(e); process.exit(1); });
