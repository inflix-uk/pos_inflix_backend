const mongoose = require('mongoose');
const { formatProductName } = require('../utils/formatProductName');

const productSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'Product name is required'],
        trim: true,
        maxlength: [100, 'Product name cannot exceed 100 characters']
    },
    slug: {
        type: String,
        trim: true
    },
    sku: {
        type: String,
        required: [true, 'SKU is required'],
        unique: true,
        trim: true
    },
    barcode: {
        type: String,
        unique: true,
        sparse: true
    },
    barcodeSymbology: {
        type: String,
        default: 'code128'
    },
    description: {
        type: String,
        maxlength: [1000, 'Description cannot exceed 1000 characters']
    },
    category: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Category',
        required: [true, 'Category is required']
    },
    subCategory: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'SubCategory'
    },
    brand: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Brand'
    },
    store: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Store'
    },
    warehouse: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Warehouse'
    },
    sellingType: {
        type: String,
        enum: ['retail', 'wholesale', 'both'],
        default: 'retail'
    },
    costPrice: {
        type: Number,
        required: [true, 'Cost price is required'],
        min: [0, 'Cost price cannot be negative']
    },
    sellingPrice: {
        type: Number,
        required: [true, 'Selling price is required'],
        min: [0, 'Selling price cannot be negative']
    },
    taxType: {
        type: String,
        enum: ['inclusive', 'exclusive', 'none'],
        default: 'none'
    },
    taxRate: {
        type: Number,
        default: 0,
        min: [0, 'Tax rate cannot be negative']
    },
    discountType: {
        type: String,
        enum: ['percentage', 'fixed', 'none'],
        default: 'none'
    },
    discountValue: {
        type: Number,
        default: 0,
        min: [0, 'Discount value cannot be negative']
    },
    quantity: {
        type: Number,
        required: true,
        default: 0,
        min: [0, 'Quantity cannot be negative']
    },
    minStockLevel: {
        type: Number,
        default: 10
    },
    /** Per-product override for low-stock threshold. If null, use inventory_settings.defaultLowStockThreshold. */
    lowStockThreshold: {
        type: Number,
        default: null,
        min: 0
    },
    /** Default reorder quantity suggestion when below threshold. */
    reorderQtyDefault: {
        type: Number,
        default: null,
        min: 0
    },
    unit: {
        type: String,
        default: 'piece',
        enum: ['piece', 'kg', 'g', 'l', 'ml', 'box', 'pack']
    },
    image: {
        type: String
    },
    images: [{
        type: String
    }],
    warranty: {
        type: String
    },
    manufacturer: {
        type: String
    },
    manufacturedDate: {
        type: Date
    },
    expiryDate: {
        type: Date
    },
    isActive: {
        type: Boolean,
        default: true
    },
    supplier: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Supplier'
    },
    /** Tenant for SaaS isolation. Set from req.user.tenantId on create. */
    tenantId: { type: String, required: true, default: 'default', trim: true, maxlength: [128, 'Tenant ID cannot exceed 128 characters'] }
}, {
    timestamps: true
});

// Index for faster searches
productSchema.index({ name: 'text', sku: 'text', barcode: 'text' });
productSchema.index({ tenantId: 1 });
// Compound: covers getProducts { tenantId, isActive } sorted by createdAt
productSchema.index({ tenantId: 1, isActive: 1, createdAt: -1 });
// Compound: barcode scanner fast path — getProductByBarcode runs findOne({ tenantId, barcode, isActive })
// The text index above is NOT used for exact-match queries, so this dedicated index is required.
// Sparse: skips products with no barcode (smaller index, faster build).
productSchema.index({ tenantId: 1, barcode: 1 }, { sparse: true });
// Compound: SKU exact-match (used in fallback search and admin lookups)
productSchema.index({ tenantId: 1, sku: 1 });
// Compound: covers low-stocks filter Product.find({ isActive, category }) and any category-scoped product list.
productSchema.index({ tenantId: 1, isActive: 1, category: 1 });
// Compound: covers low-stocks supplier filter Product.find({ isActive, supplier }).
productSchema.index({ tenantId: 1, isActive: 1, supplier: 1 });

productSchema.pre('save', function (next) {
    if (this.isModified('name') && this.name) {
        this.name = formatProductName(this.name);
    }
    next();
});

module.exports = require('../lib/tenantModel')('Product', productSchema);
