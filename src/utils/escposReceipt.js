/**
 * Generate raw ESC/POS bytes for a sale receipt (80mm thermal).
 * Deterministic: same sale + settings => same bytes.
 * Commands: ESC @ init, ESC a alignment, ESC E bold, LF line feed, GS V cut.
 */
const { mergeReceiptPrinterSalesPrint } = require('./receiptPrinterPrintOptions');

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

function cmd(...bytes) {
    return Buffer.from(bytes);
}

function text(str) {
    if (str == null || str === '') return Buffer.alloc(0);
    return Buffer.from(String(str), 'utf8');
}

function line(str) {
    return Buffer.concat([text(str || ''), cmd(LF)]);
}

function alignCenter() {
    return cmd(ESC, 0x61, 1);
}

function alignLeft() {
    return cmd(ESC, 0x61, 0);
}

function boldOn() {
    return cmd(ESC, 0x45, 1);
}

function boldOff() {
    return cmd(ESC, 0x45, 0);
}

function init() {
    return cmd(ESC, 0x40); // ESC @
}

function cut() {
    return cmd(GS, 0x56, 0); // GS V 0 (full cut)
}

/** Characters per line for Font A (12×24) by paper width — matches 80mm PDF layout. */
function lineCharsForPaper(paperWidthMm) {
    const w = Number(paperWidthMm);
    if (!Number.isFinite(w) || w <= 0) return 48;
    if (w <= 58) return 32;
    if (w <= 72) return 42;
    return 48;
}

function dividerLine(cols) {
    return '-'.repeat(Math.max(8, cols));
}

function feedLines(n) {
    const count = Math.max(0, Math.min(12, n));
    const bytes = new Array(count).fill(LF);
    return cmd(...bytes);
}

/** Font A, full print area, zero left margin (80mm thermal). */
function printerInit(paperWidthMm) {
    const mm = Number(paperWidthMm) || 80;
    const printableMm = mm <= 58 ? 48 : mm <= 72 ? 64 : 72;
    const dots = Math.min(576, Math.max(384, Math.round((printableMm / 25.4) * 203)));
    const nL = dots & 0xff;
    const nH = (dots >> 8) & 0xff;
    return Buffer.concat([
        init(),
        cmd(ESC, 0x74, 0), // CP437 — safe for ASCII text on most thermal printers
        cmd(ESC, 0x4d, 0), // Font A (48 cols on 80mm)
        cmd(GS, 0x4c, 0, 0), // GS L — left margin 0
        cmd(GS, 0x28, 0x57, 0x02, 0x00, 0x02, nL, nH), // GS ( W — print area width (dots)
        cmd(ESC, 0x32) // default line spacing
    ]);
}

function pushCenteredLines(parts, lines, maxChars) {
    const rows = (lines || []).map((l) => String(l || '').trim()).filter(Boolean);
    if (!rows.length) return;
    parts.push(alignCenter());
    for (const row of rows) {
        parts.push(line(row.slice(0, maxChars)));
    }
    parts.push(alignLeft());
}

/** ASCII-safe amounts (UTF-8 £ often prints as ú on thermal drivers). */
function formatMoney(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return 'GBP 0.00';
    return `GBP ${v.toFixed(2)}`;
}

/** Date only (matches 80mm PDF ref/date row). */
function formatReceiptDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric'
    });
}

/** One line with left and right text (ref + date, total amount). */
function lineLeftRight(cols, left, right) {
    const l = String(left || '');
    const r = String(right || '');
    const maxLeft = Math.max(8, cols - r.length - 1);
    const leftClip = l.slice(0, maxLeft);
    const pad = Math.max(1, cols - leftClip.length - r.length);
    return line(leftClip + ' '.repeat(pad) + r);
}

