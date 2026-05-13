/**
 * Drop the entire database and remove all data (including users).
 * Use this when you want a completely fresh start.
 *
 * Run: npm run db:clear-all
 *
 * After running, re-seed with:
 *   npm run seed
 *   npm run seed:admin
 *   npm run seed:rbac
 *   (optionally: seed:uk-accounts, seed:expense-categories, etc.)
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const mongoose = require('mongoose');

async function clearDatabase() {
    if (!process.env.MONGODB_URI) {
        console.error('MONGODB_URI is not set in .env');
        process.exit(1);
    }

    try {
        await mongoose.connect(process.env.MONGODB_URI);
        const db = mongoose.connection.db;
        const dbName = db.databaseName;

        await db.dropDatabase();
        console.log(`Dropped database: ${dbName}`);
        console.log('All collections and data have been removed.');
        console.log('');
        console.log('To start fresh, run:');
        console.log('  npm run seed');
        console.log('  npm run seed:admin');
        console.log('  npm run seed:rbac');
    } catch (err) {
        console.error('Error:', err.message);
        process.exit(1);
    } finally {
        await mongoose.disconnect();
        process.exit(0);
    }
}

clearDatabase();
