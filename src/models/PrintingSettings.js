const mongoose = require('mongoose');

/** Per-device printing config (deviceId from frontend localStorage). */
const printingSettingsSchema = new mongoose.Schema({
    deviceId: { type: String, required: true, unique: true, trim: true },
    silentPrintingEnabled: { type: Boolean, default: false },
    agentUrl: { type: String, default: 'http://127.0.0.1:9123', trim: true },
    agentToken: { type: String, default: '', trim: true },
    receiptPrinterName: { type: String, default: '', trim: true },
    labelPrinterName: { type: String, default: '', trim: true },
    a4PrinterName: { type: String, default: '', trim: true },
    updatedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}, { timestamps: true });

module.exports = require('../lib/tenantModel')('PrintingSettings', printingSettingsSchema);
