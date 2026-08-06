/**
 * Fast serial lookup: Redis (tenant-aware) + SerialIndex, with optional legacy fallback.
 * Keeps same API contract: { serial, status, product?, soldInfo? }.
 */
const SerialIndex = require('../models/SerialIndex');
const redis = require('../lib/redis');
const { normalizeSerial } = require('../utils/serialUtil');

const TENANT_ID = redis.getTenantId();

function indexToApiStatus(status) {
    if (status === 'sold') return 'already_sold';
    return status || 'not_found';
}

function productFromIndexDoc(doc) {
    return {
        sku: doc.skuSnapshot || '',
        name: String(doc.productNameSnapshot || '').trim(),
        price: Number(doc.salePrice) || 0,
        category: String(doc.categorySnapshot || '').trim() || 'Uncategorized',
        brand: String(doc.brandSnapshot || '').trim(),
        serial: doc.serial,
        grade: String(doc.gradeSnapshot || '').trim(),
        colour: String(doc.colourSnapshot || '').trim(),
        brandModel: String(doc.brandModelSnapshot || '').trim(),
        capacity: String(doc.capacitySnapshot || '').trim(),
        purchaseId: doc.purchaseId ? doc.purchaseId.toString() : '',
        purchaseItemId: doc.purchaseItemId ? doc.purchaseItemId.toString() : '',
        purchaseDate: doc.purchaseDate ? new Date(doc.purchaseDate).toISOString() : null,
        unitCost: doc.unitCost != null ? Number(doc.unitCost) : null,
    };
}

function indexDocToResult(doc) {
    const status = indexToApiStatus(doc.status);
    const result = { serial: doc.serial, status };
    if (status === 'in_stock' && String(doc.productNameSnapshot || '').trim()) {
        result.product = productFromIndexDoc(doc);
    }
    if (status === 'already_sold' && (doc.saleReferenceSnapshot || doc.customerNameSnapshot != null)) {
        result.soldInfo = {
            reference: doc.saleReferenceSnapshot || '',
            customerName: doc.customerNameSnapshot || '',
        };
    }
    return result;
}

function variantSnapshotsFromProduct(product) {
    if (!product) {
        return {
            gradeSnapshot: '',
            colourSnapshot: '',
            brandSnapshot: '',
            brandModelSnapshot: '',
            capacitySnapshot: '',
            categorySnapshot: '',
        };
    }
    return {
        gradeSnapshot: product.grade != null ? String(product.grade).trim() : '',
        colourSnapshot: product.colour != null ? String(product.colour).trim() : '',
        brandSnapshot: product.brand != null ? String(product.brand).trim() : '',
        brandModelSnapshot: product.brandModel != null ? String(product.brandModel).trim() : '',
        capacitySnapshot: product.capacity != null ? String(product.capacity).trim() : '',
        categorySnapshot: product.category != null ? String(product.category).trim() : '',
    };
}

function toCacheValue(result) {
    return {
        serial: result.serial,
        status: result.status,
        product: result.product || undefined,
        soldInfo: result.soldInfo || undefined,
    };
}

/**
 * Lookup multiple serials. Returns { results, cacheHits, cacheMisses, dbTimeMs, totalTimeMs }.
 */
async function lookupSerials(tenantId, serials) {
    const t0 = Date.now();
    const tenant = tenantId || TENANT_ID;
    const normalized = serials.map((s) => normalizeSerial(s)).filter(Boolean);
    const unique = [...new Set(normalized)];
    if (unique.length === 0) {
        return { results: [], cacheHits: 0, cacheMisses: 0, dbTimeMs: 0, totalTimeMs: Date.now() - t0 };
    }

    const cacheValues = await redis.mget(tenant, unique);
    const results = new Array(unique.length);
    const missSerials = [];
    const missIndexes = [];
    let cacheHits = 0;
    for (let i = 0; i < unique.length; i++) {
        const serial = unique[i];
        const cached = cacheValues[i];
        if (cached && cached.status) {
            results[i] = { serial, status: cached.status, product: cached.product, soldInfo: cached.soldInfo };
            cacheHits++;
        } else {
            missSerials.push(serial);
            missIndexes.push(i);
        }
    }
    const cacheMisses = missSerials.length;

    let dbTimeMs = 0;
    if (missSerials.length > 0) {
        const tDb = Date.now();
        const docs = await SerialIndex.find({ tenantId: tenant, serial: { $in: missSerials } })
            .maxTimeMS(8000)
            .lean();
        dbTimeMs = Date.now() - tDb;
        const bySerial = {};
        docs.forEach((d) => { bySerial[d.serial] = d; });
        for (let j = 0; j < missSerials.length; j++) {
            const serial = missSerials[j];
            const idx = missIndexes[j];
            const doc = bySerial[serial];
            const result = doc ? indexDocToResult(doc) : { serial, status: 'not_found' };
            results[idx] = result;
            redis.set(tenant, serial, toCacheValue(result)).catch(() => {});
        }
    }

    const totalTimeMs = Date.now() - t0;
    return {
        results: results.filter(Boolean),
        cacheHits,
        cacheMisses,
        dbTimeMs,
        totalTimeMs,
        uniqueSerials: unique,
        resultBySerial: results.reduce((acc, r, i) => {
            if (r && unique[i]) acc[unique[i]] = r;
            return acc;
        }, {}),
    };
}

