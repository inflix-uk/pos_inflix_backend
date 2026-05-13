/**
 * Denormalized read-optimized stock index.
 *
 * One document per IMEI for serial items, one per non-serial purchase item.
 * Built and maintained by stockItemService from Purchase + Sale events.
 *
 * Used by:
 *   - GET /api/purchases/sales-typeahead   (POS create-sales item search)
 *   - any future fast-search needs
 *
 * NOT a source of truth — Purchase + SoldSerial remain authoritative.
 * On any inconsistency, run scripts/backfillStockItems.js to rebuild.
 */
const mongoose = require('mongoose');

const stockItemSchema = new mongoose.Schema(
    {
        tenantId: { type: String, required: true, default: 'default', index: true },

        // What it is
        isSerial: { type: Boolean, required: true, default: false },
        imei: { type: String, default: null, trim: true },
        barcode: { type: String, default: '', trim: true },
        name: { type: String, default: '', trim: true },

        // Variant attributes (denormalized from Purchase item)
        category: { type: String, default: '', trim: true },         // category NAME for fast text/regex
        categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', default: null },
        brand: { type: String, default: '', trim: true },
        brandModel: { type: String, default: '', trim: true },
        capacity: { type: String, default: '', trim: true },
        colour: { type: String, default: '', trim: true },
        grade: { type: String, default: '', trim: true },
        variantValues: [
            {
                _id: false,
                slug: { type: String, default: '' },
                value: { type: String, default: '' }
            }
        ],

        // Pricing
        salePrice: { type: Number, default: 0 },
        purchasePrice: { type: Number, default: 0 },
        currency: { type: String, default: 'GBP' },

        // For non-serial items only
        quantity: { type: Number, default: 1 },

        // Origin
        purchaseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Purchase', required: true },
        purchaseItemId: { type: mongoose.Schema.Types.ObjectId, required: true },
        inventoryDate: { type: Date, default: null },

        // Location
        sendTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },

        // Status: 'in_stock' | 'sold' | 'returned_to_supplier' | 'transferred'
        status: { type: String, default: 'in_stock', index: true },

        // When sold (for "Already sold" warnings)
        saleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Sale', default: null },
        customerName: { type: String, default: '' },
        saleReference: { type: String, default: '' },
        soldAt: { type: Date, default: null },

        // Lowercased searchable blob — concatenation of name+brand+model+barcode+capacity+colour+grade+variant values.
        // Maintained by stockItemService.buildSearchText so $regex and $text both work fast.
        searchText: { type: String, default: '', trim: true, index: true }
    },
    { timestamps: true, collection: 'stock_items' }
);

// ── Indexes ──────────────────────────────────────────────────────────────────
// Unique key: one row per IMEI per purchase item; non-serial uses imei=null with purchaseItemId for uniqueness.
stockItemSchema.index(
    { tenantId: 1, purchaseId: 1, purchaseItemId: 1, imei: 1 },
    { unique: true }
);

// Status-scoped lookups (typeahead only ever wants in_stock)
stockItemSchema.index({ tenantId: 1, status: 1, brand: 1 });
stockItemSchema.index({ tenantId: 1, status: 1, brandModel: 1 });
stockItemSchema.index({ tenantId: 1, status: 1, name: 1 });
stockItemSchema.index({ tenantId: 1, status: 1, capacity: 1 });
stockItemSchema.index({ tenantId: 1, status: 1, colour: 1 });
stockItemSchema.index({ tenantId: 1, status: 1, category: 1 });
// Sparse index for IMEI scan (only serial items have imei)
stockItemSchema.index({ tenantId: 1, imei: 1 }, { sparse: true });
// Sparse index for barcode scan
stockItemSchema.index({ tenantId: 1, status: 1, barcode: 1 }, { sparse: true });
// Recently-stocked sort for typeahead "newest first" (when no other filter narrows enough)
stockItemSchema.index({ tenantId: 1, status: 1, inventoryDate: -1 });
// Optional location filter
stockItemSchema.index({ tenantId: 1, status: 1, sendTo: 1 });

// Wildcard text index over the searchable fields with weights — used for
// natural-language queries when caller opts into $text.
stockItemSchema.index(
    {
        searchText: 'text',
        name: 'text',
        brand: 'text',
        brandModel: 'text',
        barcode: 'text',
        capacity: 'text',
        colour: 'text',
        grade: 'text',
        category: 'text'
    },
    {
        name: 'StockItem_TextIndex',
        weights: {
            barcode: 10,
            name: 8,
            brand: 6,
            brandModel: 6,
            category: 5,
            capacity: 3,
            colour: 3,
            grade: 3,
            searchText: 2
        },
        default_language: 'none'
    }
);

module.exports = require('../lib/tenantModel')('StockItem', stockItemSchema);