function appendPaymentBreakdown(parts, sale, cols) {
    const p = sale.payments;
    const hasWholesale =
        p &&
        (Number(p.cash) > 0 || Number(p.card) > 0 || Number(p.bank) > 0 || Number(p.credit) > 0);
    if (hasWholesale) {
        parts.push(line(dividerLine(cols)));
        parts.push(boldOn());
        parts.push(line('Payments'));
        parts.push(boldOff());
        const rows = [];
        if (Number(p.cash) > 0) rows.push({ method: 'Cash', amount: p.cash });
        if (Number(p.card) > 0) rows.push({ method: 'Card', amount: p.card });
        if (Number(p.bank) > 0) rows.push({ method: 'Bank', amount: p.bank });
        if (Number(p.credit) > 0) rows.push({ method: 'Balance to pay', amount: p.credit });
        for (const { method, amount } of rows) {
            parts.push(line(`${method} — ${formatMoney(amount)}`.slice(0, cols)));
        }
        parts.push(line());
        return;
    }
    const method = String(sale.paymentMethod || '').toLowerCase();
    if (!method || method === 'credit') return;
    const total = (sale.total != null ? Number(sale.total) : 0) - (sale.discount != null ? Number(sale.discount) : 0);
    const label = method.charAt(0).toUpperCase() + method.slice(1);
    parts.push(line(dividerLine(cols)));
    parts.push(boldOn());
    parts.push(line('Payments'));
    parts.push(boldOff());
    parts.push(line(`${label} — ${formatMoney(total)}`.slice(0, cols)));
    parts.push(line());
}

/** ESC p — pulse cash drawer (pin 0 = drawer kick connector on most Epson/Star). */
function drawerKick(pin = 0, onTime = 25, offTime = 250) {
    const m = pin === 1 ? 1 : 0;
    return cmd(ESC, 0x70, m, onTime & 0xff, offTime & 0xff);
}

function saleHasCashPayment(sale) {
    if (!sale) return false;
    if (String(sale.paymentMethod || '').toLowerCase() === 'cash') return true;
    const payments = sale.payments;
    if (payments && Number(payments.cash) > 0) return true;
    return false;
}

/** Match frontend invoicePrint SLUG_TO_SALE_FIELD (sale line flat fields). */
const SLUG_TO_SALE_FIELD = {
    grade: 'grade',
    condition: 'grade',
    brands: 'brand',
    brand: 'brand',
    brands_model: 'brandModel',
    brand_model: 'brandModel',
    model: 'brandModel',
    make: 'brandModel',
    storage: 'capacity',
    capacity: 'capacity',
    colour: 'colour',
    color: 'colour'
};

function summaryItemName(item) {
    const name = String(item.name || '').trim();
    const colour = String(item.colour || '').trim();
    if (!colour) return name || '—';
    const escaped = colour.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return name.replace(new RegExp(`\\s*\\b${escaped}\\b\\s*`, 'gi'), ' ').replace(/\s+/g, ' ').trim() || name || '—';
}

