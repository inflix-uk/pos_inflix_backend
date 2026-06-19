const Customer = require('../models/Customer');
const LedgerEntry = require('../models/LedgerEntry');
const PricingGroup = require('../models/PricingGroup');
const Sale = require('../models/Sale');
const mongoose = require('mongoose');
const asyncHandler = require('../middleware/asyncHandler');
const { getTenantIdFromReq } = require('../middleware/auth');
const cache = require('../lib/cache');
const TTL = require('../lib/cacheTTL');

const CUSTOMER_CACHE_NAMESPACES = ['customers:list', 'customers:walkIn'];
async function invalidateCustomerCaches(tenantId) {
    await cache.bumpMany(CUSTOMER_CACHE_NAMESPACES, tenantId);
}

/** If pricingGroupId is set, ensure it exists and belongs to tenant. Returns null when valid or when id is empty/null; returns error message when invalid. */
async function validatePricingGroupId(pricingGroupId, tenantId) {
    if (pricingGroupId == null || pricingGroupId === '') return null;
    if (!mongoose.Types.ObjectId.isValid(pricingGroupId)) return 'Invalid pricing group';
    const group = await PricingGroup.findOne({ _id: pricingGroupId, tenantId }).select('_id').lean();
    if (!group) return 'Pricing group not found or does not belong to this store';
    return null;
}

/** Single Customer model and API for the whole system (POS, wholesale, repairs, customers page, statements). */
const round2 = (n) => Math.round(Number(n) * 100) / 100;

// @desc    Get all customers
// @route   GET /api/customers
// @access  Private
exports.getCustomers = asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const startIndex = (page - 1) * limit;
    const tenantId = getTenantIdFromReq(req);

    const params = {
        page, limit,
        isActive: req.query.isActive,
        search: req.query.search || null,
        useInRepairs: req.query.useInRepairs,
        pricingGroupId: req.query.pricingGroupId || null,
    };

    const payload = await cache.cached(
        { ns: 'customers:list', tenantId, params, ttlSec: TTL.CATALOG },
        async () => {
            const query = { tenantId };
            if (req.query.isActive !== undefined) query.isActive = req.query.isActive === 'true';
            if (req.query.search) {
                query.$or = [
                    { name: { $regex: req.query.search, $options: 'i' } },
                    { phone: { $regex: req.query.search, $options: 'i' } },
                    { email: { $regex: req.query.search, $options: 'i' } },
                    { contactName: { $regex: req.query.search, $options: 'i' } }
                ];
            }
            if (req.query.useInRepairs === 'true') {
                query.$and = query.$and || [];
                query.$and.push({ $or: [{ useInRepairs: true }, { useInRepairs: { $exists: false } }] });
            }
            if (req.query.pricingGroupId !== undefined && req.query.pricingGroupId !== '') {
                query.pricingGroupId = req.query.pricingGroupId;
            }
            const [total, customers] = await Promise.all([
                Customer.countDocuments(query),
                Customer.find(query).skip(startIndex).limit(limit).sort('-createdAt').lean()
            ]);
            const data = customers.map((c) => ({ ...c, balance: c.balance != null ? round2(c.balance) : 0 }));
            return { total, data, pages: Math.ceil(total / limit) };
        }
    );

    res.status(200).json({
        success: true,
        count: payload.data.length,
        total: payload.total,
        page,
        pages: payload.pages,
        data: payload.data
    });
});

// @desc    Get single customer
// @route   GET /api/customers/:id
// @access  Private
exports.getCustomer = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const customer = await Customer.findOne({ _id: req.params.id, tenantId }).lean();

    if (!customer) {
        return res.status(404).json({
            success: false,
            message: 'Customer not found'
        });
    }

    if (customer.balance != null) customer.balance = round2(customer.balance);

    res.status(200).json({
        success: true,
        data: customer
    });
});

