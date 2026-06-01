/**
 * Atomic sale and return operations. All writes run in a single MongoDB transaction.
 * Audit logs are written AFTER successful commit (outside the transaction) to avoid
 * logging rolled-back operations. Requires MongoDB replica set.
 */

const Sale = require('../models/Sale');
const SoldSerial = require('../models/SoldSerial');
const SerialHistory = require('../models/SerialHistory');
const SalesReturn = require('../models/SalesReturn');
const Customer = require('../models/Customer');
const LedgerEntry = require('../models/LedgerEntry');
const PaymentLedgerEntry = require('../models/PaymentLedgerEntry');
const paymentAccountService = require('./paymentAccountService');

const PAYMENT_METHOD_TO_LEDGER = { cash: 'cash', card: 'card', bank: 'bank' };
const Product = require('../models/Product');
const Purchase = require('../models/Purchase');
const { findActiveSoldSerialsAmong } = require('../utils/activeSoldSerialQueries');

const round2 = (n) => Math.round(Number(n) * 100) / 100;

const NO_IMEI_SUFFIX = '-no-imei';

/**
 * Build map: serialNumber -> { purchasePrice, purchaseId, purchaseItemId } from Purchase items (inventory COST).
 * Used for COGS: serialized items use the specific unit's cost from the parcel that received it.
 */
async function getSerialToCostMap(session, serials, tenantId) {
    const map = {};
    if (!serials || serials.length === 0) return map;
    const trimmed = [...new Set(serials.map((s) => String(s).trim()).filter(Boolean))];
    if (trimmed.length === 0) return map;
    const tid = tenantId || 'default';
    const q = Purchase.find({ tenantId: tid, 'items.imeis': { $in: trimmed } }).select('_id items.imeis items.purchasePrice items._id');
    if (session) q.session(session);
    const purchases = await q.lean();
    for (const p of purchases) {
        const purchaseId = p._id;
        for (const item of p.items || []) {
            const price = round2(Number(item.purchasePrice) || 0);
            const itemId = item._id;
            for (const imei of item.imeis || []) {
                const s = (imei && String(imei).trim()) || '';
                if (s && map[s] == null) map[s] = { purchasePrice: price, purchaseId, purchaseItemId: itemId };
            }
        }
    }
    return map;
}

/**
 * Build map: 'purchaseId-itemId' -> purchasePrice for non-serial (qty) purchase items.
 */
async function getPurchaseItemCostByKey(session, keys, tenantId) {
    const map = {};
    if (!keys || keys.length === 0) return map;
    const purchaseIds = [...new Set(keys.map((k) => k.purchaseId).filter(Boolean))];
    if (purchaseIds.length === 0) return map;
    const tid = tenantId || 'default';
    const q = Purchase.find({ tenantId: tid, _id: { $in: purchaseIds } }).select('items.purchasePrice items._id items.isOtherItem items.quantity');
    if (session) q.session(session);
    const purchases = await q.lean();
    const keySet = new Set(keys.map((k) => `${k.purchaseId}-${k.itemId}`));
    for (const p of purchases) {
        for (const item of p.items || []) {
            const k = `${p._id}-${item._id}`;
            if (keySet.has(k)) {
                map[k] = round2(Number(item.purchasePrice) || 0);
            }
        }
    }
    return map;
}

/**
 * Resolve unit_cost_at_sale from inventory (Purchase) or Product fallback. Service/repair = 0.
 * Returns { unit_cost_at_sale, cost_missing, purchaseId, purchaseItemId }.
 */