function itemsSummaryLineWithGrade(item) {
    const base = summaryItemName(item);
    const g = String(item.grade || '').trim();
    if (!g) return base || '—';
    const upper = base.toUpperCase();
    const gUp = g.toUpperCase();
    if (
        upper.endsWith(` ${gUp}`) ||
        upper.endsWith(` · ${gUp}`) ||
        new RegExp(`\\b${gUp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(upper)
    ) {
        return base;
    }
    return `${base} · ${g}`.trim();
}

function saleItemValueForSlug(item, slug) {
    const s = String(slug).toLowerCase();
    const field = SLUG_TO_SALE_FIELD[s];
    if (!field) return '';
    const v = item[field];
    return v != null && String(v).trim() ? String(v).trim() : '';
}

function appendOrderedAttributes(baseLine, slugOrder, getValue) {
    const nm = String(baseLine || '').trim() || '—';
    const parts = [];
    for (const slug of slugOrder) {
        const v = getValue(slug);
        if (v) parts.push(v);
    }
    if (parts.length === 0) return nm;
    const nmUp = nm.toUpperCase();
    const extra = parts.filter((p) => !nmUp.includes(String(p).toUpperCase()));
    if (extra.length === 0) return nm;
    return `${nm} · ${extra.join(' · ')}`;
}

function receiptItemDescriptionLine(item, slugOrder) {
    const nm = summaryItemName(item).trim() || String(item.name || '').trim() || '—';
    if (!slugOrder || !slugOrder.length) return itemsSummaryLineWithGrade(item);
    const out = appendOrderedAttributes(nm, slugOrder, (slug) => saleItemValueForSlug(item, slug));
    if (out === nm) return itemsSummaryLineWithGrade(item);
    return out;
}

/**
 * @param {Object} sale - Sale document (lean): reference, type, items[], subtotal, tax, total, discount, customerName, payments, previousBalance, amountDue, createdAt
 * @param {Object} settings - { companyName, companyAddress, receiptTerms, salesPrint?, logoEscpos?: Buffer, qrEscpos?: Buffer }
 * @param {Record<string, string[]>} [variantAttributeSlugsOrderBySku] - SKU → slugs in category order (invoice PDF parity)
 * @returns {Buffer} raw ESC/POS bytes
 */
function buildReceiptEscpos(sale, settings, variantAttributeSlugsOrderBySku = {}) {
    const parts = [];
    const companyName = (settings && settings.companyName) || 'Company';
    const companyAddress = (settings && settings.companyAddress) || '';
    const locationPhone = (settings && settings.locationPhone) || '';
    const locationEmail = (settings && settings.locationEmail) || '';
    const receiptTerms = (settings && settings.receiptTerms) || '';
    const o = mergeReceiptPrinterSalesPrint((settings && settings.salesPrint) || {});
    const cols = lineCharsForPaper(o.paperWidthMm);

    const ref = (sale.reference || '').trim();
    const dateStr = formatReceiptDate(sale.createdAt);

    let hasMetaForDivider = false;
    const markMeta = () => {
        hasMetaForDivider = true;
    };
    const willPrintItems = o.showLineItems !== false && (sale.items || []).length > 0;
    let dividerBeforeItemsDone = false;
    const drawDividerBeforeItems = () => {
        if (dividerBeforeItemsDone) return;
        if (hasMetaForDivider || willPrintItems) {
            parts.push(line(dividerLine(cols)));
            dividerBeforeItemsDone = true;
        }
    };

    parts.push(printerInit(o.paperWidthMm));

    if (o.openCashDrawerOnCashPayment !== false && saleHasCashPayment(sale)) {
        const pin = o.cashDrawerPin === 1 ? 1 : 0;
        parts.push(drawerKick(pin));
    }

    for (const section of o.sectionOrder) {
        switch (section) {
            case 'logo': {
                if (o.showLogo === false) break;
                if (settings.logoEscpos && settings.logoEscpos.length) {
                    parts.push(settings.logoEscpos);
                    parts.push(line());
                }
                break;
            }
            case 'shop_name': {
                if (o.showShopName === false) break;
                parts.push(alignCenter());
                parts.push(boldOn());
                parts.push(line(companyName.slice(0, cols)));
                parts.push(boldOff());
                parts.push(alignLeft());
                parts.push(line());
                break;
            }
            case 'shop_address': {
                if (o.showShopAddress === false || !companyAddress) break;
                pushCenteredLines(
                    parts,
                    companyAddress.split('\n').slice(0, 6),
                    cols
                );
                parts.push(line());
                break;
            }
            case 'location_phone': {
                if (o.showLocationPhone === false || !String(locationPhone).trim()) break;
                parts.push(alignCenter());
                parts.push(line(`Tel: ${String(locationPhone).trim().slice(0, cols - 5)}`));
                parts.push(alignLeft());
                parts.push(line());
                markMeta();
                break;
            }
            case 'location_email': {
                if (o.showLocationEmail === false || !String(locationEmail).trim()) break;
                parts.push(alignCenter());
                parts.push(line(String(locationEmail).trim().slice(0, cols)));
                parts.push(alignLeft());
                parts.push(line());
                markMeta();
                break;
            }
            case 'receipt_title': {
                if (o.showReceiptTitle === false) break;
                parts.push(alignCenter());
                parts.push(boldOn());
                parts.push(line('RECEIPT'));
                parts.push(boldOff());
                parts.push(alignLeft());
                parts.push(line());
                break;
            }
            case 'ref_date': {
                if (o.showReferenceAndDate === false) break;
                parts.push(lineLeftRight(cols, `Ref: ${ref}`, dateStr));
                markMeta();
                break;
            }
            case 'reference_qr': {
                if (o.showReceiptReferenceQr === false) break;
                const qrPayload = ref || String(sale._id || '').trim();
                if (!qrPayload) break;
                if (settings.qrEscpos && settings.qrEscpos.length) {
                    parts.push(settings.qrEscpos);
                    parts.push(alignCenter());
                    parts.push(line(qrPayload.slice(0, cols)));
                    parts.push(alignLeft());
                    parts.push(line());
                    markMeta();
                }
                break;
            }
            case 'customer_name_address': {
                if (o.showCustomerNameAndAddress === false) break;
                parts.push(line(sale.customerName || 'Walk-in'));
                if (sale.customerAddress && String(sale.customerAddress).trim()) {
                    parts.push(line(String(sale.customerAddress).trim().replace(/\n/g, ', ').slice(0, cols)));
                }
                markMeta();
                break;
            }
            case 'customer_phone': {
                if (o.showCustomerPhone === false || !sale.customerPhone || !String(sale.customerPhone).trim()) break;
                parts.push(line(`Tel: ${String(sale.customerPhone).trim().slice(0, cols - 5)}`));
                markMeta();
                break;
            }
            case 'customer_email': {
                if (o.showCustomerEmail === false || !sale.customerEmail || !String(sale.customerEmail).trim()) break;
                parts.push(line(String(sale.customerEmail).trim().slice(0, cols)));
                markMeta();
                break;
            }
            case 'items': {
                drawDividerBeforeItems();
                if (o.showLineItems === false) break;
                (sale.items || []).forEach((item) => {
                    const slugOrder = item.sku ? variantAttributeSlugsOrderBySku[item.sku] : undefined;
                    const desc = receiptItemDescriptionLine(item, slugOrder);
                    parts.push(line(desc.slice(0, cols)));
                    if (o.showItemSerials !== false && item.serialNumbers && item.serialNumbers.length > 0) {
                        parts.push(line(`IMEI: ${item.serialNumbers.join(', ').slice(0, cols - 6)}`));
                    }
                    const qty = item.quantity || 1;
                    const price = item.price != null ? Number(item.price) : 0;
                    const lineTotal = qty * price;
                    parts.push(line(`${qty} x ${formatMoney(price)} = ${formatMoney(lineTotal)}`.slice(0, cols)));
                    parts.push(line());
                });
                break;
            }
            case 'total': {
                if (o.showTotal === false) break;
                parts.push(line(dividerLine(cols)));
                const subtotal = sale.subtotal != null ? Number(sale.subtotal) : 0;
                const discount = sale.discount != null ? Number(sale.discount) : 0;
                // sale.total is pre-discount in this codebase; final amount is total - discount (mirrors A4 / 80mm PDF).
                const finalTotal = (sale.total != null ? Number(sale.total) : 0) - discount;
                if (discount > 0) {
                    parts.push(lineLeftRight(cols, 'Subtotal:', formatMoney(subtotal)));
                    const lbl = sale.discountType === 'percent' && sale.discountValue
                        ? `Discount (${Math.min(100, Number(sale.discountValue))}%):`
                        : 'Discount:';
                    parts.push(lineLeftRight(cols, lbl, `-${formatMoney(discount)}`));
                }
                parts.push(boldOn());
                parts.push(lineLeftRight(cols, 'Total:', formatMoney(finalTotal)));
                parts.push(boldOff());
                parts.push(line());
                appendPaymentBreakdown(parts, sale, cols);
                break;
            }
            case 'terms': {
                if (o.showTermsText === false || !receiptTerms) break;
                pushCenteredLines(parts, receiptTerms.split('\n').slice(0, 8), cols);
                parts.push(line());
                break;
            }
            case 'thank_you': {
                if (o.showThankYou === false) break;
                parts.push(alignCenter());
                parts.push(line('Thank you'));
                parts.push(line());
                break;
            }
            default:
                break;
        }
    }

    parts.push(feedLines(5));
    parts.push(cut());

    return Buffer.concat(parts);
}

module.exports = {
    buildReceiptEscpos,
    saleHasCashPayment,
    drawerKick,
    lineCharsForPaper,
    dividerLine
};
