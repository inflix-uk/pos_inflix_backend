/**
 * Migrate a mis-named brand variant attribute (default: "make") to "brand", tenant-scoped.
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 * The slug -> legacy-field maps that populate purchase items' flat `brand` field
 * only recognise `brand` / `brands`:
 *   - frontend resolveVariantValues (purchases add/edit, create-product)
 *   - src/utils/variantValueUsage.js      SLUG_TO_LEGACY
 *   - src/controllers/purchaseController  STOCK_LIST_VARIANT_SLUGS
 *   - ProductsStockTable                  VARIANT_SLUG_ALIASES
 * A tenant whose attribute is called "make" therefore stores
 * variantValues: [{ slug: 'make', value: 'APPLE' }] but leaves items.brand empty,
 * so every brand-keyed check, column, filter and variantKey reads blank.
 *
 * ── What it changes ─────────────────────────────────────────────────────────
 *   1. variantattributes  { slug: FROM } -> { name: TO_NAME, slug: TO }.
 *      The _id is NOT changed, so categories.variantAttributes and
 *      categories.variantAttributeValues[].attribute keep resolving and the whole
 *      nested value tree (SAMSUNG -> models -> children) is left exactly as-is.
 *      Categories therefore need no write at all.
 *   2. purchases     items[].variantValues[].slug FROM -> TO, and fills
 *                    items[].brand from that value. Never overwrites a non-empty brand.
 *   3. stock_items   same two changes on the denormalized search index.
 *   4. serial_index  fills brandSnapshot from the linked purchase item. This is a
 *                    derived projection kept in sync from Purchase (see
 *                    refresh-serial-index-from-purchase.js), so leaving it stale
 *                    would make the read model disagree with its source.
 *
 * ── What it deliberately does NOT change ───────────────────────────────────
 *   - sales.items[].brand — a completed sale is an immutable transactional
 *     snapshot (cf. unit_cost_at_sale: "Do not change after sale"). Rewriting
 *     issued invoices is an audit problem, not a fix. Opt in with --include-sales
 *     if the shop explicitly wants historical receipts reprinted with the brand.
 *   - auditevents / auditlogs — history is never rewritten.
 *   - stock_items.status / saleId / soldAt — this patches brand in place rather
 *     than rebuilding from SoldSerial + Sale, which could reset sold/transferred rows.
 *   - stock_items.searchText — already contains the value via variantValueText,
 *     so search keeps working without a rewrite.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *   TENANT_ID=fonewarehouse node scripts/migrate-make-to-brand.js                  # dry-run
 *   TENANT_ID=fonewarehouse node scripts/migrate-make-to-brand.js --apply          # write
 *   TENANT_ID=fonewarehouse node scripts/migrate-make-to-brand.js --apply --include-sales
 *   FROM_SLUG=manufacturer TENANT_ID=acme node scripts/migrate-make-to-brand.js    # any slug
 *
 * Idempotent: re-running after a successful migration is a no-op.
 * Streams in batches, so memory stays flat on large tenants.
 * On --apply, the pre-image of every document it touches is appended to an
 * NDJSON backup before that batch is written.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const config = require('../src/config');

const APPLY = process.argv.includes('--apply');
const INCLUDE_SALES = process.argv.includes('--include-sales');
const TENANT_ID = process.env.TENANT_ID || 'fonewarehouse';
const FROM_SLUG = (process.env.FROM_SLUG || 'make').toLowerCase();
const TO_SLUG = (process.env.TO_SLUG || 'brand').toLowerCase();
const TO_NAME = process.env.TO_NAME || TO_SLUG;
const BATCH = Number(process.env.BATCH_SIZE || 500);
const MAX_PREVIEW = 10;

const isFrom = (s) => String(s || '').trim().toLowerCase() === FROM_SLUG;
const isTo = (s) => String(s || '').trim().toLowerCase() === TO_SLUG;
const line = (t) => console.log(t);
const head = (t) => console.log('\n' + '-'.repeat(72) + '\n' + t + '\n' + '-'.repeat(72));
const exactCI = (v) => ({ $regex: '^' + String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', $options: 'i' });

/** Any doc whose guard failed was changed by someone else mid-run. Report, don't hide. */
let concurrentSkips = 0;
function reportWrites(label, c) {
    if (!APPLY) return;
    const missed = c.docs - c.matched;
    line('  written: matched=' + c.matched + ' modified=' + c.modified + ' of ' + c.docs + ' attempted');
    if (missed > 0) {
        concurrentSkips += missed;
        line('  !! ' + missed + ' ' + label + ' doc(s) were modified by someone else mid-run and were SKIPPED,');
        line('     not corrupted. Re-run the script to pick them up.');
    }
}

