const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema({
    product: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Product',
        required: true
    },
    productName: {
        type: String,
        required: true
    },
    quantity: {
        type: Number,
        required: true,
        min: [1, 'Quantity must be at least 1']
    },
    unitPrice: {
        type: Number,
        required: true
    },
    discount: {
        type: Number,
        default: 0
    },
    total: {
        type: Number,
        required: true
    }
});

const orderSchema = new mongoose.Schema({
    orderNumber: {
        type: String,
        required: true,
        unique: true
    },
    customer: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Customer'
    },
    items: [orderItemSchema],
    subtotal: {
        type: Number,
        required: true
    },
    tax: {
        type: Number,
        default: 0
    },
    taxRate: {
        type: Number,
        default: 0
    },
    discount: {
        type: Number,
        default: 0
    },
    totalAmount: {
        type: Number,
        required: true
    },
    paidAmount: {
        type: Number,
        required: true
    },
    changeAmount: {
        type: Number,
        default: 0
    },
    paymentMethod: {
        type: String,
        enum: ['cash', 'card', 'mobile', 'credit'],
        default: 'cash'
    },
    paymentStatus: {
        type: String,
        enum: ['pending', 'paid', 'partial', 'refunded'],
        default: 'paid'
    },
    status: {
        type: String,
        enum: ['pending', 'completed', 'cancelled', 'refunded'],
        default: 'completed'
    },
    notes: {
        type: String
    },
    cashier: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    }
}, {
    timestamps: true
});

/** Format: ORD-000001, ORD-000002, ... (6-digit sequence) */
orderSchema.pre('save', async function(next) {
    if (this.isNew && !this.orderNumber) {
        const OrderModel = this.constructor;
        const last = await OrderModel.findOne({ orderNumber: /^ORD-\d{6}$/ })
            .sort({ orderNumber: -1 })
            .select('orderNumber')
            .lean();
        let seq = 1;
        if (last && last.orderNumber) {
            const match = last.orderNumber.match(/^ORD-(\d{6})$/);
            if (match) seq = parseInt(match[1], 10) + 1;
        }
        this.orderNumber = `ORD-${String(seq).padStart(6, '0')}`;
    }
    next();
});

module.exports = require('../lib/tenantModel')('Order', orderSchema);
