const mongoose = require('mongoose');

const receiptPrinterSalesPrintSchema = new mongoose.Schema({
    showLogo: { type: Boolean, default: true },
    /** @deprecated Use showShopName + showShopAddress; kept for legacy API documents */
    showShopHeader: { type: Boolean, default: true },
    showShopName: { type: Boolean, default: true },
    showShopAddress: { type: Boolean, default: true },
    showReceiptTitle: { type: Boolean, default: true },
    showReferenceAndDate: { type: Boolean, default: true },
    showCustomerNameAndAddress: { type: Boolean, default: true },
    showCustomerPhone: { type: Boolean, default: true },
    showCustomerEmail: { type: Boolean, default: true },
    showLocationPhone: { type: Boolean, default: true },
    showLocationEmail: { type: Boolean, default: true },
    showLineItems: { type: Boolean, default: true },
    showItemSerials: { type: Boolean, default: true },
    showTotal: { type: Boolean, default: true },
    showTermsText: { type: Boolean, default: true },
    showThankYou: { type: Boolean, default: true },
    /** ESC/POS: pulse drawer when sale has cash payment (retail cash or wholesale payments.cash > 0). */
    openCashDrawerOnCashPayment: { type: Boolean, default: true },
    /** 0 = drawer pin 2 (default); 1 = pin 5 on some Epson/Star models. */
    cashDrawerPin: { type: Number, default: 0, min: 0, max: 1 },
    sectionOrder: [{ type: String }],
    paperWidthMm: { type: Number, default: 80, min: 58, max: 80 },
    sideMarginMm: { type: Number, default: 4, min: 2, max: 8 },
    fontHeadingPt: { type: Number, default: 12, min: 9, max: 16 },
    fontBodyPt: { type: Number, default: 8, min: 6, max: 11 },
    fontSmallPt: { type: Number, default: 7, min: 6, max: 10 },
    fontLineItemPt: { type: Number, default: 9, min: 7, max: 12 },
    /** PDF 80mm: QR encoding sale reference (INV-…); not on silent ESC/POS bitmap path */
    showReceiptReferenceQr: { type: Boolean, default: true },
    receiptReferenceQrSizeMm: { type: Number, default: 22, min: 14, max: 30 },
    sectionFontPt: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { _id: false });

const receiptPrinterRepairPrintSchema = new mongoose.Schema({
    showLogo: { type: Boolean, default: true },
    showShopHeader: { type: Boolean, default: true },
    showShopName: { type: Boolean, default: true },
    showShopAddress: { type: Boolean, default: true },
    showTicketTitle: { type: Boolean, default: true },
    showQrCode: { type: Boolean, default: true },
    showReferenceLine: { type: Boolean, default: true },
    showDate: { type: Boolean, default: true },
    showCustomerName: { type: Boolean, default: true },
    showContactPhone: { type: Boolean, default: true },
    showContactEmail: { type: Boolean, default: true },
    showDeviceDescription: { type: Boolean, default: true },
    showSerialNumber: { type: Boolean, default: true },
    showDevicePassword: { type: Boolean, default: false },
    showProblemType: { type: Boolean, default: true },
    showEstimatedCost: { type: Boolean, default: true },
    showRepairItems: { type: Boolean, default: true },
    showActualCost: { type: Boolean, default: true },
    showStatus: { type: Boolean, default: true },
    showNotes: { type: Boolean, default: false },
    showTermsText: { type: Boolean, default: true },
    showThankYou: { type: Boolean, default: true },
    showLocationPhone: { type: Boolean, default: true },
    showLocationEmail: { type: Boolean, default: true },
    sectionOrder: [{ type: String }],
    paperWidthMm: { type: Number, default: 80, min: 58, max: 80 },
    sideMarginMm: { type: Number, default: 4, min: 2, max: 8 },
    fontHeadingPt: { type: Number, default: 12, min: 9, max: 16 },
    fontBodyPt: { type: Number, default: 8, min: 6, max: 11 },
    fontSmallPt: { type: Number, default: 7, min: 6, max: 10 },
    qrSizeMm: { type: Number, default: 22, min: 14, max: 30 },
    sectionFontPt: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { _id: false });

const repairLabelPrintSchema = new mongoose.Schema({
    labelWidthMm: { type: Number, default: 57, min: 30, max: 120 },
    labelHeightMm: { type: Number, default: 32, min: 15, max: 100 },
    fontSizePt: { type: Number, default: 7, min: 4, max: 14 },
    lineHeightMm: { type: Number, default: 3.9, min: 2.5, max: 10 },
    qrSizeMm: { type: Number, default: 16.5, min: 8, max: 35 },
    qrPosition: { type: String, enum: ['left', 'right'], default: 'left' },
    textAlign: { type: String, enum: ['left', 'center', 'right'], default: 'left' },
    showQr: { type: Boolean, default: true },
    showReferenceText: { type: Boolean, default: false },
    showCustomerName: { type: Boolean, default: true },
    showContactPhone: { type: Boolean, default: true },
    showContactEmail: { type: Boolean, default: false },
    showDeviceDescription: { type: Boolean, default: true },
    showProblemType: { type: Boolean, default: true },
    showSerialNumber: { type: Boolean, default: false },
    showEstimatedCost: { type: Boolean, default: false },
    maxProblemLines: { type: Number, default: 2, min: 1, max: 6 },
    /** Flip Sumatra silent print portrait/landscape; PDF and browser print unchanged */
    invertSilentPrintOrientation: { type: Boolean, default: false },
    silentPrintLayoutMode: { type: String, enum: ['same_as_pdf', 'swap_columns'], default: 'same_as_pdf' },
    textFieldOrder: [{ type: String }],
    fieldFontPt: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { _id: false });

const invoicePdfPrintSchema = new mongoose.Schema({
    showLogo: { type: Boolean, default: true },
    /** Company / branch name in header and FROM (About app name or location name). */
    showCompanyName: { type: Boolean, default: true },
    showBillTo: { type: Boolean, default: true },
    showItemsSummary: { type: Boolean, default: true },
    showSerialDetails: { type: Boolean, default: true },
    showInvoiceSummary: { type: Boolean, default: true },
    showAccountSummary: { type: Boolean, default: true },
    showPayments: { type: Boolean, default: true },
    showPdfSalesTerms: { type: Boolean, default: true },
    showPaymentNote: { type: Boolean, default: true },
    showBankDetails: { type: Boolean, default: true },
    marginMm: { type: Number, default: 18, min: 12, max: 24 },
    fontCompanyNamePt: { type: Number, default: 18, min: 14, max: 24 },
    fontDocTitlePt: { type: Number, default: 14, min: 11, max: 20 },
    fontSectionHeadingPt: { type: Number, default: 10, min: 8, max: 14 },
    fontBodyPt: { type: Number, default: 10, min: 8, max: 13 },
    fontTablePt: { type: Number, default: 8, min: 7, max: 11 },
    fontTermsPt: { type: Number, default: 8, min: 7, max: 11 },
    logoWidthMm: { type: Number, default: 32, min: 20, max: 45 },
    logoHeightMm: { type: Number, default: 13, min: 8, max: 22 },
    showInvoiceReferenceQr: { type: Boolean, default: true },
    invoiceReferenceQrSizeMm: { type: Number, default: 22, min: 16, max: 32 },
    /** Business invoice PDF title (e.g. INVOICE, TAX INVOICE). Dispatch template ignores this. */
    documentTitle: { type: String, trim: true, maxlength: 80, default: 'INVOICE' },
    /** Business invoice only — shown when set in Settings → About */
    showCompanyNumber: { type: Boolean, default: true },
    showVatNumber: { type: Boolean, default: true },
    showFooterLegalLine: { type: Boolean, default: true },
    /** Business invoice: VAT / tax lines from Settings → Tax and sale.tax */
    showTax: { type: Boolean, default: true }
}, { _id: false });

const defaultTerms = `*30 Days Limited Warranty

All Stock is Tested by Professionals

Warranty void if the attempted to temper or disassembled

Warranty void if damaged or broken`;

const notesTermsSettingsSchema = new mongoose.Schema({
    deliveryAddress: {
        type: String,
        trim: true,
        maxlength: [1000, 'Delivery address cannot exceed 1000 characters'],
        default: ''
    },
    purchaseTermsConditions: {
        type: String,
        trim: true,
        maxlength: [5000, 'Purchase terms cannot exceed 5000 characters'],
        default: defaultTerms
    },
    pdfSalesTerms: {
        type: String,
        trim: true,
        maxlength: [5000, 'PDF sales terms cannot exceed 5000 characters'],
        default: defaultTerms
    },
    receiptPrinterSalesTerms: {
        type: String,
        trim: true,
        maxlength: [2000, 'Receipt printer sales terms cannot exceed 2000 characters'],
        default: ''
    },
    receiptPrinterRepairTerms: {
        type: String,
        trim: true,
        maxlength: [2000, 'Receipt printer repair terms cannot exceed 2000 characters'],
        default: ''
    },
    receiptPrinterSalesPrint: {
        type: receiptPrinterSalesPrintSchema,
        default: undefined
    },
    receiptPrinterRepairPrint: {
        type: receiptPrinterRepairPrintSchema,
        default: undefined
    },
    paymentNote: {
        type: String,
        trim: true,
        maxlength: [2000, 'Payment note cannot exceed 2000 characters'],
        default: ''
    },
    repairLabelPrint: {
        type: repairLabelPrintSchema,
        default: undefined
    },
    invoicePdfPrint: {
        type: invoicePdfPrintSchema,
        default: undefined
    },
    businessInvoicePdfPrint: {
        type: invoicePdfPrintSchema,
        default: undefined
    },
    businessInvoiceTerms: {
        type: String,
        trim: true,
        maxlength: [5000, 'Business invoice terms cannot exceed 5000 characters'],
        default: ''
    },
    /** Which A4 PDF layout is used when printing/downloading from sales (dispatch vs business). */
    a4InvoiceTemplate: {
        type: String,
        enum: ['dispatch', 'business'],
        default: 'dispatch'
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
notesTermsSettingsSchema.statics.getSettings = async function() {
    let settings = await this.findOne();
    if (!settings) {
        settings = await this.create({});
    }
    return settings;
};

module.exports = require('../lib/tenantModel')('NotesTermsSettings', notesTermsSettingsSchema);
