const mongoose = require('mongoose');

const aboutSettingsSchema = new mongoose.Schema({
    appTitle: {
        type: String,
        required: [true, 'App title is required'],
        trim: true,
        maxlength: [100, 'App title cannot exceed 100 characters'],
        default: 'THANK YOU'
    },
    appName: {
        type: String,
        required: [true, 'App name is required'],
        trim: true,
        maxlength: [100, 'App name cannot exceed 100 characters'],
        default: 'THANK YOU'
    },
    logo: {
        type: String,
        default: null
    },
    loginPageTitle: {
        type: String,
        trim: true,
        maxlength: [100, 'Login page title cannot exceed 100 characters'],
        default: 'THANK YOU'
    },
    companyAddress: {
        type: String,
        trim: true,
        maxlength: [500, 'Company address cannot exceed 500 characters'],
        default: 'Manchester'
    },
    orderPdfTitle: {
        type: String,
        trim: true,
        maxlength: [100, 'Order PDF title cannot exceed 100 characters'],
        default: 'Sale Order'
    },
    invoicePdfTitle: {
        type: String,
        trim: true,
        maxlength: [100, 'Invoice PDF title cannot exceed 100 characters'],
        default: 'Dispatch Note'
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

// Ensure only one document exists (singleton pattern)
aboutSettingsSchema.statics.getSettings = async function() {
    let settings = await this.findOne();
    if (!settings) {
        settings = await this.create({});
    }
    return settings;
};

module.exports = require('../lib/tenantModel')('AboutSettings', aboutSettingsSchema);
