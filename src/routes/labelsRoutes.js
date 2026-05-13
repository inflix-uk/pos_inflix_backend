const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../middleware/auth');
const {
    getLabelProducts,
    resolveSerials,
    getLabelLocations,
    logLabelsPrinted
} = require('../controllers/labelsController');

router.use(protect);
router.use(requirePermission('inventory.print_labels'));

router.get('/products', getLabelProducts);
router.get('/locations', getLabelLocations);
router.post('/serials/resolve', resolveSerials);
router.post('/log-print', logLabelsPrinted);

module.exports = router;
