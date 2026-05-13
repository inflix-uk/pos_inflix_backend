const Stock = require('../models/Stock');
const asyncHandler = require('../middleware/asyncHandler');

// Helper to format date
const formatDate = (date) => {
    return new Date(date).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric'
    });
};

// Transform stock for frontend
const transformStock = (stock) => {
    const obj = stock.toObject();
    return {
        id: obj._id.toString(),
        warehouse: obj.warehouse,
        store: obj.store,
        product: obj.product,
        date: formatDate(obj.date),
        person: obj.person,
        qty: obj.qty,
        status: obj.status
    };
};

// @desc    Get all stocks
// @route   GET /api/stocks
// @access  Private
exports.getStocks = asyncHandler(async (req, res) => {
    const query = {};

    if (req.query.warehouse && req.query.warehouse !== 'All') {
        query.warehouse = req.query.warehouse;
    }

    if (req.query.store && req.query.store !== 'All') {
        query.store = req.query.store;
    }

    if (req.query.search) {
        query.$or = [
            { warehouse: { $regex: req.query.search, $options: 'i' } },
            { store: { $regex: req.query.search, $options: 'i' } },
            { 'product.name': { $regex: req.query.search, $options: 'i' } },
            { 'person.name': { $regex: req.query.search, $options: 'i' } }
        ];
    }

    const stocks = await Stock.find(query).sort('-createdAt');
    const transformedStocks = stocks.map(transformStock);

    res.status(200).json(transformedStocks);
});

// @desc    Get single stock
// @route   GET /api/stocks/:id
// @access  Private
exports.getStock = asyncHandler(async (req, res) => {
    const stock = await Stock.findById(req.params.id);

    if (!stock) {
        return res.status(404).json({
            success: false,
            message: 'Stock not found'
        });
    }

    res.status(200).json(transformStock(stock));
});

// @desc    Create stock
// @route   POST /api/stocks
// @access  Private
exports.createStock = asyncHandler(async (req, res) => {
    const stock = await Stock.create({
        warehouse: req.body.warehouse,
        store: req.body.store,
        product: {
            name: req.body.product,
            icon: req.body.icon || '📦'
        },
        date: req.body.date || new Date(),
        person: {
            name: req.body.person,
            avatar: req.body.avatar || '👤'
        },
        qty: req.body.qty || 0,
        status: req.body.status || 'In Stock'
    });

    res.status(201).json(transformStock(stock));
});

// @desc    Update stock
// @route   PUT /api/stocks/:id
// @access  Private
exports.updateStock = asyncHandler(async (req, res) => {
    let stock = await Stock.findById(req.params.id);

    if (!stock) {
        return res.status(404).json({
            success: false,
            message: 'Stock not found'
        });
    }

    const updateData = {};
    if (req.body.warehouse) updateData.warehouse = req.body.warehouse;
    if (req.body.store) updateData.store = req.body.store;
    if (req.body.product) {
        updateData.product = {
            name: req.body.product,
            icon: req.body.icon || stock.product.icon
        };
    }
    if (req.body.person) {
        updateData.person = {
            name: req.body.person,
            avatar: req.body.avatar || stock.person.avatar
        };
    }
    if (req.body.qty !== undefined) updateData.qty = req.body.qty;
    if (req.body.status) updateData.status = req.body.status;

    stock = await Stock.findByIdAndUpdate(req.params.id, updateData, {
        new: true,
        runValidators: true
    });

    res.status(200).json(transformStock(stock));
});

// @desc    Delete stock
// @route   DELETE /api/stocks/:id
// @access  Private/Admin
exports.deleteStock = asyncHandler(async (req, res) => {
    const stock = await Stock.findById(req.params.id);

    if (!stock) {
        return res.status(404).json({
            success: false,
            message: 'Stock not found'
        });
    }

    await stock.deleteOne();

    res.status(200).json({
        success: true,
        message: 'Stock deleted successfully'
    });
});
