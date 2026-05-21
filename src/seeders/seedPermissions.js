/**
 * Seed permission catalog. Idempotent: upsert by key.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const PermissionExport = require('../models/Permission');

function permissionModelOnConnection(conn) {
    const schema = PermissionExport.schema;
    const modelName = PermissionExport.modelName;
    return conn.models[modelName] || conn.model(modelName, schema);
}

const PERMISSIONS = [
    { key: 'dashboard.view', description: 'View main dashboard (/dashboard)', group: 'Dashboard' },
    { key: 'sale.view', description: 'View sales', group: 'Sales' },
    { key: 'sale.create', description: 'Create a sale', group: 'Sales' },
    { key: 'sale.edit', description: 'Edit sale (restricted)', group: 'Sales' },
    { key: 'sale.void', description: 'Void invoice', group: 'Sales' },
    { key: 'sale.delete', description: 'Permanently delete sale (admin only)', group: 'Sales' },
    { key: 'invoice.view', description: 'View invoices', group: 'Invoices' },
    { key: 'invoice.create', description: 'Create an invoice', group: 'Invoices' },
    { key: 'invoice.edit', description: 'Edit invoice', group: 'Invoices' },
    { key: 'invoice.void', description: 'Void invoice', group: 'Invoices' },
    { key: 'invoice.delete', description: 'Permanently delete invoice (admin only)', group: 'Invoices' },
    { key: 'return.create', description: 'Create return', group: 'Returns & Refunds' },
    { key: 'refund.issue', description: 'Issue refund', group: 'Returns & Refunds' },
    { key: 'storecredit.grant', description: 'Grant store credit', group: 'Returns & Refunds' },
    { key: 'product.view', description: 'View products', group: 'Products' },
    { key: 'product.create', description: 'Create products', group: 'Products' },
    { key: 'product.edit', description: 'Edit products', group: 'Products' },
    { key: 'product.delete', description: 'Delete products', group: 'Products' },
    { key: 'stock.view', description: 'View stock', group: 'Inventory' },
    { key: 'inventory.settings.manage', description: 'Manage inventory settings (e.g. default low stock threshold)', group: 'Inventory' },
    { key: 'stock.adjust', description: 'Adjust stock', group: 'Inventory' },
    { key: 'stock.receive', description: 'Receive stock', group: 'Inventory' },
    { key: 'parcel.create', description: 'Create parcel', group: 'Parcels' },
    { key: 'parcel.status_change', description: 'Change parcel status', group: 'Parcels' },
    { key: 'report.view', description: 'View reports', group: 'Reports' },
    { key: 'report.export', description: 'Export reports', group: 'Reports' },
    { key: 'report.zread', description: 'View Daily Closing Till Reading (Z-Read) dashboard', group: 'Reports' },
    { key: 'user.manage', description: 'Manage users', group: 'Admin' },
    { key: 'role.manage', description: 'Manage roles', group: 'Admin' },
    { key: 'audit.view', description: 'View activity log', group: 'Admin' },
    { key: 'audit.export', description: 'Export activity log', group: 'Admin' },
    { key: 'customer.view', description: 'View customers', group: 'Customers' },
    { key: 'customer.create', description: 'Create customers', group: 'Customers' },
    { key: 'customer.edit', description: 'Edit customers', group: 'Customers' },
    { key: 'accounts.view', description: 'View accounts / statements', group: 'Accounts' },
    { key: 'accounts.payment', description: 'Record payments', group: 'Accounts' },
    { key: 'purchase.view', description: 'View purchases', group: 'Purchases' },
    { key: 'purchase.create', description: 'Create purchases', group: 'Purchases' },
    { key: 'purchase.edit', description: 'Edit purchases', group: 'Purchases' },
    { key: 'purchase.return', description: 'Return purchases to supplier', group: 'Purchases' },
    { key: 'settings.view', description: 'View settings', group: 'Settings' },
    { key: 'settings.edit', description: 'Edit settings', group: 'Settings' },
    { key: 'settings.manage', description: 'Manage company-wide settings (e.g. sales default account)', group: 'Settings' },
    { key: 'settings.printing', description: 'Configure silent printing on this device (Print Bridge, printers)', group: 'Settings' },
    { key: 'repair.view', description: 'View repairs', group: 'Repairs' },
    { key: 'repair.create', description: 'Create repair', group: 'Repairs' },
    { key: 'repair.edit', description: 'Edit repair', group: 'Repairs' },
    { key: 'repair.delete', description: 'Delete repair', group: 'Repairs' },
    { key: 'expense_category.view', description: 'View expense categories', group: 'Expenses' },
    { key: 'expense_category.manage', description: 'Manage expense categories', group: 'Expenses' },
    { key: 'expense.view', description: 'View expenses', group: 'Expenses' },
    { key: 'expense.create', description: 'Create expense', group: 'Expenses' },
    { key: 'expense.edit_draft', description: 'Edit draft/submitted expense', group: 'Expenses' },
    { key: 'expense.submit', description: 'Submit expense', group: 'Expenses' },
    { key: 'expense.approve', description: 'Approve/reject expense', group: 'Expenses' },
    { key: 'expense.mark_paid', description: 'Mark expense as paid', group: 'Expenses' },
    { key: 'expense.void', description: 'Void expense', group: 'Expenses' },
    { key: 'expense.delete', description: 'Delete draft/submitted expense', group: 'Expenses' },
    { key: 'expense.export', description: 'Export expenses', group: 'Expenses' },
    { key: 'stock_transfer.view', description: 'View stock transfers', group: 'Stock Transfers' },
    { key: 'stock_transfer.create', description: 'Create and edit draft stock transfers', group: 'Stock Transfers' },
    { key: 'stock_transfer.dispatch', description: 'Dispatch stock transfers', group: 'Stock Transfers' },
    { key: 'stock_transfer.receive', description: 'Receive stock transfers', group: 'Stock Transfers' },
    { key: 'stock_transfer.cancel', description: 'Cancel draft stock transfers', group: 'Stock Transfers' },
    { key: 'stock_adjustment.view', description: 'View stock adjustments', group: 'Stock Adjustments' },
    { key: 'stock_adjustment.create', description: 'Create draft stock adjustments', group: 'Stock Adjustments' },
    { key: 'stock_adjustment.edit_draft', description: 'Edit draft stock adjustments', group: 'Stock Adjustments' },
    { key: 'stock_adjustment.post', description: 'Post stock adjustments (create ledger entries)', group: 'Stock Adjustments' },
    { key: 'stock_adjustment.cancel', description: 'Cancel draft stock adjustments', group: 'Stock Adjustments' },
    { key: 'stock_adjustment.override_missing_cost', description: 'Post adjustment when cost is missing (manager)', group: 'Stock Adjustments' },
    { key: 'inventory.print_labels', description: 'Print QR/labels (products, serials, locations)', group: 'Inventory' }
];

async function seedPermissionsOnConnection(conn) {
    const Permission = permissionModelOnConnection(conn);
    for (const p of PERMISSIONS) {
        await Permission.findOneAndUpdate(
            { key: p.key },
            { $set: { description: p.description, group: p.group } },
            { upsert: true, new: true }
        );
    }
}

async function run() {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
        console.error('MONGODB_URI required');
        process.exit(1);
    }
    await mongoose.connect(uri);
    await seedPermissionsOnConnection(mongoose.connection);
    console.log('Seeded ' + PERMISSIONS.length + ' permissions');
    await mongoose.disconnect();
}

if (require.main === module) {
    run().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { PERMISSIONS, seedPermissionsOnConnection, permissionModelOnConnection };
