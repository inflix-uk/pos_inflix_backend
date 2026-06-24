/** Normalize product / inventory item names to uppercase for consistent display and storage. */
function formatProductName(value) {
    if (value == null || String(value).trim() === '') return value;
    return String(value).trim().replace(/\s+/g, ' ').toUpperCase();
}

module.exports = { formatProductName };
