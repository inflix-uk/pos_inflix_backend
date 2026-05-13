/**
 * One-line label: company name and contact (Supplier: contactPerson; Customer on purchase: contactName).
 */
function formatSupplierLabel(ref) {
    if (ref == null || ref === '') return '';
    if (typeof ref === 'string') return ref.trim();
    const name = ref.name != null ? String(ref.name).trim() : '';
    const contactRaw = ref.contactPerson != null ? ref.contactPerson : ref.contactName;
    const contact = contactRaw != null ? String(contactRaw).trim() : '';
    if (!name && !contact) return '';
    if (!contact || contact === name) return name || contact;
    return `${name} · ${contact}`;
}

/** Prefer legacy `supplier` ref, else unified `account` (Supplier or Customer). */
function purchasePartyLabel(purchase) {
    if (!purchase) return '';
    return formatSupplierLabel(purchase.supplier) || formatSupplierLabel(purchase.account) || '';
}

module.exports = { formatSupplierLabel, purchasePartyLabel };
