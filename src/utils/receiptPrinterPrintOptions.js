/**
 * Defaults for receipt print toggles (Notes & Terms). Keep in sync with
 * pos_inflix_frontend/src/lib/receiptPrinterPrintOptions.ts
 */

const SALES_RECEIPT_SECTION_IDS = [
    'logo',
    'shop_name',
    'shop_address',
    'location_phone',
    'location_email',
    'receipt_title',
    'ref_date',
    'reference_qr',
    'customer_name_address',
    'customer_phone',
    'customer_email',
    'items',
    'total',
    'terms',
    'thank_you'
];

const SALES_SECTION_SET = new Set(SALES_RECEIPT_SECTION_IDS);

function resolveShopVisibility(p) {
    if (p.showShopHeader === false) {
        return { showShopName: false, showShopAddress: false };
    }
    return {
        showShopName: p.showShopName !== false,
        showShopAddress: p.showShopAddress !== false
    };
}

function normalizeSalesReceiptSectionOrder(input) {
    const arr = Array.isArray(input) ? input : [];
    const hadReferenceQrInInput = arr.includes('reference_qr');
    const seen = new Set();
    const out = [];
    for (const id of arr) {
        if (typeof id === 'string' && SALES_SECTION_SET.has(id) && !seen.has(id)) {
            out.push(id);
            seen.add(id);
        }
    }
    for (const id of SALES_RECEIPT_SECTION_IDS) {
        if (!seen.has(id)) {
            out.push(id);
            seen.add(id);
        }
    }
    if (!hadReferenceQrInInput) {
        const base = out.filter((id) => id !== 'reference_qr');
        const iRef = base.indexOf('ref_date');
        if (iRef !== -1) {
            base.splice(iRef + 1, 0, 'reference_qr');
            return base;
        }
    }
    return out;
}

const SALES_FONT_SIZE_KEYS = [
    'shop_name',
    'shop_address',
    'location_phone',
    'location_email',
    'receipt_title',
    'ref_date',
    'reference_qr',
    'customer_name_address',
    'customer_phone',
    'customer_email',
    'items',
    'items_serial',
    'items_qty_price',
    'total',
    'terms',
    'thank_you'
];

function clampFont(n, min, max, fb) {
    if (!Number.isFinite(n)) return fb;
    return Math.min(max, Math.max(min, n));
}

function clamp(n, min, max, fb) {
    if (!Number.isFinite(n)) return fb;
    return Math.min(max, Math.max(min, n));
}

function normalizeSalesSectionFontPt(partial) {
    if (!partial || typeof partial !== 'object') return {};
    const out = {};
    for (const key of SALES_FONT_SIZE_KEYS) {
        const v = partial[key];
        if (v == null || !Number.isFinite(Number(v))) continue;
        out[key] = clampFont(Number(v), 6, 16, 8);
    }
    return out;
}

const DEFAULT_SALES = {
    showLogo: true,
    showShopName: true,
    showShopAddress: true,
    showReceiptTitle: true,
    showReferenceAndDate: true,
    showCustomerNameAndAddress: true,
    showCustomerPhone: true,
    showCustomerEmail: true,
    showLocationPhone: true,
    showLocationEmail: true,
    showLineItems: true,
    showItemSerials: true,
    showTotal: true,
    showTermsText: true,
    showThankYou: true,
    /** Pulse cash drawer on ESC/POS when sale includes cash payment. */
    openCashDrawerOnCashPayment: true,
    /** 0 = pin 2 (most printers); 1 = pin 5 if drawer does not open on pin 0. */
    cashDrawerPin: 0,
    showReceiptReferenceQr: true,
    receiptReferenceQrSizeMm: 22,
    sectionOrder: normalizeSalesReceiptSectionOrder(null),
    paperWidthMm: 80,
    sideMarginMm: 4,
    fontHeadingPt: 12,
    fontBodyPt: 8,
    fontSmallPt: 7,
    fontLineItemPt: 9,
    sectionFontPt: {}
};

function mergeReceiptPrinterSalesPrint(partial) {
    const p = partial && typeof partial === 'object' ? partial : {};
    const shop = resolveShopVisibility(p);
    const d = DEFAULT_SALES;
    const {
        showShopHeader,
        showShopName: _sn,
        showShopAddress: _sa,
        sectionFontPt: _sfp,
        showReceiptReferenceQr: _srq,
        receiptReferenceQrSizeMm: _srqs,
        ...rest
    } = p;
    return {
        ...d,
        ...rest,
        showShopName: shop.showShopName,
        showShopAddress: shop.showShopAddress,
        sectionOrder: normalizeSalesReceiptSectionOrder(p.sectionOrder),
        sectionFontPt: normalizeSalesSectionFontPt(p.sectionFontPt),
        showReceiptReferenceQr: p.showReceiptReferenceQr !== false,
        receiptReferenceQrSizeMm: clamp(
            p.receiptReferenceQrSizeMm != null ? Number(p.receiptReferenceQrSizeMm) : d.receiptReferenceQrSizeMm,
            14,
            30,
            d.receiptReferenceQrSizeMm
        ),
        openCashDrawerOnCashPayment: p.openCashDrawerOnCashPayment !== false,
        cashDrawerPin: p.cashDrawerPin === 1 ? 1 : 0,
        paperWidthMm: clamp(p.paperWidthMm != null ? Number(p.paperWidthMm) : d.paperWidthMm, 58, 80, d.paperWidthMm),
        sideMarginMm: clamp(p.sideMarginMm != null ? Number(p.sideMarginMm) : d.sideMarginMm, 2, 8, d.sideMarginMm)
    };
}

module.exports = {
    mergeReceiptPrinterSalesPrint,
    DEFAULT_SALES,
    normalizeSalesReceiptSectionOrder
};
