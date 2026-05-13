const Order = require('../models/Order');
const Product = require('../models/Product');
const Customer = require('../models/Customer');
const asyncHandler = require('../middleware/asyncHandler');
const { getTenantIdFromReq } = require('../middleware/auth');
const cache = require('../lib/cache');
const TTL = require('../lib/cacheTTL');

const REPORT_CACHE_NAMESPACES = [
    'reports:balanceSheet',
    'reports:trialBalance',
    'reports:debtorsCreditors',
    'reports:profitLoss',
    'reports:cashFlow',
    'reports:dashboard',
    'reports:sales',
    'reports:topProducts',
    'reports:paymentMethods',
    'reports:cashiers',
    'reports:inventory'
];
async function invalidateAllReports(tenantId) {
    await cache.bumpMany(REPORT_CACHE_NAMESPACES, tenantId);
}
exports.invalidateAllReports = invalidateAllReports;

// @desc    Get dashboard stats
// @route   GET /api/reports/dashboard
// @access  Private
exports.getDashboardStats = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const startOfYear = new Date(today.getFullYear(), 0, 1);

    const params = { day: today.toISOString().slice(0, 10) };

    const data = await cache.cached(
        { ns: 'reports:dashboard', tenantId, params, ttlSec: TTL.REPORTS },
        async () => {
            // Today's stats (Order model has no tenantId - not tenant-filtered)
            const todayOrders = await Order.aggregate([
                {
                    $match: {
                        createdAt: { $gte: today, $lt: tomorrow },
                        status: 'completed'
                    }
                },
                {
                    $group: {
                        _id: null,
                        totalSales: { $sum: '$totalAmount' },
                        count: { $sum: 1 }
                    }
                }
            ]);

            // Monthly stats
            const monthlyOrders = await Order.aggregate([
                {
                    $match: {
                        createdAt: { $gte: startOfMonth },
                        status: 'completed'
                    }
                },
                {
                    $group: {
                        _id: null,
                        totalSales: { $sum: '$totalAmount' },
                        count: { $sum: 1 }
                    }
                }
            ]);

            // Yearly stats
            const yearlyOrders = await Order.aggregate([
                {
                    $match: {
                        createdAt: { $gte: startOfYear },
                        status: 'completed'
                    }
                },
                {
                    $group: {
                        _id: null,
                        totalSales: { $sum: '$totalAmount' },
                        count: { $sum: 1 }
                    }
                }
            ]);

            // Products and customers count (tenant-scoped)
            const totalProducts = await Product.countDocuments({ isActive: true, tenantId });
            const lowStockProducts = await Product.countDocuments({
                isActive: true,
                tenantId,
                $expr: { $lte: ['$quantity', '$minStockLevel'] }
            });
            const totalCustomers = await Customer.countDocuments({ isActive: true, tenantId });

            return {
                today: {
                    sales: todayOrders[0]?.totalSales || 0,
                    orders: todayOrders[0]?.count || 0
                },
                monthly: {
                    sales: monthlyOrders[0]?.totalSales || 0,
                    orders: monthlyOrders[0]?.count || 0
                },
                yearly: {
                    sales: yearlyOrders[0]?.totalSales || 0,
                    orders: yearlyOrders[0]?.count || 0
                },
                totalProducts,
                lowStockProducts,
                totalCustomers
            };
        }
    );

    res.status(200).json({ success: true, data });
});

// @desc    Get sales report
// @route   GET /api/reports/sales
// @access  Private/Admin/Manager
exports.getSalesReport = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const { startDate, endDate, groupBy } = req.query;
    const params = { startDate: startDate || null, endDate: endDate || null, groupBy: groupBy || null };

    const data = await cache.cached(
        { ns: 'reports:sales', tenantId, params, ttlSec: TTL.REPORTS },
        async () => {
            const matchStage = { status: 'completed' };

            if (startDate || endDate) {
                matchStage.createdAt = {};
                if (startDate) matchStage.createdAt.$gte = new Date(startDate);
                if (endDate) matchStage.createdAt.$lte = new Date(endDate);
            }

            let groupId;
            switch (groupBy) {
                case 'day':
                    groupId = { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } };
                    break;
                case 'month':
                    groupId = { $dateToString: { format: '%Y-%m', date: '$createdAt' } };
                    break;
                case 'year':
                    groupId = { $dateToString: { format: '%Y', date: '$createdAt' } };
                    break;
                default:
                    groupId = { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } };
            }

            const salesData = await Order.aggregate([
                { $match: matchStage },
                {
                    $group: {
                        _id: groupId,
                        totalSales: { $sum: '$totalAmount' },
                        totalOrders: { $sum: 1 },
                        totalItems: { $sum: { $size: '$items' } },
                        averageOrderValue: { $avg: '$totalAmount' }
                    }
                },
                { $sort: { _id: 1 } }
            ]);

            // Summary
            const summary = await Order.aggregate([
                { $match: matchStage },
                {
                    $group: {
                        _id: null,
                        totalRevenue: { $sum: '$totalAmount' },
                        totalOrders: { $sum: 1 },
                        averageOrderValue: { $avg: '$totalAmount' },
                        totalDiscount: { $sum: '$discount' },
                        totalTax: { $sum: '$tax' }
                    }
                }
            ]);

            return {
                sales: salesData,
                summary: summary[0] || {
                    totalRevenue: 0,
                    totalOrders: 0,
                    averageOrderValue: 0,
                    totalDiscount: 0,
                    totalTax: 0
                }
            };
        }
    );

    res.status(200).json({ success: true, data });
});