function resolveUnitCostForLine(item, serialToCostMap, purchaseItemCostByKey, productCostBySku, saleType) {
    const quantity = Math.max(1, Number(item.quantity) || 1);
    const sku = (item.sku || '').trim();
    const serialNumbers = Array.isArray(item.serialNumbers) ? item.serialNumbers.map((s) => String(s).trim()).filter(Boolean) : [];

    if (saleType === 'repair') {
        return { unit_cost_at_sale: 0, cost_missing: false, purchaseId: null, purchaseItemId: null };
    }

    if (serialNumbers.length > 0) {
        if (item.unit_cost_at_sale != null && item.purchaseId && !item.cost_missing) {
            return {
                unit_cost_at_sale: round2(Number(item.unit_cost_at_sale)),
                cost_missing: false,
                purchaseId: item.purchaseId || null,
                purchaseItemId: item.purchaseItemId || null
            };
        }
        let totalCost = 0;
        let found = 0;
        let firstPurchaseId = null;
        let firstPurchaseItemId = null;
        for (const serial of serialNumbers) {
            const info = serialToCostMap[serial];
            if (info != null) {
                totalCost += info.purchasePrice;
                found++;
                if (firstPurchaseId == null) {
                    firstPurchaseId = info.purchaseId;
                    firstPurchaseItemId = info.purchaseItemId;
                }
            }
        }
        const cost_missing = found < serialNumbers.length;
        const unit_cost_at_sale = found > 0 ? round2(totalCost / quantity) : 0;
        return {
            unit_cost_at_sale,
            cost_missing,
            purchaseId: firstPurchaseId || null,
            purchaseItemId: firstPurchaseItemId || null
        };
    }

    if (sku.endsWith(NO_IMEI_SUFFIX)) {
        const prefix = sku.slice(0, -NO_IMEI_SUFFIX.length);
        const firstDash = prefix.indexOf('-');
        if (firstDash > 0) {
            const purchaseId = prefix.slice(0, firstDash);
            const itemId = prefix.slice(firstDash + 1);
            const key = `${purchaseId}-${itemId}`;
            const cost = purchaseItemCostByKey[key];
            if (cost != null) {
                return {
                    unit_cost_at_sale: cost,
                    cost_missing: false,
                    purchaseId: purchaseId || null,
                    purchaseItemId: itemId || null
                };
            }
        }
        return {
            unit_cost_at_sale: 0,
            cost_missing: true,
            purchaseId: null,
            purchaseItemId: null
        };
    }

    const productCost = productCostBySku[sku];
    const unit_cost_at_sale = round2(Number(item.unit_cost_at_sale) ?? productCost ?? 0);
    const cost_missing = productCost == null && (unit_cost_at_sale == null || unit_cost_at_sale === 0);
    return {
        unit_cost_at_sale,
        cost_missing: !!cost_missing,
        purchaseId: null,
        purchaseItemId: null
    };
}

/** Generate next invoice reference (INV-000001, INV-000002, ...) inside transaction */
async function getNextSaleReference(session) {
    const last = await Sale.findOne({ reference: /^INV-\d{6}$/ })
        .sort({ reference: -1 })
        .select('reference')
        .session(session)
        .lean();
    let seq = 1;
    if (last && last.reference) {
        const match = last.reference.match(/^INV-(\d{6})$/);
        if (match) seq = parseInt(match[1], 10) + 1;
    }
    return `INV-${String(seq).padStart(6, '0')}`;
}

/** Decrement product quantities in bulk (one find + one bulkWrite). */
async function decrementProductQuantitiesWithSession(items, session, options = {}) {
    const { enforceNonNegative = false } = options;
    const bySku = new Map();
    // Items sold by serial number are IMEI-tracked: stock is guarded by the
    // serial-level "already sold" check, not by the product.quantity field
    // (which may legitimately be 0 even when serials are in stock).
    const serialSkus = new Set();
    for (const item of items) {
        const qty = Math.max(0, Number(item.quantity) || 0);
        if (qty === 0 || !item.sku) continue;
        const sku = String(item.sku).trim();
        // Non-serial purchase-line SKUs (`<purchaseId>-<itemId>-no-imei`) have no Product record;
        // their stock lives on Purchase.items.quantity and is decremented separately. Skip them
        // here so the missing Product doesn't trigger a bogus "Insufficient stock" error.
        if (sku.endsWith(NO_IMEI_SUFFIX)) continue;
        bySku.set(sku, (bySku.get(sku) || 0) + qty);
        if (Array.isArray(item.serialNumbers) && item.serialNumbers.length > 0) {
            serialSkus.add(sku);
        }
    }
    if (bySku.size === 0) return;
    const skus = [...bySku.keys()];
    const products = await Product.find({ sku: { $in: skus } }).session(session).select('sku quantity name').lean();
    const currentBySku = new Map(products.map((p) => [p.sku, { qty: Number(p.quantity) || 0, name: p.name || p.sku }]));
    const ops = [];
    for (const [sku, delta] of bySku) {
        const cur = currentBySku.get(sku) ?? { qty: 0, name: sku };
        const current = cur.qty;
        const newQty = Math.max(0, current - delta);
        if (enforceNonNegative && !serialSkus.has(sku) && current - delta < 0) {
            throw new Error(`Insufficient stock for "${cur.name}": has ${current}, need ${delta}`);
        }
        ops.push({
            updateOne: {
                filter: { sku },
                update: { $set: { quantity: newQty } }
            }
        });
    }
    if (ops.length > 0) {
        await Product.bulkWrite(ops, { session });
    }
}

