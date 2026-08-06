const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../middleware/auth');
const {
    getPurchases,
    getPurchase,
    createPurchase,
    updatePurchase,
    updatePurchaseDetails,
    updatePurchaseItemQuantity,
    deletePurchaseItem,
    deletePurchase,
    restorePurchaseBrandModels,
    getStockList,
    getStockViewRows,
    getFindInStockSerial,
    getFindInStockSerialsBatch,
    searchNonSerialProducts,
    searchSerialProducts,
    salesTypeahead
} = require('../controllers/purchaseController');

// All routes require authentication
router.use(protect);

router.get('/non-serial/search', requirePermission('purchase.view', 'parcel.create', 'purchase.create'), searchNonSerialProducts);
router.get('/serial/search', requirePermission('purchase.view', 'parcel.create', 'purchase.create'), searchSerialProducts);
// Dedicated, indexed typeahead used by /create-sales item search.
router.get('/sales-typeahead', requirePermission('purchase.view', 'sale.create'), salesTypeahead);
router.get('/stock-list', requirePermission('stock.view', 'purchase.view'), getStockList);
router.get('/stock-view-rows', requirePermission('stock.view', 'purchase.view'), getStockViewRows);
router.get('/find-in-stock-serial/:serial', requirePermission('stock.view', 'purchase.view', 'purchase.return'), getFindInStockSerial);
router.post('/find-in-stock-serials', requirePermission('stock.view', 'purchase.view', 'purchase.return'), getFindInStockSerialsBatch);

router.route('/')
    .get(requirePermission('purchase.view', 'sale.create'), getPurchases)
    .post(requirePermission('purchase.create', 'parcel.create'), createPurchase);

router.patch('/:id/details', updatePurchaseDetails);
router.patch('/:purchaseId/items/:itemId', requirePermission('purchase.edit'), updatePurchaseItemQuantity);
router.delete('/:purchaseId/items/:itemId', requirePermission('purchase.edit'), deletePurchaseItem);
router.post('/:id/restore-brand-models', requirePermission('purchase.edit'), restorePurchaseBrandModels);

router.route('/:id')
    .get(requirePermission('purchase.view'), getPurchase)
    .put(requirePermission('purchase.edit'), updatePurchase)
    .delete(requirePermission('purchase.edit'), deletePurchase);

module.exports = router;
