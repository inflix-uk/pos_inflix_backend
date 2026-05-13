const Order = require('../models/Order');
const Product = require('../models/Product');
const Customer = require('../models/Customer');
const Inventory = require('../models/Inventory');
const asyncHandler = require('../middleware/asyncHandler');

// @desc    Get all orders
// @route   GET /api/orders
// @access  Private
exports.getOrders = asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const startIndex = (page - 1) * limit;

    const query = {};

    if (req.query.status) {
        query.status = req.query.status;
    }

    if (req.query.paymentStatus) {
        query.paymentStatus = req.query.paymentStatus;
    }

    if (req.query.paymentMethod) {
        query.paymentMethod = req.query.paymentMethod;
    }

    if (req.query.cashier) {
        query.cashier = req.query.cashier;
    }

    if (req.query.customer) {
        query.customer = req.query.customer;
    }

    // Date range filter
    if (req.query.startDate || req.query.endDate) {
        query.createdAt = {};
        if (req.query.startDate) {
            query.createdAt.$gte = new Date(req.query.startDate);
        }
        if (req.query.endDate) {
            query.createdAt.$lte = new Date(req.query.endDate);
        }
    }

    // Today's orders
    if (req.query.today === 'true') {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        query.createdAt = { $gte: today, $lt: tomorrow };
    }

    if (req.query.search) {
        query.orderNumber = { $regex: req.query.search, $options: 'i' };
    }

    const total = await Order.countDocuments(query);
    const orders = await Order.find(query)
        .populate('customer', 'name phone')
        .populate('cashier', 'name')
        .skip(startIndex)
        .limit(limit)
        .sort('-createdAt');

    res.status(200).json({
        success: true,
        count: orders.length,
        total,
        page,
        pages: Math.ceil(total / limit),
        data: orders
    });
});

// @desc    Get single order
// @route   GET /api/orders/:id
// @access  Private
exports.getOrder = asyncHandler(async (req, res) => {
    const order = await Order.findById(req.params.id)
        .populate('customer', 'name phone email')
        .populate('cashier', 'name')
        .populate('items.product', 'name sku');

    if (!order) {
        return res.status(404).json({
            success: false,
            message: 'Order not found'
        });
    }

    res.status(200).json({
        success: true,
        data: order
    });
});

// @desc    Create order (sale)
// @route   POST /api/orders
// @access  Private
exports.createOrder = asyncHandler(async (req, res) => {
    const { items, customer, paymentMethod, paidAmount, discount, taxRate, notes } = req.body;

    if (!items || items.length === 0) {
        return res.status(400).json({
            success: false,
            message: 'Order must have at least one item'
        });
    }

    // Calculate totals and validate stock
    let subtotal = 0;
    const orderItems = [];

    for (const item of items) {
        const product = await Product.findById(item.product);

        if (!product) {
            return res.status(404).json({
                success: false,
                message: `Product not found: ${item.product}`
            });
        }

        if (!product.isActive) {
            return res.status(400).json({
                success: false,
                message: `Product is not active: ${product.name}`
            });
        }

        if (product.quantity < item.quantity) {
            return res.status(400).json({
                success: false,
                message: `Insufficient stock for ${product.name}. Available: ${product.quantity}`
            });
        }

        const itemDiscount = item.discount || 0;
        const itemTotal = (product.sellingPrice * item.quantity) - itemDiscount;

        orderItems.push({
            product: product._id,
            productName: product.name,
            quantity: item.quantity,
            unitPrice: product.sellingPrice,
            discount: itemDiscount,
            total: itemTotal
        });

        subtotal += itemTotal;
    }

    // Calculate tax and total
    const tax = (subtotal * (taxRate || 0)) / 100;
    const totalDiscount = discount || 0;
    const totalAmount = subtotal + tax - totalDiscount;
    const changeAmount = paidAmount - totalAmount;

    if (paidAmount < totalAmount) {
        return res.status(400).json({
            success: false,
            message: 'Paid amount is less than total amount'
        });
    }

    // Create order
    const order = await Order.create({
        items: orderItems,
        customer,
        subtotal,
        tax,
        taxRate: taxRate || 0,
        discount: totalDiscount,
        totalAmount,
        paidAmount,
        changeAmount,
        paymentMethod: paymentMethod || 'cash',
        paymentStatus: 'paid',
        status: 'completed',
        notes,
        cashier: req.user.id
    });

    // Update product quantities and create inventory records
    for (const item of orderItems) {
        const product = await Product.findById(item.product);
        const previousQuantity = product.quantity;
        product.quantity -= item.quantity;
        await product.save();

        await Inventory.create({
            product: item.product,
            type: 'out',
            quantity: item.quantity,
            previousQuantity,
            newQuantity: product.quantity,
            reason: 'sale',
            reference: order.orderNumber,
            createdBy: req.user.id
        });
    }

    // Update customer stats if customer exists
    if (customer) {
        await Customer.findByIdAndUpdate(customer, {
            $inc: {
                totalPurchases: totalAmount,
                loyaltyPoints: Math.floor(totalAmount / 100) // 1 point per 100
            }
        });
    }

    const populatedOrder = await Order.findById(order._id)
        .populate('customer', 'name phone')
        .populate('cashier', 'name');

    res.status(201).json({
        success: true,
        message: 'Order created successfully',
        data: populatedOrder
    });
});

// @desc    Cancel order
// @route   PUT /api/orders/:id/cancel
// @access  Private/Admin/Manager
exports.cancelOrder = asyncHandler(async (req, res) => {
    const order = await Order.findById(req.params.id);

    if (!order) {
        return res.status(404).json({
            success: false,
            message: 'Order not found'
        });
    }

    if (order.status === 'cancelled') {
        return res.status(400).json({
            success: false,
            message: 'Order is already cancelled'
        });
    }

    // Restore product quantities
    for (const item of order.items) {
        const product = await Product.findById(item.product);
        if (product) {
            const previousQuantity = product.quantity;
            product.quantity += item.quantity;
            await product.save();

            await Inventory.create({
                product: item.product,
                type: 'in',
                quantity: item.quantity,
                previousQuantity,
                newQuantity: product.quantity,
                reason: 'return',
                reference: order.orderNumber,
                notes: 'Order cancelled',
                createdBy: req.user.id
            });
        }
    }

    // Update customer stats if customer exists
    if (order.customer) {
        await Customer.findByIdAndUpdate(order.customer, {
            $inc: {
                totalPurchases: -order.totalAmount,
                loyaltyPoints: -Math.floor(order.totalAmount / 100)
            }
        });
    }

    order.status = 'cancelled';
    order.paymentStatus = 'refunded';
    await order.save();

    res.status(200).json({
        success: true,
        message: 'Order cancelled successfully',
        data: order
    });
});

// @desc    Get order by order number
// @route   GET /api/orders/number/:orderNumber
// @access  Private
exports.getOrderByNumber = asyncHandler(async (req, res) => {
    const order = await Order.findOne({ orderNumber: req.params.orderNumber })
        .populate('customer', 'name phone email')
        .populate('cashier', 'name')
        .populate('items.product', 'name sku');

    if (!order) {
        return res.status(404).json({
            success: false,
            message: 'Order not found'
        });
    }

    res.status(200).json({
        success: true,
        data: order
    });
});
