const Customer = require('../models/Customer');
const LedgerEntry = require('../models/LedgerEntry');
const Sale = require('../models/Sale');
const AboutSettings = require('../models/AboutSettings');
const NotesTermsSettings = require('../models/NotesTermsSettings');
const asyncHandler = require('../middleware/asyncHandler');
const { getTenantIdFromReq } = require('../middleware/auth');
const { resolveLocationForPrint, getLocationPostalBlock } = require('../utils/printLocationHelper');
const { enrichSaleWithCustomerContact } = require('../utils/enrichSaleForPrint');
const { variantAttributeSlugsOrderBySkuForSale } = require('../utils/printVariantAttributes');
const entitlementsService = require('../services/entitlementsService');
const platformEntitlementsCache = require('../services/platformEntitlementsCache');
const platformClient = require('../lib/platformClient');

const round2 = (n) => Math.round(Number(n) * 100) / 100;

// @desc    Set/update portal password for a customer (admin action)
// @route   POST /api/customer-portal/set-password
// @access  Private (staff)
exports.setPassword = asyncHandler(async (req, res) => {
    const { customerId, password } = req.body;
    if (!customerId || !password) {
        return res.status(400).json({ success: false, message: 'customerId and password are required' });
    }
    if (password.length < 6) {
        return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    }
    const customer = await Customer.findById(customerId).select('+password');
    if (!customer) {
        return res.status(404).json({ success: false, message: 'Customer not found' });
    }
    if (!customer.email) {
        return res.status(400).json({ success: false, message: 'Customer must have an email address to enable portal access' });
    }
    customer.password = password;
    customer.portalEnabled = true;
    await customer.save();
    res.status(200).json({ success: true, message: 'Portal password set successfully' });
});

// @desc    Customer portal login
// @route   POST /api/customer-portal/login
// @access  Public
exports.login = asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ success: false, message: 'Email and password are required' });
    }
    const customer = await Customer.findOne({ email: email.toLowerCase().trim() }).select('+password');
    if (!customer) {
        return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    if (!customer.portalEnabled) {
        return res.status(401).json({ success: false, message: 'Portal access is not enabled for this account' });
    }
    if (!customer.password) {
        return res.status(401).json({ success: false, message: 'Portal password not set. Please contact the store.' });
    }
    const isMatch = await customer.matchPassword(password);
    if (!isMatch) {
        return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    const token = customer.getPortalToken();
    res.status(200).json({
        success: true,
        token,
        data: {
            _id: customer._id,
            name: customer.name,
            email: customer.email,
            phone: customer.phone
        }
    });
});

// @desc    Get logged-in customer profile
// @route   GET /api/customer-portal/me
// @access  Customer Portal
exports.getMe = asyncHandler(async (req, res) => {
    const customer = await Customer.findById(req.portalCustomer.id)
        .select('name email phone address balance loyaltyPoints totalPurchases');
    if (!customer) {
        return res.status(404).json({ success: false, message: 'Customer not found' });
    }
    res.status(200).json({ success: true, data: customer });
});

// @desc    Get customer's own account statement
// @route   GET /api/customer-portal/statement
// @access  Customer Portal
exports.getStatement = asyncHandler(async (req, res) => {
    const customerId = req.portalCustomer.id;
    const from = req.query.from ? new Date(req.query.from) : null;
    const to = req.query.to ? new Date(req.query.to) : null;

    const customer = await Customer.findById(customerId).select('name balance').lean();
    if (!customer) {
        return res.status(404).json({ success: false, message: 'Customer not found' });
    }
    if (customer.balance != null && typeof customer.balance !== 'number') {
        customer.balance = round2(Number(customer.balance));
    }

    const match = { accountType: 'customer', accountId: customerId, deletedAt: null };
    if (from && to) match.date = { $gte: from, $lte: to };
    else if (from) match.date = { $gte: from };
    else if (to) match.date = { $lte: to };

    const entries = await LedgerEntry.find(match).sort({ date: -1 }).lean();

    // Aggregate sale entries by referenceId (same logic as accountsController)
    const saleEntries = entries.filter((e) => e.type === 'sale' && e.referenceId);
    const otherEntries = entries.filter((e) => e.type !== 'sale' || !e.referenceId);
    const saleByRef = new Map();
    saleEntries.forEach((e) => {
        const ref = String(e.referenceId);
        if (!saleByRef.has(ref)) {
            saleByRef.set(ref, { _id: e._id, type: 'sale', amount: 0, referenceLabel: e.referenceLabel, date: e.date, referenceId: ref });
        }
        const row = saleByRef.get(ref);
        row.amount = round2((row.amount || 0) + (Number(e.amount) || 0));
        if (new Date(e.date) < new Date(row.date)) row.date = e.date;
    });
    const aggregatedSales = Array.from(saleByRef.values());

    const saleRefIds = aggregatedSales.map((s) => s.referenceId);
    let editedSaleIds = new Set();
    if (saleRefIds.length > 0) {
        const sales = await Sale.find({ _id: { $in: saleRefIds } }).select('_id updatedAt createdAt').lean();
        const EDIT_THRESHOLD_MS = 5000;
        sales.forEach((s) => {
            const created = new Date(s.createdAt).getTime();
            const updated = new Date(s.updatedAt).getTime();
            if (updated - created > EDIT_THRESHOLD_MS) editedSaleIds.add(String(s._id));
        });
    }

    const saleLines = aggregatedSales.map((s) => ({
        _id: s._id, type: s.type, amount: round2(s.amount), referenceLabel: s.referenceLabel,
        date: s.date, paymentMethod: undefined, note: undefined, isEdited: editedSaleIds.has(s.referenceId)
    }));
    const otherLines = otherEntries.map((e) => ({
        _id: e._id, type: e.type, amount: round2(e.amount), referenceLabel: e.referenceLabel,
        date: e.date, paymentMethod: e.paymentMethod, note: e.note, isEdited: false
    }));

    let balance = round2(entries.reduce((sum, e) => sum + (e.amount || 0), 0));
    const customerBalance = round2(Number(customer.balance) || 0);
    const hasOpeningInLedger = entries.some((e) => e.type === 'opening_balance');
    const noDateFilter = !from && !to;
    let lines = [...saleLines, ...otherLines];
    const startOfToday = new Date();
    startOfToday.setUTCHours(0, 0, 0, 0);

    if (noDateFilter && customerBalance !== 0 && !hasOpeningInLedger && balance === 0) {
        balance = customerBalance;
        lines = [
            { _id: 'opening', type: 'opening_balance', amount: customerBalance, referenceLabel: 'Balance brought forward', date: startOfToday, paymentMethod: undefined, note: undefined, isEdited: false },
            ...lines
        ];
    }
    lines.sort((a, b) => new Date(b.date) - new Date(a.date));

    res.status(200).json({
        success: true,
        data: {
            customer: { _id: customer._id, name: customer.name },
            balance,
            lines
        }
    });
});

