const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../middleware/auth');
const {
    getPricingGroups,
    getPricingGroup,
    createPricingGroup,
    updatePricingGroup,
    deletePricingGroup,
    getProductPricesForGroup,
    getVariantPricesForGroup,
    setVariantGroupPrice
} = require('../controllers/pricingGroupController');

router.use(protect);

router.get('/', requirePermission('customer.view', 'product.view'), getPricingGroups);
router.post('/', requirePermission('customer.edit'), createPricingGroup);
router.get('/:id/product-prices', requirePermission('customer.view', 'product.view'), getProductPricesForGroup);
router.get('/:id/variant-prices', requirePermission('customer.view', 'product.view'), getVariantPricesForGroup);
router.put('/:id/variant-prices', requirePermission('customer.edit'), setVariantGroupPrice);
router.get('/:id', requirePermission('customer.view', 'product.view'), getPricingGroup);
router.put('/:id', requirePermission('customer.edit'), updatePricingGroup);
router.delete('/:id', requirePermission('customer.edit'), deletePricingGroup);

module.exports = router;
