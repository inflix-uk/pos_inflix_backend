const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { getMyEntitlements } = require('../controllers/entitlementsController');

router.use(protect);
router.get('/', getMyEntitlements);

module.exports = router;
