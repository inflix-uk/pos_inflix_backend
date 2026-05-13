const mongoose = require('mongoose');

const subCategorySchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'Sub-category name is required'],
        trim: true,
        maxlength: [50, 'Sub-category name cannot exceed 50 characters']
    },
    slug: {
        type: String,
        unique: true,
        sparse: true,
        trim: true,
        lowercase: true
    },
    category: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Category',
        required: [true, 'Category is required']
    },
    code: {
        type: String,
        unique: true,
        sparse: true,
        trim: true,
        uppercase: true
    },
    description: {
        type: String,
        maxlength: [200, 'Description cannot exceed 200 characters']
    },
    image: {
        type: String
    },
    isActive: {
        type: Boolean,
        default: true
    }
}, {
    timestamps: true
});

// Index for faster queries (code and slug already indexed via unique: true)
subCategorySchema.index({ category: 1, name: 1 });

module.exports = require('../lib/tenantModel')('SubCategory', subCategorySchema);
