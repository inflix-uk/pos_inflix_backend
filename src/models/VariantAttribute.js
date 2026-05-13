const mongoose = require('mongoose');

// Schema for models (under brand values)
const modelSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    slug: {
        type: String,
        lowercase: true
    },
    isActive: {
        type: Boolean,
        default: true
    }
}, { _id: true });

// Schema for individual values (used for brands, etc.)
const modelValueSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    slug: {
        type: String,
        lowercase: true
    },
    isActive: {
        type: Boolean,
        default: true
    },
    models: [modelSchema]
}, { _id: true });

// Generate slug for value before saving
modelValueSchema.pre('save', function(next) {
    if (this.isModified('name') || !this.slug) {
        this.slug = this.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/(^_|_$)/g, '');
    }
    next();
});

const variantAttributeSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'Name is required'],
        trim: true,
        unique: true,
        maxlength: [50, 'Name cannot exceed 50 characters']
    },
    slug: {
        type: String,
        unique: true,
        lowercase: true
    },
    values: [modelValueSchema],
    description: {
        type: String,
        maxlength: [500, 'Description cannot exceed 500 characters']
    },
    isActive: {
        type: Boolean,
        default: true
    }
}, {
    timestamps: true
});

// Generate slug from name before saving
variantAttributeSchema.pre('save', function(next) {
    if (this.isModified('name') || !this.slug) {
        this.slug = this.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/(^_|_$)/g, '');
    }
    next();
});

// Covers default sort (-createdAt) filtered by isActive — the most common list query.
variantAttributeSchema.index({ isActive: 1, createdAt: -1 });
// Covers a-z / z-a sort filtered by isActive.
variantAttributeSchema.index({ isActive: 1, name: 1 });

module.exports = require('../lib/tenantModel')('VariantAttribute', variantAttributeSchema);