/**
 * Invalidate cache for one serial (call when serial state changes).
 */
async function invalidateSerial(tenantId, serial) {
    const s = normalizeSerial(serial);
    if (!s) return;
    await redis.invalidate(tenantId || TENANT_ID, s);
}

/** Map API status back to SerialIndex status */
function apiToIndexStatus(status) {
    if (status === 'already_sold') return 'sold';
    return status || 'not_found';
}

/**
 * Upsert SerialIndex by payload (for hooks: purchase, sale, transfer, adjustment).
 * Also updates Redis cache so next lookup is fast.
 */
async function upsertSerialIndex(tenantId, payload) {
    const tenant = tenantId || TENANT_ID;
    const serial = normalizeSerial(payload.serial);
    if (!serial) return;
    const status = payload.status || 'not_found';
    const doc = {
        tenantId: tenant,
        serial,
        status,
        productId: payload.productId ?? null,
        productNameSnapshot: payload.productNameSnapshot ?? '',
        skuSnapshot: payload.skuSnapshot ?? '',
        gradeSnapshot: payload.gradeSnapshot ?? payload.grade ?? '',
        colourSnapshot: payload.colourSnapshot ?? payload.colour ?? '',
        brandSnapshot: payload.brandSnapshot ?? payload.brand ?? '',
        brandModelSnapshot: payload.brandModelSnapshot ?? payload.brandModel ?? '',
        capacitySnapshot: payload.capacitySnapshot ?? payload.capacity ?? '',
        categorySnapshot: payload.categorySnapshot ?? payload.category ?? '',
        purchaseId: payload.purchaseId ?? null,
        purchaseItemId: payload.purchaseItemId ?? null,
        unitCost: payload.unitCost ?? null,
        salePrice: payload.salePrice ?? null,
        locationId: payload.locationId ?? null,
        saleId: payload.saleId ?? null,
        saleReferenceSnapshot: payload.saleReferenceSnapshot ?? '',
        customerNameSnapshot: payload.customerNameSnapshot ?? '',
        purchaseDate: payload.purchaseDate ? new Date(payload.purchaseDate) : null,
        updatedAt: new Date(),
    };
    await SerialIndex.findOneAndUpdate(
        { tenantId: tenant, serial },
        { $set: doc },
        { upsert: true, new: true }
    );
    const apiStatus = status === 'sold' ? 'already_sold' : status;
    const cacheVal = { serial, status: apiStatus };
    if (apiStatus === 'in_stock' && (doc.skuSnapshot || doc.productNameSnapshot)) {
        cacheVal.product = productFromIndexDoc({ ...doc, serial });
    }
    if (apiStatus === 'already_sold' && (doc.saleReferenceSnapshot || doc.customerNameSnapshot != null)) {
        cacheVal.soldInfo = { reference: doc.saleReferenceSnapshot, customerName: doc.customerNameSnapshot };
    }
    await redis.set(tenant, serial, cacheVal);
}

/**
 * Upsert SerialIndex from a single lookup result (e.g. from legacy path). Call after legacy lookup so next time is fast.
 */
async function upsertFromResult(tenantId, result) {
    const tenant = tenantId || TENANT_ID;
    const serial = normalizeSerial(result.serial);
    if (!serial) return;
    const status = apiToIndexStatus(result.status);
    const doc = {
        tenantId: tenant,
        serial,
        status,
        productNameSnapshot: result.product?.name ?? '',
        skuSnapshot: result.product?.sku ?? '',
        ...variantSnapshotsFromProduct(result.product),
        salePrice: result.product?.price ?? null,
        saleReferenceSnapshot: result.soldInfo?.reference ?? '',
        customerNameSnapshot: result.soldInfo?.customerName ?? '',
        purchaseDate: result.product?.purchaseDate ? new Date(result.product.purchaseDate) : null,
    };
    if (result.product?.purchaseId) doc.purchaseId = result.product.purchaseId;
    if (result.product?.purchaseItemId) doc.purchaseItemId = result.product.purchaseItemId;
    if (result.product) doc.unitCost = result.product.unitCost ?? null;
    await SerialIndex.findOneAndUpdate(
        { tenantId: tenant, serial },
        { $set: { ...doc, updatedAt: new Date() } },
        { upsert: true, new: true }
    );
    await redis.set(tenant, serial, toCacheValue(result));
}

module.exports = {
    lookupSerials,
    invalidateSerial,
    upsertSerialIndex,
    upsertFromResult,
    indexToApiStatus,
    normalizeSerial,
};
