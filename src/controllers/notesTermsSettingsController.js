const NotesTermsSettings = require('../models/NotesTermsSettings');
const asyncHandler = require('../middleware/asyncHandler');
const { getTenantIdFromReq } = require('../middleware/auth');
const cache = require('../lib/cache');
const TTL = require('../lib/cacheTTL');
const { normalizeBusinessInvoicePdfPrint } = require('../lib/normalizeBusinessInvoicePdfPrint');

function attachNotesTermsPayload(settings) {
    const doc = settings.toObject ? settings.toObject() : settings;
    if (doc.businessInvoicePdfPrint) {
        doc.businessInvoicePdfPrint = normalizeBusinessInvoicePdfPrint(doc.businessInvoicePdfPrint);
    }
    return doc;
}

function applyNotesTermsFields(settings, body, userId, { isCreate = false } = {}) {
    const {
        deliveryAddress,
        purchaseTermsConditions,
        pdfSalesTerms,
        receiptPrinterSalesTerms,
        receiptPrinterRepairTerms,
        receiptPrinterSalesPrint,
        receiptPrinterRepairPrint,
        paymentNote,
        repairLabelPrint,
        invoicePdfPrint,
        businessInvoicePdfPrint,
        businessInvoiceTerms,
        a4InvoiceTemplate
    } = body;

    if (deliveryAddress !== undefined) settings.deliveryAddress = deliveryAddress;
    if (purchaseTermsConditions !== undefined) settings.purchaseTermsConditions = purchaseTermsConditions;
    if (pdfSalesTerms !== undefined) settings.pdfSalesTerms = pdfSalesTerms;
    if (receiptPrinterSalesTerms !== undefined) settings.receiptPrinterSalesTerms = receiptPrinterSalesTerms;
    if (receiptPrinterRepairTerms !== undefined) settings.receiptPrinterRepairTerms = receiptPrinterRepairTerms;
    if (paymentNote !== undefined) settings.paymentNote = paymentNote;
    if (repairLabelPrint !== undefined) {
        settings.repairLabelPrint = repairLabelPrint;
        settings.markModified('repairLabelPrint');
    }
    if (receiptPrinterSalesPrint !== undefined) {
        settings.receiptPrinterSalesPrint = receiptPrinterSalesPrint;
        settings.markModified('receiptPrinterSalesPrint');
    }
    if (receiptPrinterRepairPrint !== undefined) {
        settings.receiptPrinterRepairPrint = receiptPrinterRepairPrint;
        settings.markModified('receiptPrinterRepairPrint');
    }
    if (invoicePdfPrint !== undefined) {
        settings.invoicePdfPrint = invoicePdfPrint;
        settings.markModified('invoicePdfPrint');
    }
    if (businessInvoicePdfPrint !== undefined) {
        settings.businessInvoicePdfPrint = normalizeBusinessInvoicePdfPrint(businessInvoicePdfPrint);
        settings.markModified('businessInvoicePdfPrint');
    }
    if (businessInvoiceTerms !== undefined) settings.businessInvoiceTerms = businessInvoiceTerms;
    if (a4InvoiceTemplate !== undefined) settings.a4InvoiceTemplate = a4InvoiceTemplate;

    if (isCreate) {
        settings.createdBy = userId;
    } else {
        settings.updatedBy = userId;
    }
}

const NOTES_TERMS_NS = 'settings:notesTerms';
async function invalidateNotesTermsCache(tenantId) {
    await cache.bumpNs(NOTES_TERMS_NS, tenantId);
}

// @desc    Get notes & terms settings
// @route   GET /api/settings/notes-terms
// @access  Private
exports.getNotesTermsSettings = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const settings = await cache.cached(
        { ns: NOTES_TERMS_NS, tenantId, params: {}, ttlSec: TTL.REFERENCE },
        async () => await NotesTermsSettings.getSettings()
    );

    res.status(200).json({
        success: true,
        data: attachNotesTermsPayload(settings)
    });
});

// @desc    Create or Update notes & terms settings
// @route   POST /api/settings/notes-terms
// @access  Private/Admin/Manager
exports.saveNotesTermsSettings = asyncHandler(async (req, res) => {
    let settings = await NotesTermsSettings.findOne();

    if (settings) {
        applyNotesTermsFields(settings, req.body, req.user._id);
        await settings.save();

        await invalidateNotesTermsCache(getTenantIdFromReq(req));
        res.status(200).json({
            success: true,
            message: 'Notes & Terms settings updated successfully',
            data: attachNotesTermsPayload(settings)
        });
    } else {
        settings = new NotesTermsSettings();
        applyNotesTermsFields(settings, req.body, req.user._id, { isCreate: true });
        await settings.save();

        await invalidateNotesTermsCache(getTenantIdFromReq(req));
        res.status(201).json({
            success: true,
            message: 'Notes & Terms settings created successfully',
            data: attachNotesTermsPayload(settings)
        });
    }
});

// @desc    Update notes & terms settings
// @route   PUT /api/settings/notes-terms
// @access  Private/Admin/Manager
exports.updateNotesTermsSettings = asyncHandler(async (req, res) => {
    let settings = await NotesTermsSettings.findOne();

    if (!settings) {
        return res.status(404).json({
            success: false,
            message: 'Settings not found. Please create settings first.'
        });
    }

    const updateData = { ...req.body, updatedBy: req.user._id };

    settings = await NotesTermsSettings.findByIdAndUpdate(
        settings._id,
        updateData,
        {
            new: true,
            runValidators: true
        }
    );
    await invalidateNotesTermsCache(getTenantIdFromReq(req));

    res.status(200).json({
        success: true,
        message: 'Notes & Terms settings updated successfully',
        data: attachNotesTermsPayload(settings)
    });
});

// @desc    Delete notes & terms settings (reset to defaults)
// @route   DELETE /api/settings/notes-terms
// @access  Private/Admin
exports.deleteNotesTermsSettings = asyncHandler(async (req, res) => {
    const settings = await NotesTermsSettings.findOne();

    if (!settings) {
        return res.status(404).json({
            success: false,
            message: 'Settings not found'
        });
    }

    await settings.deleteOne();

    // Create new settings with defaults
    const newSettings = await NotesTermsSettings.create({
        createdBy: req.user._id
    });
    await invalidateNotesTermsCache(getTenantIdFromReq(req));

    res.status(200).json({
        success: true,
        message: 'Notes & Terms settings reset to defaults successfully',
        data: attachNotesTermsPayload(newSettings)
    });
});
