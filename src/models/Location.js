const mongoose = require('mongoose');

const locationSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'Location name is required'],
        trim: true,
        maxlength: [100, 'Location name cannot exceed 100 characters']
    },
    type: {
        type: String,
        enum: ['store', 'warehouse'],
        default: 'store',
        trim: true
    },
    contactPerson: {
        type: String,
        trim: true,
        maxlength: [100, 'Contact person name cannot exceed 100 characters']
    },
    phone: {
        type: String,
        trim: true,
        maxlength: [20, 'Phone number cannot exceed 20 characters']
    },
    email: {
        type: String,
        trim: true,
        lowercase: true,
        match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Please enter a valid email']
    },
    address: {
        type: String,
        trim: true,
        maxlength: [500, 'Address cannot exceed 500 characters']
    },
    city: {
        type: String,
        trim: true,
        maxlength: [100, 'City cannot exceed 100 characters']
    },
    postcode: {
        type: String,
        trim: true,
        maxlength: [20, 'Postcode cannot exceed 20 characters']
    },
    country: {
        type: String,
        trim: true,
        maxlength: [100, 'Country cannot exceed 100 characters']
    },
    companyNumber: {
        type: String,
        trim: true,
        maxlength: [50, 'Company number cannot exceed 50 characters']
    },
    vatNumber: {
        type: String,
        trim: true,
        maxlength: [50, 'VAT number cannot exceed 50 characters']
    },
    isActive: {
        type: Boolean,
        default: true
    },
    /** Tenant identity for SaaS; source of truth for scoping and usage counts. */
    tenantId: { type: String, required: true, default: 'default', trim: true, maxlength: [128, 'Tenant ID cannot exceed 128 characters'] }
}, {
    timestamps: true
});

locationSchema.index({ name: 1 });
locationSchema.index({ tenantId: 1, isActive: 1 });
locationSchema.index({ type: 1 });
locationSchema.index({ isActive: 1 });
locationSchema.index({ city: 1 });


module.exports = require('../lib/tenantModel')('Location', locationSchema);
