const mongoose = require('mongoose');

const supplierSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'Supplier name is required'],
        trim: true,
        maxlength: [100, 'Name cannot exceed 100 characters']
    },
    email: {
        type: String,
        lowercase: true,
        match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Please enter a valid email']
    },
    phone: {
        type: String,
        required: [true, 'Phone number is required'],
        trim: true
    },
    address: {
        street: String,
        addressLine2: String,
        city: String,
        state: String,
        zipCode: String,
        country: { type: String, default: 'United Kingdom' }
    },
    contactPerson: {
        type: String,
        trim: true
    },
    companyNumber: { type: String, trim: true },
    mobile: { type: String, trim: true },
    vatNumber: { type: String, trim: true },
    currency: { type: String, trim: true, default: 'GBP' },
    isActive: {
        type: Boolean,
        default: true
    }
}, {
    timestamps: true
});

// Used by getSuppliers (list page + create-sales account dropdown).
supplierSchema.index({ isActive: 1, createdAt: -1 });
supplierSchema.index({ name: 1 });

module.exports = require('../lib/tenantModel')('Supplier', supplierSchema);