// @desc    Get customer 360 summary (profile + pricing group + sale stats)
// @route   GET /api/customers/:id/summary
// @access  Private
exports.getCustomerSummary = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const customerId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(customerId)) {
        return res.status(400).json({ success: false, message: 'Invalid customer id' });
    }

    const customer = await Customer.findOne({ _id: customerId, tenantId })
        .populate('pricingGroupId', 'name')
        .lean();

    if (!customer) {
        return res.status(404).json({ success: false, message: 'Customer not found' });
    }

    const balance = customer.balance != null ? round2(customer.balance) : 0;
    const custObjId = new mongoose.Types.ObjectId(customerId);

    const [saleAgg] = await Sale.aggregate([
        {
            $match: {
                tenantId,
                customerId: custObjId,
                status: { $ne: 'voided' }
            }
        },
        {
            $group: {
                _id: null,
                saleCount: { $sum: 1 },
                lastSaleAt: { $max: '$createdAt' }
            }
        }
    ]);

    let lastSaleReference = null;
    if (saleAgg && saleAgg.lastSaleAt) {
        const lastSale = await Sale.findOne({
            tenantId,
            customerId: custObjId,
            status: { $ne: 'voided' },
            createdAt: saleAgg.lastSaleAt
        })
            .select('reference')
            .lean();
        lastSaleReference = lastSale?.reference || null;
    }

    const pricingGroup = customer.pricingGroupId
        ? {
            _id: customer.pricingGroupId._id,
            name: customer.pricingGroupId.name
        }
        : null;

    const { pricingGroupId: _pg, ...customerFields } = customer;
    customerFields.balance = balance;

    res.status(200).json({
        success: true,
        data: {
            customer: customerFields,
            pricingGroup,
            stats: {
                saleCount: saleAgg?.saleCount || 0,
                lastSaleAt: saleAgg?.lastSaleAt || null,
                lastSaleReference,
                openBalance: balance
            }
        }
    });
});

const WALK_IN_NAME = 'Walk-in Customer';

// @desc    Get or create the Walk-in customer (for Retail mode)
// @route   GET /api/customers/walk-in
// @access  Private (sale.create or settings.view)
exports.getOrCreateWalkInCustomer = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const customer = await cache.cached(
        { ns: 'customers:walkIn', tenantId, params: {}, ttlSec: TTL.REFERENCE },
        async () => {
            let c = await Customer.findOne({ isWalkIn: true, tenantId }).lean();
            if (!c) {
                c = await Customer.findOne({ name: WALK_IN_NAME, tenantId }).lean();
                if (c) {
                    await Customer.updateOne({ _id: c._id }, { $set: { isWalkIn: true } });
                    c = await Customer.findById(c._id).lean();
                }
            }
            if (!c) {
                const newCustomer = await Customer.create({
                    name: WALK_IN_NAME,
                    phone: 'N/A',
                    email: '',
                    isWalkIn: true,
                    isActive: true,
                    useInRepairs: false,
                    tenantId
                });
                c = newCustomer.toObject();
            }
            if (c.balance != null) c.balance = round2(c.balance);
            return c;
        }
    );
    res.status(200).json({
        success: true,
        data: customer
    });
});

// @desc    Create customer
// @route   POST /api/customers
// @access  Private
exports.createCustomer = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const body = { ...req.body };
    if (body.tenantId !== undefined) delete body.tenantId;
    const err = await validatePricingGroupId(body.pricingGroupId, tenantId);
    if (err) {
        return res.status(400).json({ success: false, message: err });
    }
    const openingBalance = body.balance != null ? round2(Number(body.balance)) : 0;
    if (body.balance !== undefined) delete body.balance;

    const customer = await Customer.create({ ...body, tenantId, balance: openingBalance });

    if (openingBalance !== 0) {
        await Customer.findByIdAndUpdate(customer._id, { $set: { balance: openingBalance } });
        const startOfToday = new Date();
        startOfToday.setUTCHours(0, 0, 0, 0);
        await LedgerEntry.create({
            accountType: 'customer',
            accountId: customer._id,
            accountModel: 'Customer',
            type: 'opening_balance',
            amount: openingBalance,
            referenceLabel: 'Balance brought forward',
            date: startOfToday,
            createdBy: req.user?.id
        });
    }

    const saved = await Customer.findById(customer._id).lean();
    await invalidateCustomerCaches(tenantId);
    res.status(201).json({
        success: true,
        message: 'Customer created successfully',
        data: saved || customer
    });
});