/**
 * Collects bulk ops and flushes them in batches, backing up pre-images first.
 *
 * Concurrency safety: the POS may be writing while this runs, and these updates use
 * positional array paths (items.3.variantValues.0.slug) derived from an earlier read.
 * If another process reordered or spliced that array, a bare { _id } filter would
 * write to the wrong element — e.g. put APPLE on a Samsung line. So every op carries
 * a `guard` asserting the document still looks exactly as it was read (item _id at
 * that index, variant entry _id at that index, target field still empty). If anything
 * moved, the filter does not match: the doc is left untouched and counted as skipped,
 * never corrupted. Re-running converges.
 */
function makeWriter(col, backup, counters) {
    let ops = [];
    let pre = [];
    return {
        add(doc, update, guard) {
            ops.push({ updateOne: { filter: { _id: doc._id, ...(guard || {}) }, update: { $set: update } } });
            pre.push(doc);
            counters.docs += 1;
            return ops.length >= BATCH ? this.flush() : Promise.resolve();
        },
        async flush() {
            if (ops.length === 0) return;
            if (APPLY) {
                for (const d of pre) backup.write(JSON.stringify({ collection: col.collectionName, doc: d }) + '\n');
                const res = await col.bulkWrite(ops, { ordered: false });
                counters.matched += res.matchedCount;
                counters.modified += res.modifiedCount;
            }
            ops = [];
            pre = [];
        }
    };
}

