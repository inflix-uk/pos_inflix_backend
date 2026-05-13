const mongoose = require('mongoose');

const bankAccountSchema = new mongoose.Schema({
    accountName: {
        type: String,
        required: [true, 'Account name is required'],
        trim: true,
        maxlength: [100, 'Account name cannot exceed 100 characters']
    },
    bankName: {
        type: String,
        required: [true, 'Bank name is required'],
        trim: true,
        maxlength: [100, 'Bank name cannot exceed 100 characters']
    },
    accountNumber: {
        type: String,
        required: [true, 'Account number is required'],
        trim: true,
        maxlength: [20, 'Account number cannot exceed 20 characters']
    },
    sortCode: {
        type: String,
        required: [true, 'Sort code is required'],
        trim: true,
        maxlength: [10, 'Sort code cannot exceed 10 characters'],
        validate: {
            validator: function(v) {
                // UK sort code format: XX-XX-XX or XXXXXX
                return /^(\d{2}-\d{2}-\d{2}|\d{6})$/.test(v);
            },
            message: 'Sort code must be in format XX-XX-XX or XXXXXX'
        }
    },
    iban: {
        type: String,
        trim: true,
        maxlength: [34, 'IBAN cannot exceed 34 characters'],
        default: ''
    },
    swiftBic: {
        type: String,
        trim: true,
        maxlength: [11, 'SWIFT/BIC cannot exceed 11 characters'],
        default: ''
    },
    branchAddress: {
        type: String,
        trim: true,
        maxlength: [500, 'Branch address cannot exceed 500 characters'],
        default: ''
    },
    isDefault: {
        type: Boolean,
        default: false
    },
    isActive: {
        type: Boolean,
        default: true
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    updatedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }
}, {
    timestamps: true
});

// Ensure only one default account
bankAccountSchema.pre('save', async function(next) {
    if (this.isDefault) {
        await this.constructor.updateMany(
            { _id: { $ne: this._id } },
            { isDefault: false }
        );
    }
    next();
});

module.exports = require('../lib/tenantModel')('BankAccount', bankAccountSchema);