/** Decrement purchase item quantities in bulk (one bulkWrite with arrayFilters per purchase/item). */
async function decrementPurchaseItemQuantitiesWithSession(items, session, options = {}) {
    const { enforceNonNegative = false } = options;
    const suffix = '-no-imei';
    const byKey = new Map();
    for (const item of items) {
        const soldQty = Math.max(0, Number(item.quantity) || 0);
        if (soldQty === 0 || !item.sku || typeof item.sku !== 'string') continue;
        if (!item.sku.endsWith(suffix)) continue;
        const prefix = item.sku.slice(0, -suffix.length);
        const firstDash = prefix.indexOf('-');
        if (firstDash <= 0) continue;
        const purchaseId = prefix.slice(0, firstDash);
        const itemId = prefix.slice(firstDash + 1);
        const key = `${purchaseId}\t${itemId}`;
        byKey.set(key, { purchaseId, itemId, delta: (byKey.get(key)?.delta || 0) + soldQty });
    }
    if (byKey.size === 0) return;
    const mongoose = require('mongoose');

    if (enforceNonNegative) {
        const purchaseIds = [...new Set([...byKey.values()].map((v) => v.purchaseId))]
            .map((id) => new mongoose.Types.ObjectId(id));
        const purchases = await Purchase.find({ _id: { $in: purchaseIds } })
            .session(session)
            .select('items._id items.quantity items.name items.sku')
            .lean();
        const currentByKey = new Map();
        for (const p of purchases) {
            for (const it of (p.items || [])) {
                currentByKey.set(`${p._id.toString()}\t${it._id.toString()}`, {
                    qty: Number(it.quantity) || 0,
                    name: it.name || it.sku || 'item'
                });
            }
        }
        for (const [key, { delta }] of byKey) {
            const cur = currentByKey.get(key);
            if (!cur) continue;
            if (cur.qty - delta < 0) {
                throw new Error(`Insufficient stock for "${cur.name}": has ${cur.qty}, need ${delta}`);
            }
        }
    }

    const ops = [];
    for (const { purchaseId, itemId, delta } of byKey.values()) {
        ops.push({
            updateOne: {
                filter: { _id: new mongoose.Types.ObjectId(purchaseId) },
                update: { $inc: { 'items.$[elem].quantity': -delta } },
                arrayFilters: [{ 'elem._id': new mongoose.Types.ObjectId(itemId) }]
            }
        });
    }
    if (ops.length > 0) {
        await Purchase.bulkWrite(ops, { session });
    }
}

/**
 * Create sale atomically: Sale + SoldSerials + LedgerEntries + Customer balance + SerialHistory + Product/Purchase decrements.
 * Serial numbers must not already be sold (caller should have validated; we re-check inside transaction for concurrency).
 */
