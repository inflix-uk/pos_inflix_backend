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
 * @param {Object} settings - { companyName, companyAddress (string), receiptTerms (string), salesPrint?: object }
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

    const ref = (sale.reference || '').trim();
    const dateStr = sale.createdAt
        ? new Date(sale.createdAt).toLocaleDateString('en-GB', {
              day: '2-digit',
              month: 'short',
              year: 'numeric',
              hour: '2-digit',
              minute: '2-digit'
          })
        : '';

    let hasMetaForDivider = false;
    const markMeta = () => {
        hasMetaForDivider = true;
    };
    const willPrintItems = o.showLineItems !== false && (sale.items || []).length > 0;
    let dividerBeforeItemsDone = false;
    const drawDividerBeforeItems = () => {
        if (dividerBeforeItemsDone) return;
        if (hasMetaForDivider || willPrintItems) {
            parts.push(line('--------------------------------'));
            dividerBeforeItemsDone = true;
        }
    };

    parts.push(init());

    for (const section of o.sectionOrder) {
        switch (section) {
            case 'logo':
                break;
            case 'shop_name': {
                if (o.showShopName === false) break;
                parts.push(alignCenter());
                parts.push(boldOn());
                parts.push(line(companyName.slice(0, 42)));
                parts.push(boldOff());
                parts.push(alignLeft());
                parts.push(line());
                break;
            }
            case 'shop_address': {
                if (o.showShopAddress === false || !companyAddress) break;
                companyAddress.split('\n').slice(0, 6).forEach((l) => {
                    parts.push(line(l.trim().slice(0, 48)));
                });
                parts.push(line());
                break;
            }
            case 'location_phone': {
                if (o.showLocationPhone === false || !String(locationPhone).trim()) break;
                parts.push(alignCenter());
                parts.push(line(`Tel: ${String(locationPhone).trim().slice(0, 36)}`));
                parts.push(alignLeft());
                parts.push(line());
                markMeta();
                break;
            }
            case 'location_email': {
                if (o.showLocationEmail === false || !String(locationEmail).trim()) break;
                parts.push(alignCenter());
                parts.push(line(String(locationEmail).trim().slice(0, 48)));
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
                parts.push(line(`Ref: ${ref}`));
                parts.push(line(dateStr));
                markMeta();
                break;
            }
            case 'reference_qr': {
                /* PDF draws QR; ESC/POS has no bitmap QR here — section only advances order. */
                break;
            }
            case 'customer_name_address': {
                if (o.showCustomerNameAndAddress === false) break;
                parts.push(line(sale.customerName || 'Walk-in'));
                if (sale.customerAddress && String(sale.customerAddress).trim()) {
                    parts.push(line(String(sale.customerAddress).trim().replace(/\n/g, ', ').slice(0, 48)));
                }
                markMeta();
                break;
            }
            case 'customer_phone': {
                if (o.showCustomerPhone === false || !sale.customerPhone || !String(sale.customerPhone).trim()) break;
                parts.push(line(`Tel: ${String(sale.customerPhone).trim().slice(0, 36)}`));
                markMeta();
                break;
            }
            case 'customer_email': {
                if (o.showCustomerEmail === false || !sale.customerEmail || !String(sale.customerEmail).trim()) break;
                parts.push(line(String(sale.customerEmail).trim().slice(0, 48)));
                markMeta();
                break;
            }
            case 'items': {
                drawDividerBeforeItems();
                if (o.showLineItems === false) break;
                (sale.items || []).forEach((item) => {
                    const slugOrder = item.sku ? variantAttributeSlugsOrderBySku[item.sku] : undefined;
                    const desc = receiptItemDescriptionLine(item, slugOrder);
                    parts.push(line(desc.slice(0, 48)));
                    if (o.showItemSerials !== false && item.serialNumbers && item.serialNumbers.length > 0) {
                        parts.push(line(`IMEI: ${item.serialNumbers.join(', ').slice(0, 36)}`));
                    }
                    const qty = item.quantity || 1;
                    const price = item.price != null ? Number(item.price) : 0;
                    const lineTotal = qty * price;
                    const priceStr = typeof price === 'number' ? price.toFixed(2) : '0.00';
                    const totalStr = lineTotal.toFixed(2);
                    parts.push(line(`${qty} x ${priceStr} = ${totalStr}`));
                    parts.push(line());
                });
                break;
            }
            case 'total': {
                if (o.showTotal === false) break;
                parts.push(line('--------------------------------'));
                const total = sale.total != null ? Number(sale.total) : 0;
                parts.push(boldOn());
                parts.push(line(`Total: ${total.toFixed(2)}`));
                parts.push(boldOff());
                parts.push(line());
                break;
            }
            case 'terms': {
                if (o.showTermsText === false || !receiptTerms) break;
                receiptTerms.split('\n').forEach((l) => {
                    parts.push(line(l.trim().slice(0, 48)));
                });
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

    parts.push(cut());

    return Buffer.concat(parts);
}

module.exports = { buildReceiptEscpos };
