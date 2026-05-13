const mongoose = require('mongoose');

const giftCardSchema = new mongoose.Schema({
    code: {
        type: String,
        required: [true, 'Gift card code is required'],
        unique: true,
        uppercase: true,
        trim: true,
        maxlength: [20, 'Code cannot exceed 20 characters']
    },
    customer: {
        name: {
            type: String,
            required: [true, 'Customer name is required'],
            trim: true
        },
        avatar: {
            type: String,
            default: 'user'
        },
        color: {
            type: String,
            default: 'bg-blue-100'
        }
    },
    issuedDate: {
        type: Date,
        required: [true, 'Issued date is required'],
        default: Date.now
    },
    expiryDate: {
        type: Date,
        required: [true, 'Expiry date is required']
    },
    amount: {
        type: Number,
        required: [true, 'Amount is required'],
        min: [0, 'Amount cannot be negative']
    },
    balance: {
        type: Number,
        required: [true, 'Balance is required'],
        min: [0, 'Balance cannot be negative']
    },
    status: {
        type: String,
        enum: ['Active', 'Redeemed', 'Expired'],
        default: 'Active'
    }
}, {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
});

// Virtual for formatted gift card code display
giftCardSchema.virtual('giftCard').get(function() {
    return this.code;
});

// Index for faster queries (code index already created by unique: true)
giftCardSchema.index({ status: 1 });
giftCardSchema.index({ expiryDate: 1 });

module.exports = require('../lib/tenantModel')('GiftCard', giftCardSchema);
