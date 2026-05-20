const Sale = require('../models/Sale');
const AboutSettings = require('../models/AboutSettings');
const NotesTermsSettings = require('../models/NotesTermsSettings');
const asyncHandler = require('../middleware/asyncHandler');
const { getTenantIdFromReq } = require('../middleware/auth');
const activityLogService = require('../services/activityLogService');
const { buildReceiptEscpos } = require('../utils/escposReceipt');
const { qrTextToEscposRaster } = require('../utils/escposGraphics');
const { mergeReceiptPrinterSalesPrint } = require('../utils/receiptPrinterPrintOptions');
const { variantAttributeSlugsOrderBySkuForSale } = require('../utils/printVariantAttributes');
const { resolveLocationForPrint, getLocationPostalBlock } = require('../utils/printLocationHelper');
const { enrichSaleWithCustomerContact } = require('../utils/enrichSaleForPrint');

// @desc    Get receipt as ESC/POS raw bytes (base64) for silent printing
// @route   GET /api/print/receipt/:saleId
// @access  Private (sale.view)
exports.getReceiptEscpos = asyncHandler(async (req, res) => {
    let sale = await Sale.findById(req.params.saleId).lean();
    if (!sale) {
        return res.status(404).json({ success: false, message: 'Sale not found' });
    }
    sale = await enrichSaleWithCustomerContact(sale);

    const [about, notesTerms, locationResult] = await Promise.all([
        AboutSettings.getSettings(),
        NotesTermsSettings.getSettings(),
        resolveLocationForPrint(sale.locationId || null)
    ]);

    let companyAddress = (about && about.companyAddress) || '';
    let locationPhone = '';
    let locationEmail = '';
    if (locationResult.location) {
        companyAddress = getLocationPostalBlock(locationResult.location);
        locationPhone = String(locationResult.location.phone || '').trim();
        locationEmail = String(locationResult.location.email || '').trim();
    } else if (locationResult.fallbackLabel) {
        companyAddress = companyAddress ? `${companyAddress}\n${locationResult.fallbackLabel}` : locationResult.fallbackLabel;
    }

    const shopDisplayName =
        (locationResult.location && String(locationResult.location.name || '').trim()) ||
        (about && String(about.appName || '').trim()) ||
        (about && String(about.appTitle || '').trim()) ||
        'Company';

    const salesPrint = mergeReceiptPrinterSalesPrint(notesTerms && notesTerms.receiptPrinterSalesPrint);
    const ref = (sale.reference || '').trim() || String(sale._id || '');

    // Logo omitted on silent ESC/POS — raster logos print as garbage on many Windows RAW drivers.
    const logoEscpos = null;

    let qrEscpos = null;
    if (salesPrint.showReceiptReferenceQr !== false && ref) {
        qrEscpos = await qrTextToEscposRaster(ref, salesPrint.receiptReferenceQrSizeMm);
    }

    const settings = {
        shopDisplayName,
        companyName: shopDisplayName,
        companyAddress,
        locationPhone,
        locationEmail,
        receiptTerms: (notesTerms && notesTerms.receiptPrinterSalesTerms) || '',
        salesPrint,
        logoEscpos,
        qrEscpos
    };

    const variantMap = await variantAttributeSlugsOrderBySkuForSale(sale, getTenantIdFromReq(req));
    const buffer = buildReceiptEscpos(sale, settings, variantMap);
    const dataBase64 = buffer.toString('base64');
    const jobName = `receipt-${(sale.reference || sale._id).toString()}`;

    await activityLogService.logFromReq(req, {
        action: 'PRINT_JOB_SENT',
        entityType: 'Sale',
        entityId: sale._id,
        success: true,
        message: `Receipt print job ${jobName}`,
        metaJson: { type: 'receipt', jobName }
    });

    res.status(200).json({
        success: true,
        dataBase64,
        jobName
    });
});

// @desc    Get sale + resolved location for invoice/receipt printing (header = location details)
// @route   GET /api/print/sale-print-context/:saleId
// @access  Private (sale.view)
exports.getSalePrintContext = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    let sale = await Sale.findById(req.params.saleId).lean();
    if (!sale) {
        return res.status(404).json({ success: false, message: 'Sale not found' });
    }
    sale = await enrichSaleWithCustomerContact(sale);
    const { location, fallbackLabel } = await resolveLocationForPrint(sale.locationId || null);

    const variantAttributeSlugsOrderBySku = await variantAttributeSlugsOrderBySkuForSale(sale, tenantId);

    res.status(200).json({
        success: true,
        data: {
            sale,
            location: location || null,
            fallbackLabel: fallbackLabel || null,
            variantAttributeSlugsOrderBySku
        }
    });
});