// @desc    Get top selling products
// @route   GET /api/reports/top-products
// @access  Private
exports.getTopProducts = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const { limit = 10, startDate, endDate } = req.query;
    const params = { limit: String(limit), startDate: startDate || null, endDate: endDate || null };

    const topProducts = await cache.cached(
        { ns: 'reports:topProducts', tenantId, params, ttlSec: TTL.REPORTS },
        async () => {
            const matchStage = { status: 'completed' };

            if (startDate || endDate) {
                matchStage.createdAt = {};
                if (startDate) matchStage.createdAt.$gte = new Date(startDate);
                if (endDate) matchStage.createdAt.$lte = new Date(endDate);
            }

            return await Order.aggregate([
                { $match: matchStage },
                { $unwind: '$items' },
                {
                    $group: {
                        _id: '$items.product',
                        productName: { $first: '$items.productName' },
                        totalQuantity: { $sum: '$items.quantity' },
                        totalRevenue: { $sum: '$items.total' }
                    }
                },
                { $sort: { totalQuantity: -1 } },
                { $limit: parseInt(limit) }
            ]);
        }
    );

    res.status(200).json({
        success: true,
        data: topProducts
    });
});

// @desc    Get payment method report
// @route   GET /api/reports/payment-methods
// @access  Private/Admin/Manager
exports.getPaymentMethodReport = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const { startDate, endDate } = req.query;
    const params = { startDate: startDate || null, endDate: endDate || null };

    const paymentReport = await cache.cached(
        { ns: 'reports:paymentMethods', tenantId, params, ttlSec: TTL.REPORTS },
        async () => {
            const matchStage = { status: 'completed' };

            if (startDate || endDate) {
                matchStage.createdAt = {};
                if (startDate) matchStage.createdAt.$gte = new Date(startDate);
                if (endDate) matchStage.createdAt.$lte = new Date(endDate);
            }

            return await Order.aggregate([
                { $match: matchStage },
                {
                    $group: {
                        _id: '$paymentMethod',
                        count: { $sum: 1 },
                        total: { $sum: '$totalAmount' }
                    }
                },
                { $sort: { total: -1 } }
            ]);
        }
    );

    res.status(200).json({
        success: true,
        data: paymentReport
    });
});

// @desc    Get cashier report
// @route   GET /api/reports/cashiers
// @access  Private/Admin/Manager
exports.getCashierReport = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);
    const { startDate, endDate } = req.query;
    const params = { startDate: startDate || null, endDate: endDate || null };

    const cashierReport = await cache.cached(
        { ns: 'reports:cashiers', tenantId, params, ttlSec: TTL.REPORTS },
        async () => {
            const matchStage = { status: 'completed' };

            if (startDate || endDate) {
                matchStage.createdAt = {};
                if (startDate) matchStage.createdAt.$gte = new Date(startDate);
                if (endDate) matchStage.createdAt.$lte = new Date(endDate);
            }

            return await Order.aggregate([
                { $match: matchStage },
                {
                    $group: {
                        _id: '$cashier',
                        totalSales: { $sum: '$totalAmount' },
                        totalOrders: { $sum: 1 }
                    }
                },
                {
                    $lookup: {
                        from: 'users',
                        localField: '_id',
                        foreignField: '_id',
                        as: 'cashierInfo'
                    }
                },
                { $unwind: '$cashierInfo' },
                {
                    $project: {
                        _id: 1,
                        cashierName: '$cashierInfo.name',
                        totalSales: 1,
                        totalOrders: 1,
                        averageOrderValue: { $divide: ['$totalSales', '$totalOrders'] }
                    }
                },
                { $sort: { totalSales: -1 } }
            ]);
        }
    );

    res.status(200).json({
        success: true,
        data: cashierReport
    });
});

// @desc    Get inventory report
// @route   GET /api/reports/inventory
// @access  Private/Admin/Manager
exports.getInventoryReport = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);

    const data = await cache.cached(
        { ns: 'reports:inventory', tenantId, params: {}, ttlSec: TTL.REPORTS },
        async () => {
            const inventoryStats = await Product.aggregate([
                { $match: { isActive: true, tenantId } },
                {
                    $group: {
                        _id: null,
                        totalProducts: { $sum: 1 },
                        totalStock: { $sum: '$quantity' },
                        totalStockValue: { $sum: { $multiply: ['$quantity', '$costPrice'] } },
                        totalRetailValue: { $sum: { $multiply: ['$quantity', '$sellingPrice'] } }
                    }
                }
            ]);

            const lowStockProducts = await Product.find({
                isActive: true,
                tenantId,
                $expr: { $lte: ['$quantity', '$minStockLevel'] }
            })
            .select('name sku quantity minStockLevel')
            .populate('category', 'name')
            .sort('quantity')
            .lean();

            const outOfStock = await Product.find({
                isActive: true,
                tenantId,
                quantity: 0
            })
            .select('name sku')
            .populate('category', 'name')
            .lean();

            return {
                stats: inventoryStats[0] || {
                    totalProducts: 0,
                    totalStock: 0,
                    totalStockValue: 0,
                    totalRetailValue: 0
                },
                lowStockProducts,
                outOfStock,
                lowStockCount: lowStockProducts.length,
                outOfStockCount: outOfStock.length
            };
        }
    );

    res.status(200).json({ success: true, data });
});
