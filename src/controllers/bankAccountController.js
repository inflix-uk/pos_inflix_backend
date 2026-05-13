const BankAccount = require('../models/BankAccount');
const asyncHandler = require('../middleware/asyncHandler');
const { getTenantIdFromReq } = require('../middleware/auth');
const cache = require('../lib/cache');
const TTL = require('../lib/cacheTTL');

const BANK_ACCOUNT_CACHE_NAMESPACES = ['bankAccounts:list'];
async function invalidateBankAccountCaches(tenantId) {
    await cache.bumpMany(BANK_ACCOUNT_CACHE_NAMESPACES, tenantId);
}

// @desc    Get all bank accounts
// @route   GET /api/settings/bank-accounts
// @access  Private
exports.getBankAccounts = asyncHandler(async (req, res) => {
    const tenantId = getTenantIdFromReq(req);

    const params = {
        isActive: req.query.isActive,
    };

    const payload = await cache.cached(
        { ns: 'bankAccounts:list', tenantId, params, ttlSec: TTL.REFERENCE },
        async () => {
            const query = {};

            if (req.query.isActive !== undefined) {
                query.isActive = req.query.isActive === 'true';
            }

            const bankAccounts = await BankAccount.find(query).sort({ isDefault: -1, createdAt: -1 }).lean();
            return { bankAccounts };
        }
    );

    res.status(200).json({
        success: true,
        count: payload.bankAccounts.length,
        data: payload.bankAccounts
    });
});

// @desc    Get single bank account
// @route   GET /api/settings/bank-accounts/:id
// @access  Private
exports.getBankAccount = asyncHandler(async (req, res) => {
    const bankAccount = await BankAccount.findById(req.params.id);

    if (!bankAccount) {
        return res.status(404).json({
            success: false,
            message: 'Bank account not found'
        });
    }

    res.status(200).json({
        success: true,
        data: bankAccount
    });
});

// @desc    Create bank account
// @route   POST /api/settings/bank-accounts
// @access  Private/Admin/Manager
exports.createBankAccount = asyncHandler(async (req, res) => {
    const {
        accountName,
        bankName,
        accountNumber,
        sortCode,
        iban,
        swiftBic,
        branchAddress,
        isDefault,
        isActive
    } = req.body;

    // If this is the first account or set as default, make it default
    const existingAccounts = await BankAccount.countDocuments();
    const shouldBeDefault = existingAccounts === 0 || isDefault;

    // If setting as default, unset other defaults
    if (shouldBeDefault) {
        await BankAccount.updateMany({}, { isDefault: false });
    }

    const bankAccount = await BankAccount.create({
        accountName,
        bankName,
        accountNumber,
        sortCode,
        iban,
        swiftBic,
        branchAddress,
        isDefault: shouldBeDefault,
        isActive: isActive !== undefined ? isActive : true,
        createdBy: req.user._id
    });

    await invalidateBankAccountCaches(getTenantIdFromReq(req));

    res.status(201).json({
        success: true,
        message: 'Bank account created successfully',
        data: bankAccount
    });
});

// @desc    Update bank account
// @route   PUT /api/settings/bank-accounts/:id
// @access  Private/Admin/Manager
exports.updateBankAccount = asyncHandler(async (req, res) => {
    let bankAccount = await BankAccount.findById(req.params.id);

    if (!bankAccount) {
        return res.status(404).json({
            success: false,
            message: 'Bank account not found'
        });
    }

    // If setting as default, unset other defaults
    if (req.body.isDefault) {
        await BankAccount.updateMany(
            { _id: { $ne: req.params.id } },
            { isDefault: false }
        );
    }

    const updateData = { ...req.body, updatedBy: req.user._id };

    bankAccount = await BankAccount.findByIdAndUpdate(
        req.params.id,
        updateData,
        {
            new: true,
            runValidators: true
        }
    );

    await invalidateBankAccountCaches(getTenantIdFromReq(req));

    res.status(200).json({
        success: true,
        message: 'Bank account updated successfully',
        data: bankAccount
    });
});

// @desc    Delete bank account
// @route   DELETE /api/settings/bank-accounts/:id
// @access  Private/Admin
exports.deleteBankAccount = asyncHandler(async (req, res) => {
    const bankAccount = await BankAccount.findById(req.params.id);

    if (!bankAccount) {
        return res.status(404).json({
            success: false,
            message: 'Bank account not found'
        });
    }

    const wasDefault = bankAccount.isDefault;

    await bankAccount.deleteOne();

    // If deleted account was default, set another as default
    if (wasDefault) {
        const firstAccount = await BankAccount.findOne().sort({ createdAt: 1 });
        if (firstAccount) {
            firstAccount.isDefault = true;
            await firstAccount.save();
        }
    }

    await invalidateBankAccountCaches(getTenantIdFromReq(req));

    res.status(200).json({
        success: true,
        message: 'Bank account deleted successfully'
    });
});

// @desc    Set bank account as default
// @route   PUT /api/settings/bank-accounts/:id/set-default
// @access  Private/Admin/Manager
exports.setDefaultBankAccount = asyncHandler(async (req, res) => {
    const bankAccount = await BankAccount.findById(req.params.id);

    if (!bankAccount) {
        return res.status(404).json({
            success: false,
            message: 'Bank account not found'
        });
    }

    // Unset all defaults
    await BankAccount.updateMany({}, { isDefault: false });

    // Set this one as default
    bankAccount.isDefault = true;
    bankAccount.updatedBy = req.user._id;
    await bankAccount.save();

    await invalidateBankAccountCaches(getTenantIdFromReq(req));

    res.status(200).json({
        success: true,
        message: 'Bank account set as default successfully',
        data: bankAccount
    });
});
