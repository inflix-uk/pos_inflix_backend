const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const {
    list,
    getById,
    create,
    update,
    submit,
    approve,
    reject,
    markPaid,
    voidExpense,
    deleteExpense,
    reportTotals
} = require('../controllers/expenseController');

router.use(protect);

router.get('/', list);
router.get('/report/totals', reportTotals);
router.get('/:id', getById);
router.post('/', create);
router.put('/:id', update);
router.post('/:id/submit', submit);
router.post('/:id/approve', approve);
router.post('/:id/reject', reject);
router.post('/:id/mark-paid', markPaid);
router.post('/:id/void', voidExpense);
router.delete('/:id', deleteExpense);

module.exports = router;
