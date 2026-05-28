/**
 * Merge saved business-invoice PDF options with schema defaults.
 * Preserves explicit `false` from the client (unchecked toggles).
 */
const INVOICE_PDF_PRINT_DEFAULTS = {
    showLogo: true,
    showCompanyName: true,
    showBillTo: true,
    showItemsSummary: true,
    showSerialDetails: false,
    showInvoiceSummary: true,
    showAccountSummary: true,
    showPayments: true,
    showPdfSalesTerms: true,
    showPaymentNote: true,
    showBankDetails: true,
    marginMm: 20,
    fontCompanyNamePt: 22,
    fontDocTitlePt: 20,
    fontSectionHeadingPt: 11,
    fontBodyPt: 12,
    fontTablePt: 9,
    fontTermsPt: 9,
    logoWidthMm: 32,
    logoHeightMm: 13,
    showInvoiceReferenceQr: true,
    invoiceReferenceQrSizeMm: 22,
    documentTitle: 'INVOICE',
    showCompanyNumber: true,
    showVatNumber: true,
    showFooterLegalLine: true,
    showTax: true
};

function readBool(value, defaultValue) {
    return typeof value === 'boolean' ? value : defaultValue;
}

function readNum(value, min, max, defaultValue) {
    const n = Number(value);
    if (!Number.isFinite(n)) return defaultValue;
    return Math.min(max, Math.max(min, n));
}

function normalizeBusinessInvoicePdfPrint(raw) {
    const src = raw && typeof raw.toObject === 'function' ? raw.toObject() : (raw || {});
    const d = INVOICE_PDF_PRINT_DEFAULTS;
    const title = String(src.documentTitle ?? d.documentTitle).trim();
    return {
        showLogo: readBool(src.showLogo, d.showLogo),
        showCompanyName: readBool(src.showCompanyName, d.showCompanyName),
        showBillTo: readBool(src.showBillTo, d.showBillTo),
        showItemsSummary: readBool(src.showItemsSummary, d.showItemsSummary),
        showSerialDetails: readBool(src.showSerialDetails, d.showSerialDetails),
        showInvoiceSummary: readBool(src.showInvoiceSummary, d.showInvoiceSummary),
        showAccountSummary: readBool(src.showAccountSummary, d.showAccountSummary),
        showPayments: readBool(src.showPayments, d.showPayments),
        showPdfSalesTerms: readBool(src.showPdfSalesTerms, d.showPdfSalesTerms),
        showPaymentNote: readBool(src.showPaymentNote, d.showPaymentNote),
        showBankDetails: readBool(src.showBankDetails, d.showBankDetails),
        showInvoiceReferenceQr: readBool(src.showInvoiceReferenceQr, d.showInvoiceReferenceQr),
        invoiceReferenceQrSizeMm: readNum(src.invoiceReferenceQrSizeMm, 16, 32, d.invoiceReferenceQrSizeMm),
        marginMm: readNum(src.marginMm, 12, 24, d.marginMm),
        fontCompanyNamePt: readNum(src.fontCompanyNamePt, 14, 28, d.fontCompanyNamePt),
        fontDocTitlePt: readNum(src.fontDocTitlePt, 11, 22, d.fontDocTitlePt),
        fontSectionHeadingPt: readNum(src.fontSectionHeadingPt, 8, 16, d.fontSectionHeadingPt),
        fontBodyPt: readNum(src.fontBodyPt, 8, 15, d.fontBodyPt),
        fontTablePt: readNum(src.fontTablePt, 7, 13, d.fontTablePt),
        fontTermsPt: readNum(src.fontTermsPt, 7, 13, d.fontTermsPt),
        logoWidthMm: readNum(src.logoWidthMm, 20, 45, d.logoWidthMm),
        logoHeightMm: readNum(src.logoHeightMm, 8, 22, d.logoHeightMm),
        documentTitle: title || d.documentTitle,
        showCompanyNumber: readBool(src.showCompanyNumber, d.showCompanyNumber),
        showVatNumber: readBool(src.showVatNumber, d.showVatNumber),
        showFooterLegalLine: readBool(src.showFooterLegalLine, d.showFooterLegalLine),
        showTax: readBool(src.showTax, d.showTax)
    };
}

module.exports = { normalizeBusinessInvoicePdfPrint, INVOICE_PDF_PRINT_DEFAULTS };
