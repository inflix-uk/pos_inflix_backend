const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { protect, requirePermission, requireFeature } = require('../middleware/auth');
const {
    getProducts,
    getProduct,
    getProductsByBarcodes,
    getProductByBarcode,
    getProductGroupPrices,
    putProductGroupPrices,
    getSerialHistory,
    createProduct,
    updateProduct,
    updateStock,
    updateProductLowStockThreshold,
    deleteProduct,
    getLowStockProducts,
    getExpiredProducts,
    getExpiringSoonProducts
} = require('../controllers/productController');

// All routes require authentication and inventory feature
router.use(protect);
router.use(requireFeature('inventory'));

// Validation rules
const productValidation = [
    body('name').notEmpty().withMessage('Product name is required'),
    body('sku').notEmpty().withMessage('SKU is required'),
    body('category').notEmpty().withMessage('Category is required'),
    body('costPrice').isNumeric().withMessage('Cost price must be a number'),
    body('sellingPrice').isNumeric().withMessage('Selling price must be a number')
];

const stockValidation = [
    body('quantity').isNumeric().withMessage('Quantity must be a number'),
    body('type').isIn(['in', 'out', 'adjustment']).withMessage('Invalid stock update type')
];

// Routes - permission-based (see config/routePermissions.js)
router.get('/low-stock', requirePermission('product.view', 'stock.view'), getLowStockProducts);
router.get('/expired', requirePermission('product.view', 'stock.view'), getExpiredProducts);
router.get('/expiring-soon', requirePermission('product.view', 'stock.view'), getExpiringSoonProducts);
router.get('/serial-history/:serialNumber', requirePermission('product.view'), getSerialHistory);
router.get('/by-barcodes', requirePermission('product.view'), getProductsByBarcodes);
router.get('/barcode/:barcode', requirePermission('product.view'), getProductByBarcode);

router.get('/:id/group-prices', requirePermission('product.view'), getProductGroupPrices);
router.put('/:id/group-prices', requirePermission('product.edit'), putProductGroupPrices);

router.route('/')
    .get(requirePermission('product.view'), getProducts)
    .post(requirePermission('product.create'), productValidation, validate, createProduct);

router.route('/:id')
    .get(requirePermission('product.view'), getProduct)
    .put(requirePermission('product.edit'), updateProduct)
    .delete(requirePermission('product.delete'), deleteProduct);

router.put('/:id/stock', requirePermission('stock.adjust'), stockValidation, validate, updateStock);
router.put('/:id/low-stock-threshold', requirePermission('product.edit'), updateProductLowStockThreshold);

module.exports = router;