async function createSaleInTransaction(session, saleData, options = {}) {
    const { userId = null, allowNegativeStock = false } = options;
    const timing = { validationMs: 0, costResolutionMs: 0, saleWriteMs: 0, ledgerMs: 0, soldSerialMs: 0, decrementMs: 0 };

    let t0 = Date.now();
    let reference;
    if (saleData.reference && typeof saleData.reference === 'string' && saleData.reference.trim()) {
        const wanted = saleData.reference.trim().toUpperCase();
        const clash = await Sale.findOne({ tenantId: saleData.tenantId, reference: wanted })
            .session(session)
            .select('_id')
            .lean();
        if (clash) {
            const err = new Error(`Invoice number "${wanted}" is already in use.`);
            err.code = 'REFERENCE_TAKEN';
            throw err;
        }
        reference = wanted;
    } else {
        reference = await getNextSaleReference(session);
    }

    const serialsToCheck = [...new Set(
        saleData.items.flatMap((item) =>
            (Array.isArray(item.serialNumbers) ? item.serialNumbers : [])
                .map((s) => (s && String(s).trim()) || '')
                .filter(Boolean)
        )
    )];
    if (serialsToCheck.length > 0) {
        const [alreadySold, returnedToSupplierHistory, returnedToSupplierSold] = await Promise.all([
            findActiveSoldSerialsAmong(serialsToCheck, session),
            SerialHistory.find({ serialNumber: { $in: serialsToCheck }, eventType: 'returned_to_supplier' }).session(session).select('serialNumber').lean(),
            SoldSerial.find({ serialNumber: { $in: serialsToCheck }, status: 'returned', returnDestination: 'return_to_supplier' }).session(session).select('serialNumber').lean()
        ]);
        if (alreadySold.length > 0) {
            const list = alreadySold.map((s) => s.serialNumber).join(', ');
            throw new Error(`Serial number(s) already sold: ${list}`);
        }
        const blocked = [...new Set([
            ...returnedToSupplierHistory.map((s) => s.serialNumber),
            ...returnedToSupplierSold.map((s) => s.serialNumber)
        ])];
        if (blocked.length > 0) {
            throw new Error(`Serial number(s) returned to supplier and not available to sell: ${blocked.join(', ')}`);
        }
    }
    // Pre-flight non-serial stock check — must run BEFORE writing the Sale doc.
    // On standalone Mongo we have no transaction, so if we save the Sale first and then
    // discover insufficient stock during decrement, the half-written Sale stays in the DB.
    // A retry with the same clientRequestId then matches the orphan via the idempotency
    // check and incorrectly returns 200 success.
    if (!allowNegativeStock) {
        const byKey = new Map();
        for (const it of (saleData.items || [])) {
            const sku = (it.sku || '').trim();
            if (!sku.endsWith(NO_IMEI_SUFFIX)) continue;
            const prefix = sku.slice(0, -NO_IMEI_SUFFIX.length);
            const firstDash = prefix.indexOf('-');
            if (firstDash <= 0) continue;
            const purchaseId = prefix.slice(0, firstDash);
            const itemId = prefix.slice(firstDash + 1);
            const qty = Math.max(0, Number(it.quantity) || 0);
            if (qty === 0) continue;
            const key = `${purchaseId}\t${itemId}`;
            const prev = byKey.get(key) || { purchaseId, itemId, name: it.name, delta: 0 };
            prev.delta += qty;
            byKey.set(key, prev);
        }
        if (byKey.size > 0) {
            const mongoose = require('mongoose');
            const purchaseIds = [...new Set([...byKey.values()].map((v) => v.purchaseId))]
                .map((id) => new mongoose.Types.ObjectId(id));
            const q = Purchase.find({ _id: { $in: purchaseIds } }).select('items._id items.quantity items.name');
            if (session) q.session(session);
            const purchases = await q.lean();
            const currentByKey = new Map();
            for (const p of purchases) {
                for (const it of (p.items || [])) {
                    currentByKey.set(`${p._id.toString()}\t${it._id.toString()}`, {
                        qty: Number(it.quantity) || 0,
                        name: it.name
                    });
                }
            }
            for (const { purchaseId, itemId, name, delta } of byKey.values()) {
                const cur = currentByKey.get(`${purchaseId}\t${itemId}`);
                const has = cur ? cur.qty : 0;
                if (has - delta < 0) {
                    throw new Error(`Insufficient stock for "${(cur && cur.name) || name || 'item'}": has ${has}, need ${delta}`);
                }
            }
        }
    }
    timing.validationMs = Date.now() - t0;

    t0 = Date.now();
    const items = saleData.items || [];
    const serialsNeedingCost = items
        .filter((i) => Array.isArray(i.serialNumbers) && i.serialNumbers.length > 0 && !(i.unit_cost_at_sale != null && i.purchaseId && !i.cost_missing))
        .flatMap((i) => i.serialNumbers.map((s) => String(s).trim()).filter(Boolean));
    const allSerials = [...new Set(serialsNeedingCost)];
    const purchaseItemKeys = [];
    for (const item of items) {
        const sku = (item.sku || '').trim();
        if (sku.endsWith(NO_IMEI_SUFFIX)) {
            const prefix = sku.slice(0, -NO_IMEI_SUFFIX.length);
            const firstDash = prefix.indexOf('-');
            if (firstDash > 0) {
                purchaseItemKeys.push({
                    purchaseId: prefix.slice(0, firstDash),
                    itemId: prefix.slice(firstDash + 1)
                });
            }
        }
    }
    const tenantId = saleData.tenantId || 'default';
    const [serialToCostMap, purchaseItemCostByKey, productCostBySku] = await Promise.all([
        allSerials.length > 0 ? getSerialToCostMap(session, allSerials, tenantId) : Promise.resolve({}),
        purchaseItemKeys.length > 0 ? getPurchaseItemCostByKey(session, purchaseItemKeys, tenantId) : Promise.resolve({}),
        (async () => {
            const skus = [...new Set(items.map((i) => (i.sku || '').trim()).filter(Boolean))];
            const out = {};
            if (skus.length > 0) {
                const q = Product.find({ tenantId, sku: { $in: skus } }).select('sku costPrice');
                if (session) q.session(session);
                const products = await q.lean();
                for (const p of products) {
                    if (p.sku) out[p.sku] = round2(Number(p.costPrice) || 0);
                }
            }
            return out;
        })()
    ]);
    const itemsWithCost = items.map((item) => {
        const resolved = resolveUnitCostForLine(
            item,
            serialToCostMap,
            purchaseItemCostByKey,
            productCostBySku,
            saleData.type || 'retail'
        );
        return {
            ...item,
            unit_cost_at_sale: resolved.unit_cost_at_sale,
            cost_missing: resolved.cost_missing,
            purchaseId: resolved.purchaseId,
            purchaseItemId: resolved.purchaseItemId
        };
    });
    timing.costResolutionMs = Date.now() - t0;

    t0 = Date.now();
    const saleDoc = new Sale({
        ...saleData,
        items: itemsWithCost,
        reference
    });
    const sale = await saleDoc.save({ session });
    timing.saleWriteMs = Date.now() - t0;

    const now = new Date();
    const refLabel = sale.reference || `Sale ${sale._id}`;

    t0 = Date.now();
    if (saleData.type === 'wholesale' && saleData.customerId) {
        const orderTotal = round2(Number(saleData.total) || 0);
        const discount = round2(Number(saleData.discount) || 0);
        const netDue = round2(orderTotal - discount);
        const paidNow = round2(
            (Number(saleData.payments?.cash) || 0) +
            (Number(saleData.payments?.card) || 0) +
            (Number(saleData.payments?.bank) || 0)
        );
        const balanceChange = round2(netDue - paidNow);
        await Customer.findByIdAndUpdate(
            saleData.customerId,
            { $inc: { balance: balanceChange } },
            { session }
        );
        if (netDue > 0) {
            await LedgerEntry.create([{
                accountType: 'customer',
                accountId: saleData.customerId,
                accountModel: 'Customer',
                type: 'sale',
                amount: netDue,
                referenceId: sale._id,
                referenceLabel: refLabel,
                date: now,
                occurredAt: now,
                createdBy: userId
            }], { session });
        }
        const cashAmt = round2(Number(saleData.payments?.cash) || 0);
        const cardAmt = round2(Number(saleData.payments?.card) || 0);
        const bankAmt = round2(Number(saleData.payments?.bank) || 0);
        if (cashAmt > 0) {
            await LedgerEntry.create([{
                accountType: 'customer',
                accountId: saleData.customerId,
                accountModel: 'Customer',
                type: 'payment_in',
                amount: round2(-cashAmt),
                referenceId: sale._id,
                referenceLabel: `${refLabel} payment`,
                date: now,
                occurredAt: now,
                paymentMethod: 'cash',
                createdBy: userId
            }], { session });
        }
        if (cardAmt > 0) {
            await LedgerEntry.create([{
                accountType: 'customer',
                accountId: saleData.customerId,
                accountModel: 'Customer',
                type: 'payment_in',
                amount: round2(-cardAmt),
                referenceId: sale._id,
                referenceLabel: `${refLabel} payment`,
                date: now,
                occurredAt: now,
                paymentMethod: 'card',
                createdBy: userId
            }], { session });
        }
        if (bankAmt > 0) {
            await LedgerEntry.create([{
                accountType: 'customer',
                accountId: saleData.customerId,
                accountModel: 'Customer',
                type: 'payment_in',
                amount: round2(-bankAmt),
                referenceId: sale._id,
                referenceLabel: `${refLabel} payment`,
                date: now,
                occurredAt: now,
                paymentMethod: 'bank',
                createdBy: userId
            }], { session });
        }
    }

    // Payment ledger (pots): IN entries for each payment method
    const locationId = sale.locationId || saleData.locationId || null;
    const occurredAt = sale.occurredAt || now;
    const paymentAccountIds = saleData.paymentAccountIds || {};
    const resolveAccount = (type) => paymentAccountIds[type] ? Promise.resolve(paymentAccountIds[type]) : paymentAccountService.getDefaultPaymentAccountId(tenantId, type === 'cash_drawer' ? 'cash_drawer' : type, locationId);
    const entries = [];
    if (saleData.type === 'wholesale' && saleData.payments) {
        const cashAmt = round2(Number(saleData.payments.cash) || 0);
        const cardAmt = round2(Number(saleData.payments.card) || 0);
        const bankAmt = round2(Number(saleData.payments.bank) || 0);
        const creditAmt = round2(Number(saleData.payments.credit) || 0);
        const [accCash, accCard, accBank, accReceivable] = await Promise.all([
            resolveAccount('cash'),
            resolveAccount('card'),
            resolveAccount('bank'),
            resolveAccount('receivable')
        ]);
        if (cashAmt > 0 && accCash) entries.push({ accountId: accCash, method: 'cash', amount: cashAmt });
        if (cardAmt > 0 && accCard) entries.push({ accountId: accCard, method: 'card', amount: cardAmt });
        if (bankAmt > 0 && accBank) entries.push({ accountId: accBank, method: 'bank', amount: bankAmt });
        if (creditAmt > 0 && accReceivable) entries.push({ accountId: accReceivable, method: 'credit', amount: creditAmt });
    } else {
        const total = round2(Number(saleData.total) || 0);
        if (total > 0) {
            const method = saleData.paymentMethod || 'cash';
            const isCredit = method === 'credit';
            const accountId = isCredit ? await resolveAccount('receivable') : await (method === 'cash' ? resolveAccount('cash') : method === 'bank' ? resolveAccount('bank') : resolveAccount('card'));
            if (accountId) entries.push({ accountId, method, amount: total });
        }
    }
    for (const e of entries) {
        await PaymentLedgerEntry.create([{
            tenantId,
            occurredAtUtc: occurredAt,
            accountId: e.accountId,
            method: e.method,
            direction: 'in',
            amount: e.amount,
            entityType: 'Sale',
            entityId: sale._id,
            locationId: locationId || undefined,
            createdByUserId: userId || undefined
        }], { session });
    }
    timing.ledgerMs = Date.now() - t0;

    t0 = Date.now();
    const soldSerialDocs = [];
    for (const item of saleData.items) {
        if (Array.isArray(item.serialNumbers) && item.serialNumbers.length > 0) {
            for (const serial of item.serialNumbers) {
                const trimmed = (serial && String(serial).trim()) || null;
                if (trimmed) {
                    soldSerialDocs.push({
                        serialNumber: trimmed,
                        saleId: sale._id,
                        soldAt: now
                    });
                }
            }
        }
    }
    if (soldSerialDocs.length > 0) {
        await SoldSerial.insertMany(soldSerialDocs, { session });
        const customerName = (sale.customerName != null && sale.customerName !== '') ? String(sale.customerName).trim() : '';
        const historyDocs = soldSerialDocs.map((d) => ({
            serialNumber: d.serialNumber,
            eventType: 'sold',
            referenceType: 'Sale',
            referenceId: sale._id,
            referenceLabel: refLabel,
            customerName
        }));
        await SerialHistory.insertMany(historyDocs, { session });
    }
    timing.soldSerialMs = Date.now() - t0;

    t0 = Date.now();
    await decrementProductQuantitiesWithSession(saleData.items, session, { enforceNonNegative: !allowNegativeStock });
    await decrementPurchaseItemQuantitiesWithSession(saleData.items, session, { enforceNonNegative: !allowNegativeStock });
    timing.decrementMs = Date.now() - t0;

    return { sale, refLabel, timing };
}

