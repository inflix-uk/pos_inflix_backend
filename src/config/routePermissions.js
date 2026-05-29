/**
 * Single source of truth: API route group → required permissions (any of).
 * Must stay in sync with frontend ROUTE_PERMISSIONS and actual middleware on each route.
 * Default DENY: if permission missing, 403.
 */

module.exports = {
    // Sales
    sales: { get: ['sale.view'], post: ['sale.create'], put: ['sale.edit'], delete: ['sale.void'] },
    // Invoices (separate flow from sales — has its own model + permissions)
    invoices: { get: ['invoice.view'], post: ['invoice.create'], put: ['invoice.edit'], delete: ['invoice.void'] },
    // Returns & refunds
    salesReturns: { get: ['return.create', 'refund.issue', 'sale.view'], post: ['return.create'], put: ['return.create', 'refund.issue'], delete: ['return.create', 'refund.issue'] },
    // Products
    products: { get: ['product.view'], post: ['product.create'], put: ['product.edit'], delete: ['product.delete'], stock: ['stock.adjust'] },
    // Purchases / parcels
    purchases: { get: ['purchase.view'], post: ['purchase.create', 'parcel.create'], put: ['purchase.edit'], delete: ['purchase.view'], patch: ['purchase.edit'] },
    // Purchase returns (return to supplier)
    purchaseReturns: { get: ['purchase.return'], post: ['purchase.return'], put: ['purchase.return'], delete: ['purchase.return'] },
    // Repairs
    repairs: { get: ['repair.view'], post: ['repair.create'], put: ['repair.edit'], delete: ['repair.delete'] },
    // Customers
    customers: { get: ['customer.view'], post: ['customer.create'], put: ['customer.edit'], delete: ['user.manage'] },
    // Accounts / statements
    accounts: { get: ['accounts.view'], post: ['accounts.payment'] },
    // Reports
    reports: { get: ['report.view'], export: ['report.export'] },
    // Settings (about, notes, bank, email, tax)
    settings: { get: ['settings.view'], post: ['settings.edit'], put: ['settings.edit'], delete: ['user.manage'] },
    // Activity log
    activityLog: { get: ['audit.view'], export: ['audit.export'] },
    // Admin (users, roles, permissions)
    admin: { users: ['user.manage'], roles: ['role.manage'], permissions: ['role.manage', 'user.manage', 'audit.view'] },
    // Categories, locations, variant attributes, etc. (product/settings context)
    categories: { get: ['product.view'], post: ['product.create'], put: ['product.edit'], delete: ['product.delete'] },
    locations: { get: ['settings.view'], post: ['settings.edit'], put: ['settings.edit'], delete: ['settings.edit'] },
    variantAttributes: {
        get: ['product.view'],
        post: ['variant_attribute.create'],
        put: ['variant_attribute.create'],
        delete: ['variant_attribute.create']
    },
    tax: { get: ['settings.view'], post: ['settings.edit'], put: ['settings.edit'], delete: ['user.manage'] },
    upload: { post: ['product.create', 'settings.edit'] },
    giftCards: { get: ['sale.view'], delete: ['sale.void'] },
    coupons: { get: ['sale.view'], delete: ['sale.void'] },
    expenseCategories: { get: ['expense_category.view'], post: ['expense_category.manage'], put: ['expense_category.manage'], delete: ['expense_category.manage'] },
    expenses: { get: ['expense.view'], post: ['expense.create'], put: ['expense.edit_draft'], delete: ['expense.delete', 'expense.edit_draft'] },
    stockTransfers: {
        get: ['stock_transfer.view'],
        post: ['stock_transfer.create'],
        put: ['stock_transfer.create'],
        delete: ['stock_transfer.create'],
        dispatch: ['stock_transfer.dispatch'],
        receive: ['stock_transfer.receive'],
        cancel: ['stock_transfer.cancel']
    },
    stockAdjustments: {
        get: ['stock_adjustment.view'],
        post: ['stock_adjustment.create', 'stock_adjustment.post'],
        put: ['stock_adjustment.edit_draft'],
        delete: ['stock_adjustment.edit_draft', 'stock_adjustment.cancel'],
        postAction: ['stock_adjustment.post'],
        cancel: ['stock_adjustment.cancel']
    }
};
