const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../middleware/auth');
const { check } = require('../controllers/platformConnectionController');

router.get('/check', protect, requirePermission('user.manage'), check);

module.exports = router;
