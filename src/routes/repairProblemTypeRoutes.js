const express = require('express');
const router = express.Router();
const { protect, requirePermission, requireFeature } = require('../middleware/auth');
const {
    listProblemTypes,
    createProblemType,
    deleteProblemType,
} = require('../controllers/repairProblemTypeController');

router.use(protect);
router.use(requireFeature('repairs'));

router
    .route('/')
    .get(requirePermission('repair.view', 'repair.create', 'repair.edit'), listProblemTypes)
    .post(requirePermission('repair.create', 'repair.edit'), createProblemType);

router
    .route('/:id')
    .delete(requirePermission('repair.create', 'repair.edit'), deleteProblemType);

module.exports = router;
