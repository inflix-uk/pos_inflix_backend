const mongoose = require('mongoose');

// Per-category values for an attribute (e.g. brands for Phones vs Laptops)
// Models can have recursive children (e.g. Condition under Model, Storage under Condition)
const categoryValueModelSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    slug: { type: String, lowercase: true },
    isActive: { type: Boolean, default: true },
    children: [] // same shape as categoryValueModelSchema - set below
}, { _id: true });
categoryValueModelSchema.add({ children: [categoryValueModelSchema] });

const categoryValueSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    slug: { type: String, lowercase: true },
    isActive: { type: Boolean, default: true },
    models: [categoryValueModelSchema]
}, { _id: true });

const categoryAttributeValuesSchema = new mongoose.Schema({
    attribute: { type: mongoose.Schema.Types.ObjectId, ref: 'VariantAttribute', required: true },
    values: [categoryValueSchema]
}, { _id: false });

const categorySchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'Category name is required'],
        unique: true,
        trim: true,
        maxlength: [50, 'Category name cannot exceed 50 characters']
    },
    slug: {
        type: String,
        unique: true,
        sparse: true,
        trim: true,
        lowercase: true
    },
    description: {
        type: String,
        maxlength: [200, 'Description cannot exceed 200 characters']
    },
    image: {
        type: String
    },
    /** Lucide icon name (e.g. Package, Smartphone) for display on category and create-sales product cards */
    icon: {
        type: String,
        trim: true
    },
    isActive: {
        type: Boolean,
        default: true
    },
    /** 'serial' = IMEI/serial items only; 'non-serial' = non-serial (e.g. accessories) only; 'both' = either */
    itemType: {
        type: String,
        enum: ['serial', 'non-serial', 'both'],
        default: 'both'
    },
    variantAttributes: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'VariantAttribute'
    }],
    // Per-category variant values: e.g. brands for Phones vs Laptops (each category has its own list)
    variantAttributeValues: [categoryAttributeValuesSchema]
}, {
    timestamps: true
});

// Covers getCategories query { isActive: true } sorted by name
categorySchema.index({ isActive: 1, name: 1 });

module.exports = require('../lib/tenantModel')('Category', categorySchema);
