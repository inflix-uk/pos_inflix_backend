/**
 * Clear all database collections EXCEPT users, roles, and permissions.
 * Keeps user accounts and their RBAC (roles + permissions) so admin keeps access.
 * Run: npm run db:clear
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const mongoose = require('mongoose');

const KEEP_COLLECTIONS = ['users', 'roles', 'permissions'];

async function clearDatabaseKeepUsers() {
    if (!process.env.MONGODB_URI) {
        console.error('MONGODB_URI is not set in .env');
        process.exit(1);
    }

    try {
        await mongoose.connect(process.env.MONGODB_URI);
        const db = mongoose.connection.db;
        const collections = await db.listCollections().toArray();
        const names = collections.map((c) => c.name);

        for (const name of names) {
            const keep = KEEP_COLLECTIONS.some(
                (k) => k === name || name.toLowerCase() === k.toLowerCase()
            );
            if (keep) {
                console.log(`Keeping: ${name}`);
                continue;
            }
            const result = await db.collection(name).deleteMany({});
            console.log(`Cleared: ${name} (${result.deletedCount} documents)`);
        }

        console.log('Done. Users, roles, and permissions were kept; all other data was removed.');
    } catch (err) {
        console.error('Error:', err.message);
        process.exit(1);
    } finally {
        await mongoose.disconnect();
        process.exit(0);
    }
}

clearDatabaseKeepUsers();
