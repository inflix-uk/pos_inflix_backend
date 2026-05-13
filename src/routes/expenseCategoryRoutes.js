const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const {
    getCategories,
    getCategoryById,
    createCategory,
    updateCategory,
    archiveCategory,
    setInactive
} = require('../controllers/expenseCategoryController');

router.use(protect);

router.get('/', getCategories);
router.get('/:id', getCategoryById);
router.post('/', createCategory);
router.put('/:id', updateCategory);
router.post('/:id/archive', archiveCategory);
router.post('/:id/set-inactive', setInactive);

module.exports = router;
