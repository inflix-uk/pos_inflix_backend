/**
 * Create or update a platform admin user (PlatformUser). Not stored in User collection.
 * Usage: node src/seeders/seedPlatformAdmin.js --email hello@inflix.co.uk --password "YourStrongPassword1!"
 * Optional: --allowlist  to allow only emails in PLATFORM_ADMIN_EMAILS (for first PlatformUser).
 */
require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const config = require('../config');

const PlatformUser = require('../models/PlatformUser');

const args = process.argv.slice(2);
function getArg(name) {
    const i = args.indexOf(name);
    if (i === -1) return null;
    return args[i + 1] || null;
}

async function run() {
    const email = getArg('--email');
    const password = getArg('--password');
    const allowlistOnly = args.includes('--allowlist');

    if (!email || !password) {
        console.error('Usage: node src/seeders/seedPlatformAdmin.js --email <email> --password "<password>" [--allowlist]');
        process.exit(1);
    }

    const normalizedEmail = email.trim().toLowerCase();
    if (allowlistOnly) {
        const allowlist = (process.env.PLATFORM_ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
        if (!allowlist.includes(normalizedEmail)) {
            console.error('Email not in PLATFORM_ADMIN_EMAILS allowlist. Set PLATFORM_ADMIN_EMAILS in .env or omit --allowlist.');
            process.exit(1);
        }
    }

    await mongoose.connect(process.env.MONGODB_URI || config.mongodbUri);
    const existing = await PlatformUser.findOne({ email: normalizedEmail });
    const salt = await bcrypt.genSalt(config.bcryptSaltRounds || 10);
    const passwordHash = await bcrypt.hash(password, salt);

    if (existing) {
        existing.passwordHash = passwordHash;
        existing.updatedAtUtc = new Date();
        await existing.save();
        console.log('Updated platform admin:', normalizedEmail);
    } else {
        await PlatformUser.create({
            email: normalizedEmail,
            passwordHash,
            role: 'platform_admin',
            isActive: true
        });
        console.log('Created platform admin:', normalizedEmail);
    }
    await mongoose.disconnect();
    process.exit(0);
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