// @desc    Update customer
// @route   PUT /api/customers/:id
// @access  Private
exports.updateCustomer = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    let customer = await Customer.findOne({ _id: req.params.id, tenantId });

    if (!customer) {
        return res.status(404).json({
            success: false,
            message: 'Customer not found'
        });
    }
    const body = { ...req.body };
    if (body.tenantId !== undefined) delete body.tenantId;
    const err = await validatePricingGroupId(body.pricingGroupId, tenantId);
    if (err) {
        return res.status(400).json({ success: false, message: err });
    }
    customer = await Customer.findByIdAndUpdate(req.params.id, body, {
        new: true,
        runValidators: true
    });
    await invalidateCustomerCaches(tenantId);

    res.status(200).json({
        success: true,
        message: 'Customer updated successfully',
        data: customer
    });
});

// @desc    Delete the most recently created customer(s) (e.g. undo last import)
// @route   DELETE /api/customers/recent
// @query   limit - number of customers to delete (default 1)
// @access  Private
exports.deleteRecentCustomers = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 1, 1), 100);

    const recent = await Customer.find({ tenantId })
        .sort({ createdAt: -1 })
        .limit(limit)
        .select('_id')
        .lean();

    if (recent.length === 0) {
        return res.status(200).json({
            success: true,
            message: 'No customers to delete',
            deleted: 0
        });
    }

    const ids = recent.map((c) => c._id);
    await LedgerEntry.deleteMany({ accountType: 'customer', accountId: { $in: ids } });
    const result = await Customer.deleteMany({ _id: { $in: ids }, tenantId });
    await invalidateCustomerCaches(tenantId);

    res.status(200).json({
        success: true,
        message: result.deletedCount === 1 ? 'Last imported customer deleted' : `${result.deletedCount} last imported customers deleted`,
        deleted: result.deletedCount
    });
});

// @desc    Delete customer
// @route   DELETE /api/customers/:id
// @access  Private/Admin
exports.deleteCustomer = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const customer = await Customer.findOne({ _id: req.params.id, tenantId });

    if (!customer) {
        return res.status(404).json({
            success: false,
            message: 'Customer not found'
        });
    }

    await LedgerEntry.deleteMany({ accountType: 'customer', accountId: customer._id });
    await customer.deleteOne();
    await invalidateCustomerCaches(tenantId);

    res.status(200).json({
        success: true,
        message: 'Customer deleted successfully'
    });
});

// @desc    Add loyalty points
// @route   PUT /api/customers/:id/loyalty
// @access  Private
exports.updateLoyaltyPoints = asyncHandler(async (req, res) => {
    const { points, type } = req.body; // type: 'add' or 'redeem'
    const tenantId = getTenantIdFromReq(req);
    const customer = await Customer.findOne({ _id: req.params.id, tenantId });

    if (!customer) {
        return res.status(404).json({
            success: false,
            message: 'Customer not found'
        });
    }

    if (type === 'add') {
        customer.loyaltyPoints += points;
    } else if (type === 'redeem') {
        if (customer.loyaltyPoints < points) {
            return res.status(400).json({
                success: false,
                message: 'Insufficient loyalty points'
            });
        }
        customer.loyaltyPoints -= points;
    }

    await customer.save();
    await invalidateCustomerCaches(tenantId);

    res.status(200).json({
        success: true,
        message: 'Loyalty points updated successfully',
        data: customer
    });
});
