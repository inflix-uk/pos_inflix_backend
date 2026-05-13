const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../middleware/auth');
const {
    recordCustomerPayment,
    recordCustomerRefund,
    recordBalanceAdjustment,
    updateLedgerEntry,
    deleteLedgerEntry,
    getCustomerStatement,
    recordPurchasePayment,
    recordSupplierPayment,
    getSupplierStatement,
    getBalanceSheet,
    getTrialBalance,
    getProfitAndLoss,
    getDebtorsCreditors,
    getAccountsForSales
} = require('../controllers/accountsController');
const { getPaymentAccounts, createMoneyTransfer } = require('../controllers/paymentAccountController');

router.use(protect);

router.get('/payment-accounts', requirePermission('accounts.view', 'report.view'), getPaymentAccounts);
// Combined customers + suppliers list for create-sales account dropdown.
router.get('/for-sales', requirePermission('sale.create', 'customer.view', 'supplier.view'), getAccountsForSales);
router.post('/money-transfer', requirePermission('accounts.payment'), createMoneyTransfer);
router.post('/customer-payment', requirePermission('accounts.payment'), recordCustomerPayment);
router.post('/customer-refund', requirePermission('accounts.payment'), recordCustomerRefund);
router.post('/balance-adjustment', requirePermission('accounts.payment'), recordBalanceAdjustment);
router.put('/ledger-entry/:id', requirePermission('accounts.payment'), updateLedgerEntry);
router.delete('/ledger-entry/:id', requirePermission('accounts.payment'), deleteLedgerEntry);
router.get('/balance-sheet', requirePermission('accounts.view', 'report.view'), getBalanceSheet);
router.get('/debtors-creditors', requirePermission('accounts.view', 'report.view'), getDebtorsCreditors);
router.get('/trial-balance', requirePermission('accounts.view', 'report.view'), getTrialBalance);
router.get('/profit-and-loss', requirePermission('accounts.view', 'report.view'), getProfitAndLoss);
router.get('/customer/:id/statement', requirePermission('accounts.view'), getCustomerStatement);
router.get('/supplier/:id/statement', requirePermission('accounts.view'), getSupplierStatement);
router.post('/purchase/:id/pay', requirePermission('accounts.payment'), recordPurchasePayment);
router.post('/supplier-payment', requirePermission('accounts.payment'), recordSupplierPayment);

module.exports = router;
