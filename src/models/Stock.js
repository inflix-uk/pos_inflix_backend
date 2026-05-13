const mongoose = require('mongoose');

const stockSchema = new mongoose.Schema({
    warehouse: {
        type: String,
        required: [true, 'Warehouse is required'],
        trim: true
    },
    store: {
        type: String,
        required: [true, 'Store is required'],
        trim: true
    },
    product: {
        name: {
            type: String,
            required: [true, 'Product name is required'],
            trim: true
        },
        icon: {
            type: String,
            default: '📦'
        }
    },
    date: {
        type: Date,
        default: Date.now
    },
    person: {
        name: {
            type: String,
            required: [true, 'Person name is required'],
            trim: true
        },
        avatar: {
            type: String,
            default: '👤'
        }
    },
    qty: {
        type: Number,
        required: [true, 'Quantity is required'],
        min: [0, 'Quantity cannot be negative'],
        default: 0
    },
    status: {
        type: String,
        enum: ['In Stock', 'Low Stock', 'Out of Stock'],
        default: 'In Stock'
    }
}, {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
});

// Index for faster queries
stockSchema.index({ warehouse: 1 });
stockSchema.index({ store: 1 });
stockSchema.index({ 'product.name': 1 });

module.exports = require('../lib/tenantModel')('Stock', stockSchema);
