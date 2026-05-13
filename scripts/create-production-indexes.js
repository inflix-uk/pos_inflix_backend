/**
 * Create production indexes for multi-tenant + multi-location architecture.
 * Run: node scripts/create-production-indexes.js
 * 
 * WARNING: This script creates indexes on production database.
 * Ensure you have backups and run during low-traffic period.
 */

const mongoose = require('mongoose');
require('dotenv').config({ path: '.env' });

async function createIndexes() {
    if (!process.env.MONGODB_URI) {
        console.error('❌ MONGODB_URI not set in .env');
        process.exit(1);
    }

    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    const db = mongoose.connection.db;
    console.log('✅ Connected');

    try {
        console.log('\n📊 Creating indexes...\n');

        // Sale indexes
        console.log('Creating Sale indexes...');
        await db.collection('sales').createIndex({ tenantId: 1, locationId: 1 }, { background: true });
        await db.collection('sales').createIndex({ tenantId: 1, status: 1, createdAt: -1 }, { background: true });
        console.log('  ✅ Sale indexes created');

        // Repair indexes
        console.log('Creating Repair indexes...');
        await db.collection('repairs').createIndex({ tenantId: 1, locationId: 1 }, { background: true });
        await db.collection('repairs').createIndex({ tenantId: 1, status: 1 }, { background: true });
        console.log('  ✅ Repair indexes created');

        // SalesReturn indexes
        console.log('Creating SalesReturn indexes...');
        await db.collection('salesreturns').createIndex({ tenantId: 1, locationId: 1 }, { background: true });
        await db.collection('salesreturns').createIndex({ tenantId: 1, createdAt: -1 }, { background: true });
        console.log('  ✅ SalesReturn indexes created');

        // StockAdjustment indexes
        console.log('Creating StockAdjustment indexes...');
        await db.collection('stockadjustments').createIndex({ tenantId: 1, locationId: 1 }, { background: true });
        await db.collection('stockadjustments').createIndex({ tenantId: 1, status: 1 }, { background: true });
        console.log('  ✅ StockAdjustment indexes created');

        // StockTransfer indexes
        console.log('Creating StockTransfer indexes...');
        await db.collection('stock_transfers').createIndex({ tenantId: 1, fromLocationId: 1 }, { background: true });
        await db.collection('stock_transfers').createIndex({ tenantId: 1, toLocationId: 1 }, { background: true });
        await db.collection('stock_transfers').createIndex({ tenantId: 1, status: 1 }, { background: true });
        console.log('  ✅ StockTransfer indexes created');

        // Purchase indexes
        console.log('Creating Purchase indexes...');
        await db.collection('purchases').createIndex({ tenantId: 1, status: 1 }, { background: true });
        await db.collection('purchases').createIndex({ tenantId: 1, createdAt: -1 }, { background: true });
        console.log('  ✅ Purchase indexes created');

        // Product indexes
        console.log('Creating Product indexes...');
        await db.collection('products').createIndex({ tenantId: 1, isActive: 1 }, { background: true });
        await db.collection('products').createIndex({ tenantId: 1, barcode: 1 }, { background: true, sparse: true });
        console.log('  ✅ Product indexes created');

        // Customer indexes
        console.log('Creating Customer indexes...');
        await db.collection('customers').createIndex({ tenantId: 1, isActive: 1 }, { background: true });
        await db.collection('customers').createIndex({ tenantId: 1, email: 1 }, { background: true, sparse: true });
        console.log('  ✅ Customer indexes created');

        // Location indexes
        console.log('Creating Location indexes...');
        await db.collection('locations').createIndex({ tenantId: 1, isActive: 1 }, { background: true });
        console.log('  ✅ Location indexes created');

        // User indexes
        console.log('Creating User indexes...');
        await db.collection('users').createIndex({ tenantId: 1, isActive: 1 }, { background: true });
        console.log('  ✅ User indexes created');

        console.log('\n✅ All production indexes created successfully!');
        console.log('\n📝 Note: Indexes are being built in the background.');
        console.log('   Monitor index build progress in MongoDB Atlas or your MongoDB monitoring tool.\n');

    } catch (error) {
        console.error('\n❌ Error creating indexes:', error.message);
        throw error;
    } finally {
        await mongoose.disconnect();
        console.log('🔌 Disconnected from MongoDB');
    }
}

// Run if called directly
if (require.main === module) {
    createIndexes()
        .then(() => {
            console.log('✅ Script completed successfully');
            process.exit(0);
        })
        .catch((error) => {
            console.error('❌ Script failed:', error);
            process.exit(1);
        });
}

module.exports = { createIndexes };