// @desc    Get customer's invoices (previous sales)
// @route   GET /api/customer-portal/invoices
// @access  Customer Portal
exports.getInvoices = asyncHandler(async (req, res) => {
    const customerId = req.portalCustomer.id;
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
    const skip = (page - 1) * limit;

    const match = { customerId, status: { $ne: 'voided' } };

    const [sales, total] = await Promise.all([
        Sale.find(match)
            .select('reference type total subtotal tax discount payments paymentMethod occurredAt createdAt items amountDue')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
        Sale.countDocuments(match)
    ]);

    const invoices = sales.map((s) => {
        const paidAmount = round2(
            (Number(s.payments?.cash) || 0) +
            (Number(s.payments?.card) || 0) +
            (Number(s.payments?.bank) || 0) +
            (Number(s.payments?.credit) || 0) +
            (Number(s.payments?.split) || 0)
        );
        return {
            _id: s._id,
            reference: s.reference || '',
            type: s.type || 'retail',
            date: s.occurredAt || s.createdAt,
            total: round2(Number(s.total) || 0),
            subtotal: round2(Number(s.subtotal) || 0),
            tax: round2(Number(s.tax) || 0),
            discount: round2(Number(s.discount) || 0),
            paid: paidAmount,
            amountDue: round2(Number(s.amountDue) || 0),
            paymentMethod: s.paymentMethod || '',
            itemCount: Array.isArray(s.items) ? s.items.length : 0,
            items: (s.items || []).map((item) => ({
                name: item.name || '',
                sku: item.sku || '',
                quantity: item.quantity || 0,
                price: round2(Number(item.price) || 0),
            }))
        };
    });

    res.status(200).json({
        success: true,
        data: invoices,
        total,
        page,
        pages: Math.ceil(total / limit)
    });
});

// @desc    Get invoice print context (sale + settings + location) for PDF download
// @route   GET /api/customer-portal/invoices/:id/print-data
// @access  Customer Portal
exports.getInvoicePrintData = asyncHandler(async (req, res) => {
    const customerId = req.portalCustomer.id;
    const saleId = req.params.id;

    let sale = await Sale.findOne({ _id: saleId, customerId }).lean();
    if (!sale) {
        return res.status(404).json({ success: false, message: 'Invoice not found' });
    }
    sale = await enrichSaleWithCustomerContact(sale);

    const [about, notesTerms, locationResult, variantAttributeSlugsOrderBySku] = await Promise.all([
        AboutSettings.getSettings(),
        NotesTermsSettings.getSettings(),
        resolveLocationForPrint(sale.locationId || null),
        variantAttributeSlugsOrderBySkuForSale(sale, sale.tenantId || 'default')
    ]);

    res.status(200).json({
        success: true,
        data: {
            sale,
            location: locationResult.location || null,
            fallbackLabel: locationResult.fallbackLabel || null,
            variantAttributeSlugsOrderBySku: variantAttributeSlugsOrderBySku || {},
            settings: {
                about: {
                    appName: (about && about.appName) || 'Company',
                    appTitle: (about && about.appTitle) || '',
                    companyAddress: (about && about.companyAddress) || '',
                    logo: (about && about.logo) || null,
                    invoicePdfTitle: (about && about.invoicePdfTitle) || 'INVOICE',
                    companyNumber: (about && about.companyNumber) || '',
                    vatNumber: (about && about.vatNumber) || '',
                },
                notesTerms: {
                    pdfSalesTerms: (notesTerms && notesTerms.pdfSalesTerms) || '',
                    paymentNote: (notesTerms && notesTerms.paymentNote) || '',
                    invoicePdfPrint: (notesTerms && notesTerms.invoicePdfPrint) || null,
                    businessInvoicePdfPrint: (notesTerms && notesTerms.businessInvoicePdfPrint) || null,
                    businessInvoiceTerms: (notesTerms && notesTerms.businessInvoiceTerms) || '',
                    a4InvoiceTemplate: (notesTerms && notesTerms.a4InvoiceTemplate) || 'dispatch',
                },
                bankAccounts: []
            }
        }
    });
});

// @desc    Check if customer invoicing feature is enabled (public, no auth)
// @route   GET /api/customer-portal/feature-status
// @access  Public
exports.featureStatus = asyncHandler(async (req, res) => {
    const tenantId = req.tenantId || 'default';
    const { enabledFeatures } = await entitlementsService.getEntitlements(tenantId);
    const enabled = enabledFeatures['customer invoicing'] === true;
    res.status(200).json({ success: true, data: { customerInvoicingEnabled: enabled } });
});