async function run() {
    if (!process.env.MONGODB_URI) {
        console.error('MONGODB_URI missing in .env');
        process.exit(1);
    }
    await mongoose.connect(process.env.MONGODB_URI);

    const dbName = (config.tenantDbPrefix || 'tenant_') + TENANT_ID;
    const db = mongoose.connection.useDb(dbName, { useCache: true }).db;

    line('Tenant:     ' + TENANT_ID + '  (db=' + dbName + ')');
    line('Rename:     "' + FROM_SLUG + '" -> "' + TO_SLUG + '"');
    line('Mode:       ' + (APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'));
    line('Batch size: ' + BATCH);
    line('Historical sales: ' + (INCLUDE_SALES ? 'INCLUDED (--include-sales)' : 'left untouched (immutable records)'));

    const attrsCol = db.collection('variantattributes');
    const purchasesCol = db.collection('purchases');
    const stockCol = db.collection('stock_items');
    const serialCol = db.collection('serial_index');
    const salesCol = db.collection('sales');

    // ── Pre-flight ───────────────────────────────────────────────────────────
    head('PRE-FLIGHT');
    const source = await attrsCol.findOne({ slug: FROM_SLUG });
    // Leftover DATA is what really decides whether there is work to do. The attribute may
    // already have been renamed — by an earlier partial run, or by hand in the UI — while
    // thousands of items still carry the old slug. Bailing out on the attribute alone would
    // silently leave every one of those items with an empty brand.
    const leftoverPurchases = await purchasesCol.countDocuments({ 'items.variantValues.slug': exactCI(FROM_SLUG) });
    const leftoverStock = await stockCol.countDocuments({ 'variantValues.slug': exactCI(FROM_SLUG) });

    if (!source) {
        const already = await attrsCol.findOne({ slug: TO_SLUG });
        if (!already) {
            line('ABORT: no variant attribute with slug "' + FROM_SLUG + '" or "' + TO_SLUG + '" in this tenant.');
            await mongoose.disconnect();
            process.exit(1);
        }
        if (leftoverPurchases === 0 && leftoverStock === 0) {
            line('NOTHING TO DO: "' + TO_SLUG + '" attribute exists (_id=' + already._id + ') and no document'
                + ' still carries "' + FROM_SLUG + '". Already migrated.');
            await mongoose.disconnect();
            return;
        }
        line('  attribute is already named "' + TO_SLUG + '" (_id=' + already._id + '), but '
            + leftoverPurchases + ' purchase(s) and ' + leftoverStock + ' stock row(s) still carry "'
            + FROM_SLUG + '".');
        line('  -> migrating the leftover DATA only; no rename needed.');
    } else {
        line('  source attribute: _id=' + source._id + ' name="' + source.name + '" slug="' + source.slug + '"');
    }

    const collision = source ? await attrsCol.findOne({
        _id: { $ne: source._id },
        $or: [{ slug: TO_SLUG }, { slug: TO_SLUG + 's' }, { name: exactCI(TO_NAME) }]
    }) : null;
    if (collision) {
        line('ABORT: a "' + TO_SLUG + '" attribute already exists (_id=' + collision._id + ', slug="' + collision.slug + '").');
        line('       This script renames; merging two attributes into one needs a different plan.');
        await mongoose.disconnect();
        process.exit(1);
    }
    if (source) line('  no existing "' + TO_SLUG + '" attribute — safe to rename.');

    const anchorId = source ? source._id : (await attrsCol.findOne({ slug: TO_SLUG }))._id;
    const catsUsing = await db.collection('categories')
        .find({ variantAttributes: anchorId }).project({ name: 1 }).toArray();
    line('  categories referencing it by _id (unchanged, no write needed): '
        + (catsUsing.map((c) => c.name).join(', ') || 'none'));

    // ── Backup stream ────────────────────────────────────────────────────────
    let backup = { write() {} };
    let backupFile = null;
    if (APPLY) {
        const backupDir = path.join(__dirname, 'backups');
        fs.mkdirSync(backupDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        backupFile = path.join(backupDir, FROM_SLUG + '-to-' + TO_SLUG + '-' + TENANT_ID + '-' + stamp + '.ndjson');
        backup = fs.createWriteStream(backupFile, { flags: 'a' });
        if (source) backup.write(JSON.stringify({ collection: 'variantattributes', doc: source }) + '\n');
    }

    // ── 1. Purchases (also builds the brand lookup for serial_index / sales) ─
    head('1. PURCHASES');
    const brandByItem = new Map(); // "purchaseId|itemId" -> brand value
    const previews = [];
    const pc = { docs: 0, matched: 0, modified: 0 };
    let pSlug = 0, pFilled = 0, pKept = 0, pSkipped = 0, pBlank = 0;

    const pWriter = makeWriter(purchasesCol, backup, pc);
    const pCursor = purchasesCol
        .find({ 'items.variantValues.slug': exactCI(FROM_SLUG) })
        .batchSize(BATCH);

    for await (const p of pCursor) {
        const set = {};
        const guard = {};
        (p.items || []).forEach((item, i) => {
            const vv = Array.isArray(item.variantValues) ? item.variantValues : [];
            const fromIdx = vv.findIndex((e) => isFrom(e && e.slug));
            if (fromIdx === -1) return;
            const value = String(vv[fromIdx].value || '').trim();
            const currentBrand = String(item.brand || '').trim();

            // An item already carrying a TO entry would end up with two — leave it alone.
            if (vv.some((e) => isTo(e && e.slug))) {
                pSkipped += 1;
                if (previews.length < MAX_PREVIEW) {
                    previews.push('  ' + p.purchaseNumber + ' | model=' + JSON.stringify(item.brandModel || '')
                        + ' | SKIPPED — already has a "' + TO_SLUG + '" entry');
                }
                if (value && item._id) brandByItem.set(String(p._id) + '|' + String(item._id), value);
                return;
            }

            set['items.' + i + '.variantValues.' + fromIdx + '.slug'] = TO_SLUG;
            pSlug += 1;

            // Pin the exact item and the exact variant entry we read at these indices.
            guard['items.' + i + '._id'] = item._id;
            guard['items.' + i + '.variantValues.' + fromIdx + '._id'] = vv[fromIdx]._id;

            let note;
            if (!currentBrand && value) {
                set['items.' + i + '.brand'] = value;
                // Only fill brand if it is still empty — never clobber a concurrent write.
                guard['items.' + i + '.brand'] = { $in: ['', null] };
                pFilled += 1;
                note = 'brand: "" -> ' + JSON.stringify(value);
            } else if (currentBrand) {
                pKept += 1;
                note = 'brand: ' + JSON.stringify(currentBrand) + ' KEPT (not overwritten with ' + JSON.stringify(value) + ')';
            } else {
                pBlank += 1;
                note = 'brand: left empty (variant value was blank)';
            }
            if (previews.length < MAX_PREVIEW) {
                previews.push('  ' + p.purchaseNumber + ' | model=' + JSON.stringify(item.brandModel || '')
                    + ' | slug "' + FROM_SLUG + '" -> "' + TO_SLUG + '" | ' + note);
            }
            if (value && item._id) brandByItem.set(String(p._id) + '|' + String(item._id), value);
        });
        if (Object.keys(set).length > 0) await pWriter.add(p, set, guard);
    }
    await pWriter.flush();

    line('  purchases to update:       ' + pc.docs);
    line('  item slug rewrites:        ' + pSlug);
    line('  items.brand filled:        ' + pFilled);
    line('  items.brand already set:   ' + pKept + ' (kept)');
    line('  items with blank value:    ' + pBlank);
    line('  items skipped (had "' + TO_SLUG + '"): ' + pSkipped);
    reportWrites('purchase', pc);

    // ── 2. stock_items ───────────────────────────────────────────────────────
    head('2. STOCK_ITEMS (denormalized search index)');
    const sc = { docs: 0, matched: 0, modified: 0 };
    let sSlug = 0, sFilled = 0, sKept = 0;
    const sWriter = makeWriter(stockCol, backup, sc);
    const sCursor = stockCol.find({ 'variantValues.slug': exactCI(FROM_SLUG) }).batchSize(BATCH);

    for await (const r of sCursor) {
        const vv = Array.isArray(r.variantValues) ? r.variantValues : [];
        const fromIdx = vv.findIndex((e) => isFrom(e && e.slug));
        if (fromIdx === -1) continue;
        if (vv.some((e) => isTo(e && e.slug))) continue;
        const value = String(vv[fromIdx].value || '').trim();
        const set = { ['variantValues.' + fromIdx + '.slug']: TO_SLUG };
        sSlug += 1;
        // stock_items variant entries have _id disabled, so pin the slot by its content.
        const guard = {
            ['variantValues.' + fromIdx + '.slug']: exactCI(FROM_SLUG),
            ['variantValues.' + fromIdx + '.value']: vv[fromIdx].value
        };
        const currentBrand = String(r.brand || '').trim();
        if (!currentBrand && value) {
            set.brand = value;
            guard.brand = { $in: ['', null] };
            sFilled += 1;
        } else if (currentBrand) { sKept += 1; }
        await sWriter.add(r, set, guard);
    }
    await sWriter.flush();

    line('  rows to update:            ' + sc.docs);
    line('  slug rewrites:             ' + sSlug);
    line('  brand filled:              ' + sFilled);
    line('  brand already set:         ' + sKept + ' (kept)');
    line('  status / saleId / searchText: untouched');
    reportWrites('stock_items', sc);

    // ── 3. serial_index (derived projection — must track Purchase) ───────────
    head('3. SERIAL_INDEX (derived projection of Purchase)');
    const ic = { docs: 0, matched: 0, modified: 0 };
    let iFilled = 0, iNoLink = 0;
    const iWriter = makeWriter(serialCol, backup, ic);
    const iCursor = serialCol
        .find({ $or: [{ brandSnapshot: '' }, { brandSnapshot: null }, { brandSnapshot: { $exists: false } }] })
        .batchSize(BATCH);

    for await (const r of iCursor) {
        if (!r.purchaseId || !r.purchaseItemId) { iNoLink += 1; continue; }
        const brand = brandByItem.get(String(r.purchaseId) + '|' + String(r.purchaseItemId));
        if (!brand) { iNoLink += 1; continue; }
        iFilled += 1;
        await iWriter.add(r, { brandSnapshot: brand }, { brandSnapshot: { $in: ['', null] } });
    }
    await iWriter.flush();

    line('  brandSnapshot filled:      ' + iFilled);
    line('  left empty (no purchase link / no value): ' + iNoLink);
    line('  note: find-in-stock composes the name as brand + model + capacity + colour,');
    line('        so POS serial scans will now show the brand — matching other tenants.');
    reportWrites('serial_index', ic);

    // ── 4. sales — opt-in only ───────────────────────────────────────────────
    const lc = { docs: 0, matched: 0, modified: 0 };
    let lFilled = 0, lNoLink = 0;
    if (INCLUDE_SALES) {
        head('4. SALES line snapshots (--include-sales)');
        const lWriter = makeWriter(salesCol, backup, lc);
        const lCursor = salesCol.find({ 'items.brand': { $in: ['', null] } }).batchSize(BATCH);
        for await (const s of lCursor) {
            const set = {};
            const guard = {};
            (s.items || []).forEach((item, i) => {
                if (String(item.brand || '').trim()) return;
                if (!item.purchaseId || !item.purchaseItemId) { lNoLink += 1; return; }
                const brand = brandByItem.get(String(item.purchaseId) + '|' + String(item.purchaseItemId));
                if (!brand) { lNoLink += 1; return; }
                set['items.' + i + '.brand'] = brand;
                guard['items.' + i + '._id'] = item._id;
                guard['items.' + i + '.brand'] = { $in: ['', null] };
                lFilled += 1;
            });
            if (Object.keys(set).length > 0) await lWriter.add(s, set, guard);
        }
        await lWriter.flush();
        line('  sales to update:           ' + lc.docs);
        line('  lines filled:              ' + lFilled);
        line('  lines left empty:          ' + lNoLink);
        reportWrites('sales', lc);
    } else {
        head('4. SALES — left untouched (by design)');
        line('  A completed sale is an immutable transactional snapshot, so historical');
        line('  invoices keep printing exactly as they were issued. New sales pick the');
        line('  brand up automatically once purchases carry it.');
        line('  Pass --include-sales only if the shop wants old receipts reprinted with brand.');
        line('  Audit history (auditevents / auditlogs) is never rewritten.');
    }

    // ── Preview ──────────────────────────────────────────────────────────────
    head('SAMPLE (first ' + MAX_PREVIEW + ' affected purchase items, actual decision shown)');
    for (const pv of previews) line(pv);
    if (pSlug + pSkipped > previews.length) line('  ... and ' + (pSlug + pSkipped - previews.length) + ' more');

    if (!APPLY) {
        head('DRY-RUN COMPLETE — nothing was written. Re-run with --apply to write.');
        await mongoose.disconnect();
        return;
    }

    // ── Attribute rename last: purchases/stock now already speak the new slug ─
    head('ATTRIBUTE RENAME');
    if (source) {
        const attrRes = await attrsCol.updateOne({ _id: source._id }, { $set: { name: TO_NAME, slug: TO_SLUG } });
        line('  matched=' + attrRes.matchedCount + ' modified=' + attrRes.modifiedCount);
    } else {
        line('  skipped — attribute was already named "' + TO_SLUG + '".');
    }

    await new Promise((resolve) => backup.end(resolve));
    line('  backup: ' + backupFile);

    // ── Verify ───────────────────────────────────────────────────────────────
    head('VERIFY');
    const skipNote = pSkipped > 0 ? '   (expect the ' + pSkipped + ' deliberately skipped item(s))' : '   (expect 0)';
    const countItems = async (col, match) => {
        const r = await col.aggregate([{ $unwind: '$items' }, { $match: match }, { $count: 'n' }]).toArray();
        return (r[0] && r[0].n) || 0;
    };
    line('  attributes still slug "' + FROM_SLUG + '":  ' + await attrsCol.countDocuments({ slug: FROM_SLUG }) + '   (expect 0)');
    line('  attributes with slug "' + TO_SLUG + '":    ' + await attrsCol.countDocuments({ slug: TO_SLUG }) + '   (expect 1)');
    line('  purchases still carrying it:      ' + await purchasesCol.countDocuments({ 'items.variantValues.slug': exactCI(FROM_SLUG) }) + skipNote);
    line('  stock rows still carrying it:     ' + await stockCol.countDocuments({ 'variantValues.slug': exactCI(FROM_SLUG) }) + skipNote);
    line('  purchase items with brand set:    ' + await countItems(purchasesCol, { 'items.brand': { $nin: ['', null] } }));
    line('  stock rows with brand set:        ' + await stockCol.countDocuments({ brand: { $nin: ['', null] } }));
    line('  serial_index with brandSnapshot:  ' + await serialCol.countDocuments({ brandSnapshot: { $nin: ['', null] } }));
    line('  sale lines with brand set:        ' + await countItems(salesCol, { 'items.brand': { $nin: ['', null] } })
        + (INCLUDE_SALES ? '' : '   (unchanged by design)'));

    if (pc.docs + sc.docs + ic.docs + lc.docs === 0) {
        head('NO CHANGES NEEDED');
        line('  Every document already had the "' + TO_SLUG + '" slug and a brand where one could');
        line('  be resolved. Any document still listed as carrying "' + FROM_SLUG + '" below is one');
        line('  this script intentionally leaves alone (it already has a "' + TO_SLUG + '" entry).');
    }

    if (concurrentSkips > 0) {
        head('ACTION NEEDED');
        line('  ' + concurrentSkips + ' document(s) changed underneath this run and were skipped rather than');
        line('  written with stale array positions. No data was corrupted. Re-run the same');
        line('  command to migrate them; it is idempotent.');
    }

    head('DONE');
    line('  This wrote straight to Mongo, so the running API still holds cached reads.');
    line('  Restart the API for an immediate effect, or wait for these to age out:');
    line('    variantAttributes:list   in-process SWR maxStale 10 min / Redis TTL.CATALOG 10 min');
    line('    purchases + stock list   in-process SWR maxStale 10 min');
    line('    serial lookups (Redis)   10 min in_stock/sold, 45 s not_found');
    line('  Nothing needs a manual cache bump — every TTL above is <= 10 minutes.');
    await mongoose.disconnect();
}

run().catch((e) => { console.error(e); process.exit(1); });
