const NotesTermsSettings = require('../models/NotesTermsSettings');
const asyncHandler = require('../middleware/asyncHandler');
const { getTenantIdFromReq } = require('../middleware/auth');
const cache = require('../lib/cache');
const TTL = require('../lib/cacheTTL');

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
        data: settings
    });
});

// @desc    Create or Update notes & terms settings
// @route   POST /api/settings/notes-terms
// @access  Private/Admin/Manager
exports.saveNotesTermsSettings = asyncHandler(async (req, res) => {
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
    } = req.body;

    // Check if settings exist
    let settings = await NotesTermsSettings.findOne();

    if (settings) {
        // Update existing settings
        settings = await NotesTermsSettings.findByIdAndUpdate(
            settings._id,
            {
                deliveryAddress,
                purchaseTermsConditions,
                pdfSalesTerms,
                receiptPrinterSalesTerms,
                receiptPrinterRepairTerms,
                paymentNote,
                ...(repairLabelPrint !== undefined ? { repairLabelPrint } : {}),
                ...(receiptPrinterSalesPrint !== undefined ? { receiptPrinterSalesPrint } : {}),
                ...(receiptPrinterRepairPrint !== undefined ? { receiptPrinterRepairPrint } : {}),
                ...(invoicePdfPrint !== undefined ? { invoicePdfPrint } : {}),
                ...(businessInvoicePdfPrint !== undefined ? { businessInvoicePdfPrint } : {}),
                ...(businessInvoiceTerms !== undefined ? { businessInvoiceTerms } : {}),
                ...(a4InvoiceTemplate !== undefined ? { a4InvoiceTemplate } : {}),
                updatedBy: req.user._id
            },
            {
                new: true,
                runValidators: true
            }
        );

        await invalidateNotesTermsCache(getTenantIdFromReq(req));
        res.status(200).json({
            success: true,
            message: 'Notes & Terms settings updated successfully',
            data: settings
        });
    } else {
        // Create new settings
        settings = await NotesTermsSettings.create({
            deliveryAddress,
            purchaseTermsConditions,
            pdfSalesTerms,
            receiptPrinterSalesTerms,
            receiptPrinterRepairTerms,
            paymentNote,
            ...(repairLabelPrint !== undefined ? { repairLabelPrint } : {}),
            ...(receiptPrinterSalesPrint !== undefined ? { receiptPrinterSalesPrint } : {}),
            ...(receiptPrinterRepairPrint !== undefined ? { receiptPrinterRepairPrint } : {}),
            ...(invoicePdfPrint !== undefined ? { invoicePdfPrint } : {}),
            ...(businessInvoicePdfPrint !== undefined ? { businessInvoicePdfPrint } : {}),
            ...(businessInvoiceTerms !== undefined ? { businessInvoiceTerms } : {}),
            ...(a4InvoiceTemplate !== undefined ? { a4InvoiceTemplate } : {}),
            createdBy: req.user._id
        });

        await invalidateNotesTermsCache(getTenantIdFromReq(req));
        res.status(201).json({
            success: true,
            message: 'Notes & Terms settings created successfully',
            data: settings
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
        data: settings
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
        data: newSettings
    });
});
