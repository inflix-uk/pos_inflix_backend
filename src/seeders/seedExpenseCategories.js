/**
 * Seed default expense categories. Idempotent: upsert by name.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const ExpenseCategoryExport = require('../models/ExpenseCategory');

function expenseCategoryModelOnConnection(conn) {
    const schema = ExpenseCategoryExport.schema;
    const modelName = ExpenseCategoryExport.modelName;
    return conn.models[modelName] || conn.model(modelName, schema);
}

const DEFAULT_CATEGORIES = [
    { name: 'Rent & Premises', code: 'RENT', costCentre: 'Admin', defaultVatRate: 0 },
    { name: 'Utilities', code: 'UTIL', costCentre: 'Admin', defaultVatRate: 5 },
    { name: 'Internet & Communications', code: 'TELECOM', costCentre: 'Admin', defaultVatRate: 20 },
    { name: 'Payroll & Staffing', code: 'PAYROLL', costCentre: 'Admin', defaultVatRate: 0 },
    { name: 'Office & Consumables', code: 'OFFICE', costCentre: 'Admin', defaultVatRate: 20 },
    { name: 'Logistics & Shipping', code: 'LOGISTICS', costCentre: 'Warehouse', defaultVatRate: 20 },
    { name: 'Travel & Vehicle', code: 'TRAVEL', costCentre: 'Admin', defaultVatRate: 20 },
    { name: 'Repairs Department', code: 'REPAIRS', costCentre: 'Repairs', defaultVatRate: 20 },
    { name: 'Payments & Bank Fees', code: 'BANK', costCentre: 'Admin', defaultVatRate: 0 },
    { name: 'Software & Subscriptions', code: 'SOFTWARE', costCentre: 'Admin', defaultVatRate: 20 },
    { name: 'Marketing & Sales', code: 'MARKETING', costCentre: 'Sales', defaultVatRate: 20 },
    { name: 'Professional Services', code: 'PROF', costCentre: 'Admin', defaultVatRate: 20 },
    { name: 'Taxes & Licenses', code: 'TAX', costCentre: 'Admin', defaultVatRate: 0 },
    { name: 'Insurance', code: 'INS', costCentre: 'Admin', defaultVatRate: 0 },
    { name: 'Miscellaneous', code: 'MISC', costCentre: 'General', defaultVatRate: 20 },
];

async function seedExpenseCategoriesOnConnection(conn) {
    const ExpenseCategory = expenseCategoryModelOnConnection(conn);
    for (const c of DEFAULT_CATEGORIES) {
        await ExpenseCategory.findOneAndUpdate(
            { name: c.name },
            { $set: { ...c, isActive: true } },
            { upsert: true, new: true }
        );
    }
}

async function run() {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
        console.error('MONGODB_URI required');
        process.exit(1);
    }
    await mongoose.connect(uri);
    await seedExpenseCategoriesOnConnection(mongoose.connection);
    console.log('Seeded ' + DEFAULT_CATEGORIES.length + ' expense categories');
    await mongoose.disconnect();
}

if (require.main === module) {
    run().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = {
    DEFAULT_CATEGORIES,
    seedExpenseCategoriesOnConnection,
    expenseCategoryModelOnConnection,
};
