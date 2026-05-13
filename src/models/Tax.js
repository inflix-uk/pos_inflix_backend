const mongoose = require('mongoose');

const taxSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'Tax name is required'],
        trim: true,
        maxlength: [100, 'Tax name cannot exceed 100 characters']
    },
    rate: {
        type: Number,
        required: [true, 'Tax rate is required'],
        min: [0, 'Tax rate cannot be negative'],
        max: [100, 'Tax rate cannot exceed 100%']
    },
    type: {
        type: String,
        enum: ['percentage', 'fixed'],
        default: 'percentage'
    },
    code: {
        type: String,
        trim: true,
        maxlength: [20, 'Tax code cannot exceed 20 characters'],
        default: ''
    },
    description: {
        type: String,
        trim: true,
        maxlength: [500, 'Description cannot exceed 500 characters'],
        default: ''
    },
    isCompound: {
        type: Boolean,
        default: false
    },
    isDefault: {
        type: Boolean,
        default: false
    },
    isActive: {
        type: Boolean,
        default: true
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    updatedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }
}, {
    timestamps: true
});

// Ensure only one default tax
taxSchema.pre('save', async function(next) {
    if (this.isDefault) {
        await this.constructor.updateMany(
            { _id: { $ne: this._id } },
            { isDefault: false }
        );
    }
    next();
});

module.exports = require('../lib/tenantModel')('Tax', taxSchema);
