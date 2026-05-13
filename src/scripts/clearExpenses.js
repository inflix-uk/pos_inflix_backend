/**
 * Clear all documents from the expenses collection.
 * Run: npm run db:clear-expenses
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const mongoose = require('mongoose');
const Expense = require('../models/Expense');

async function clearExpenses() {
    if (!process.env.MONGODB_URI) {
        console.error('MONGODB_URI is not set in .env');
        process.exit(1);
    }

    try {
        await mongoose.connect(process.env.MONGODB_URI);
        const result = await Expense.deleteMany({});
        console.log(`Cleared expenses: ${result.deletedCount} document(s) removed.`);
    } catch (err) {
        console.error('Error:', err.message);
        process.exit(1);
    } finally {
        await mongoose.disconnect();
        process.exit(0);
    }
}

clearExpenses();
