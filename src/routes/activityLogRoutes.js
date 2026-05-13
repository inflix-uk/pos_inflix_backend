const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../middleware/auth');
const { getActivityLog, getActivityLogById, getActivityLogOptions } = require('../controllers/activityLogController');

router.use(protect);
router.use(requirePermission('audit.view'));

router.get('/options', getActivityLogOptions);
router.get('/', getActivityLog);
router.get('/:id', getActivityLogById);

module.exports = router;
