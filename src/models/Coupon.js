const mongoose = require('mongoose');

const couponSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'Coupon name is required'],
        trim: true,
        maxlength: [100, 'Name cannot exceed 100 characters']
    },
    code: {
        type: String,
        required: [true, 'Coupon code is required'],
        unique: true,
        uppercase: true,
        trim: true,
        maxlength: [50, 'Code cannot exceed 50 characters']
    },
    description: {
        type: String,
        trim: true,
        maxlength: [500, 'Description cannot exceed 500 characters']
    },
    type: {
        type: String,
        enum: ['Percentage', 'Fixed Amount'],
        required: [true, 'Coupon type is required']
    },
    discount: {
        type: Number,
        required: [true, 'Discount value is required'],
        min: [0, 'Discount cannot be negative']
    },
    limit: {
        type: Number,
        default: 1,
        min: [0, 'Usage limit cannot be negative']
    },
    usedCount: {
        type: Number,
        default: 0
    },
    startDate: {
        type: Date,
        required: [true, 'Start date is required']
    },
    endDate: {
        type: Date,
        required: [true, 'End date is required']
    },
    product: {
        type: String,
        default: 'All'
    },
    oncePerCustomer: {
        type: Boolean,
        default: false
    },
    status: {
        type: String,
        enum: ['Active', 'Inactive'],
        default: 'Active'
    },
    minPurchaseAmount: {
        type: Number,
        default: 0
    },
    maxDiscountAmount: {
        type: Number,
        default: null
    }
}, {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
});

// Virtual for formatted valid date
couponSchema.virtual('valid').get(function() {
    if (this.endDate) {
        return this.endDate.toLocaleDateString('en-US', {
            day: '2-digit',
            month: 'short',
            year: 'numeric'
        });
    }
    return null;
});

// Index for faster queries (code already indexed via unique: true)
couponSchema.index({ status: 1 });
couponSchema.index({ endDate: 1 });

module.exports = require('../lib/tenantModel')('Coupon', couponSchema);