/**
 * Create sales return atomically. Double-return safety: each serial is marked returned via
 * findOneAndUpdate({ serialNumber, status: 'sold' }, ...). Only one concurrent return can win per serial.
 */
async function createSalesReturnInTransaction(session, body, options = {}) {
    const { userId = null } = options;
    const SalesReturnModel = SalesReturn;
    const DEST_TO_SERIAL = {
        restock: 'in_stock',
        damaged: 'damaged',
        refurb: 'refurb',
        return_to_supplier: 'return_to_supplier'
    };

    const customerName = (body.customerName || body.customer?.name || '').trim();
    if (!customerName) throw new Error('Customer name is required');
    if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
        throw new Error('At least one item is required');
    }

    // Resolve unit_cost_at_return and locationId from linked sale when present
    let saleLineCostBySku = {};
    let locationIdFromSale = null;
    const tenantId = body.tenantId || 'default';
    const linkedRef = (body.linkedInvoiceRef || '').trim();
    if (linkedRef) {
        const linkedSale = await Sale.findOne({ tenantId, reference: linkedRef, status: { $ne: 'voided' } }).session(session).select('items locationId').lean();
        if (linkedSale) {
            if (linkedSale.locationId) locationIdFromSale = linkedSale.locationId;
            if (Array.isArray(linkedSale.items)) {
                for (const line of linkedSale.items) {
                    const sku = (line.sku || '').trim();
                    if (sku && saleLineCostBySku[sku] == null) {
                        const v = Number(line.unit_cost_at_sale);
                        saleLineCostBySku[sku] = Number.isFinite(v) ? round2(v) : 0;
                    }
                }
            }
        }
    }
    const salesReturnLocationId = locationIdFromSale ?? (body.locationId || null);

    const items = body.items.map((it) => {
        const dest = ['restock', 'damaged', 'refurb', 'return_to_supplier'].includes(it.returnDestination) ? it.returnDestination : 'restock';
        const sku = (it.sku || '').trim();
        let costReturn = Number(it.unit_cost_at_return);
        if (!Number.isFinite(costReturn)) costReturn = saleLineCostBySku[sku] ?? 0;
        if (!Number.isFinite(costReturn)) costReturn = 0;
        return {
            product: it.product || '',
            sku,
            netUnitPrice: round2(Number(it.netUnitPrice) || 0),
            stock: Number(it.stock) || 0,
            quantity: Number(it.quantity) || 1,
            discount: round2(Number(it.discount) || 0),
            taxPercent: round2(Number(it.taxPercent) || 0),
            subtotal: round2(Number(it.subtotal) || 0),
            serialNumbers: Array.isArray(it.serialNumbers) ? it.serialNumbers.filter(Boolean) : [],
            returnDestination: dest,
            unit_cost_at_return: round2(costReturn)
        };
    });

    const total = round2(items.reduce((s, i) => s + i.subtotal, 0));
    const orderTax = round2(Number(body.orderTax) || 0);
    const discount = round2(Number(body.discount) || 0);
    const shipping = round2(Number(body.shipping) || 0);
    const grandTotal = round2(total + orderTax - discount + shipping);
    const paid = round2(Number(body.paid) || 0);
    const due = round2(grandTotal - paid);

    const salesReturn = await SalesReturnModel.create([{
        customerName,
        date: body.date ? new Date(body.date) : new Date(),
        reference: body.reference || undefined,
        linkedInvoiceRef: body.linkedInvoiceRef ? String(body.linkedInvoiceRef).trim() : undefined,
        status: body.status || 'Pending',
        paymentStatus: body.paymentStatus || 'Unpaid',
        items,
        orderTax,
        discount,
        shipping,
        total,
        paid,
        due,
        grandTotal,
        locationId: salesReturnLocationId,
        tenantId: body.tenantId || 'default'
    }], { session }).then((arr) => arr[0]);

    const returnRef = salesReturn.reference || salesReturn._id.toString();
    const doc = salesReturn.toObject();

    if (body.returnType === 'store_credit' || body.returnType === 'refund') {
        let customer = null;
        if (body.customerId) {
            customer = await Customer.findOne({ _id: body.customerId, tenantId }).session(session);
        }
        if (!customer && customerName) {
            customer = await Customer.findOne({
                tenantId,
                name: new RegExp(`^${customerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')
            }).session(session);
        }
        if (customer && grandTotal > 0) {
            const creditAmount = round2(-grandTotal);
            const label = body.returnType === 'store_credit'
                ? `Store credit - ${returnRef}`
                : `Refund (${body.refundMethod || 'cash'}) - ${returnRef}`;
            await LedgerEntry.create([{
                accountType: 'customer',
                accountId: customer._id,
                accountModel: 'Customer',
                type: 'payment_in',
                amount: creditAmount,
                referenceId: salesReturn._id,
                referenceLabel: label,
                date: new Date(),
                paymentMethod: body.returnType === 'refund' ? (body.refundMethod || 'cash') : '',
                note: body.returnType === 'store_credit' ? 'Store credit from return' : 'Refund from return',
                createdBy: userId
            }], { session });
            await Customer.findByIdAndUpdate(
                customer._id,
                { $inc: { balance: creditAmount } },
                { session }
            );
            // Refund: deduct from chosen pot (PaymentLedgerEntry OUT)
            if (body.returnType === 'refund' && body.refundAccountId) {
                const method = PAYMENT_METHOD_TO_LEDGER[body.refundMethod] || 'cash';
                await PaymentLedgerEntry.create([{
                    tenantId,
                    occurredAtUtc: new Date(),
                    accountId: body.refundAccountId,
                    method: method === 'cash' ? 'cash' : method === 'bank' ? 'bank' : 'card',
                    direction: 'out',
                    amount: round2(grandTotal),
                    entityType: 'SalesReturn',
                    entityId: salesReturn._id,
                    locationId: salesReturnLocationId || undefined,
                    createdByUserId: userId || undefined
                }], { session });
            }
        }
    }

    const now = new Date();
    const serialHistoryDocs = [];
    for (const it of doc.items || []) {
        const serials = Array.isArray(it.serialNumbers) ? it.serialNumbers.filter(Boolean) : [];
        const dest = DEST_TO_SERIAL[it.returnDestination] || 'in_stock';
        for (const serial of serials) {
            const updated = await SoldSerial.findOneAndUpdate(
                { serialNumber: serial, status: 'sold' },
                {
                    $set: {
                        status: 'returned',
                        returnDestination: dest,
                        returnedAt: now,
                        salesReturnId: salesReturn._id
                    }
                },
                { session, new: true }
            );
            if (!updated) {
                throw new Error(`Serial ${serial} cannot be returned: already returned or not found as sold`);
            }
            serialHistoryDocs.push({
                serialNumber: serial,
                eventType: 'returned',
                referenceType: 'SalesReturn',
                referenceId: salesReturn._id,
                referenceLabel: returnRef,
                returnDestination: dest
            });
            // Mark as returned to supplier in same transaction so serial is never sellable again even if purchase return fails later
            if (it.returnDestination === 'return_to_supplier') {
                serialHistoryDocs.push({
                    serialNumber: serial,
                    eventType: 'returned_to_supplier',
                    referenceType: 'SalesReturn',
                    referenceId: salesReturn._id,
                    referenceLabel: returnRef,
                    returnDestination: 'repair'
                });
            }
        }
        if (it.returnDestination === 'restock' && it.quantity > 0) {
            const sku = (it.sku || '').trim();
            if (sku) {
                await Product.findOneAndUpdate(
                    { tenantId, sku },
                    { $inc: { quantity: it.quantity } },
                    { session }
                );
            }
        }
    }

    // Return to supplier: add serials back onto the purchase so we can create a purchase return after commit
    const byPurchase = {};
    for (const it of doc.items || []) {
        if (it.returnDestination !== 'return_to_supplier') continue;
        const serials = Array.isArray(it.serialNumbers) ? it.serialNumbers.filter(Boolean) : [];
        if (serials.length === 0) continue;
        const sku = (it.sku || '').trim();
        if (!sku) continue;
        const dashIdx = sku.indexOf('-');
        if (dashIdx <= 0) continue;
        const purchaseId = sku.slice(0, dashIdx);
        const purchaseItemId = sku.slice(dashIdx + 1);
        if (!byPurchase[purchaseId]) byPurchase[purchaseId] = {};
        if (!byPurchase[purchaseId][purchaseItemId]) byPurchase[purchaseId][purchaseItemId] = [];
        byPurchase[purchaseId][purchaseItemId] = byPurchase[purchaseId][purchaseItemId].concat(serials);
    }
    for (const purchaseId of Object.keys(byPurchase)) {
        const purchase = await Purchase.findOne({ _id: purchaseId, tenantId }).session(session);
        if (!purchase || !purchase.items) continue;
        for (const [itemId, serials] of Object.entries(byPurchase[purchaseId])) {
            const item = purchase.items.id(itemId);
            if (!item || item.isOtherItem) continue;
            const toAdd = [...new Set(serials.map((s) => String(s).trim()).filter(Boolean))];
            for (const s of toAdd) {
                if (!item.imeis) item.imeis = [];
                if (!item.imeis.includes(s)) item.imeis.push(s);
            }
        }
        let totalIMEIs = 0;
        let totalOtherQuantity = 0;
        let grandTotal = 0;
        for (const it of purchase.items) {
            if (it.isOtherItem) {
                totalOtherQuantity += Number(it.quantity) || 0;
                grandTotal += (Number(it.purchasePrice) || 0) * (Number(it.quantity) || 0);
            } else {
                totalIMEIs += (it.imeis && it.imeis.length) || 0;
                grandTotal += (Number(it.purchasePrice) || 0) * ((it.imeis && it.imeis.length) || 0);
            }
        }
        purchase.totalIMEIs = totalIMEIs;
        purchase.totalOtherQuantity = totalOtherQuantity;
        purchase.grandTotal = grandTotal;
        await purchase.save({ session });
    }

    if (serialHistoryDocs.length > 0) {
        await SerialHistory.insertMany(serialHistoryDocs, { session });
    }

    return { salesReturn, doc, returnRef };
}

/**
 * Resolve unit_cost_at_sale (and cost_missing, purchaseId, purchaseItemId) for a list of sale items.
 * Used by sale update to backfill cost when missing. Pass session=null when not in a transaction.
 */
async function resolveCostsForSaleItems(items, saleType, session = null, tenantId = 'default') {
    if (!items || items.length === 0) return [];
    const tid = tenantId || 'default';
    const allSerials = [];
    const purchaseItemKeys = [];
    for (const item of items) {
        const sku = (item.sku || '').trim();
        if (Array.isArray(item.serialNumbers)) {
            for (const s of item.serialNumbers) {
                const t = (s && String(s).trim()) || '';
                if (t) allSerials.push(t);
            }
        }
        if (sku.endsWith(NO_IMEI_SUFFIX)) {
            const prefix = sku.slice(0, -NO_IMEI_SUFFIX.length);
            const firstDash = prefix.indexOf('-');
            if (firstDash > 0) {
                purchaseItemKeys.push({
                    purchaseId: prefix.slice(0, firstDash),
                    itemId: prefix.slice(firstDash + 1)
                });
            }
        }
    }
    const [serialToCostMap, purchaseItemCostByKey, productCostBySku] = await Promise.all([
        getSerialToCostMap(session, allSerials, tid),
        getPurchaseItemCostByKey(session, purchaseItemKeys, tid),
        (async () => {
            const skus = [...new Set(items.map((i) => (i.sku || '').trim()).filter(Boolean))];
            const out = {};
            if (skus.length > 0) {
                const q = Product.find({ tenantId: tid, sku: { $in: skus } }).select('sku costPrice');
                if (session) q.session(session);
                const products = await q.lean();
                for (const p of products) {
                    if (p.sku) out[p.sku] = round2(Number(p.costPrice) || 0);
                }
            }
            return out;
        })()
    ]);

    return items.map((item) => {
        const resolved = resolveUnitCostForLine(
            item,
            serialToCostMap,
            purchaseItemCostByKey,
            productCostBySku,
            saleType || 'retail'
        );
        return {
            ...item,
            unit_cost_at_sale: resolved.unit_cost_at_sale,
            cost_missing: resolved.cost_missing,
            purchaseId: resolved.purchaseId,
            purchaseItemId: resolved.purchaseItemId
        };
    });
}

module.exports = {
    createSaleInTransaction,
    createSalesReturnInTransaction,
    getNextSaleReference,
    round2,
    resolveCostsForSaleItems,
    decrementProductQuantitiesWithSession,
    decrementPurchaseItemQuantitiesWithSession
};
