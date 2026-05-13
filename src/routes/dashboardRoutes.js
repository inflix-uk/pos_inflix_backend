const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { getDashboard, globalSearch } = require('../controllers/dashboardController');

router.use(protect);

router.get('/', getDashboard);
router.get('/search', globalSearch);

module.exports = router;
