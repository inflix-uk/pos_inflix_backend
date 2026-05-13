const mongoose = require('mongoose');
const dotenv = require('dotenv');

// Load env vars
dotenv.config();

const User = require('../src/models/User');

const seedAdmin = async () => {
    try {
        // Connect to database  
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('MongoDB Connected...');
  
        // Check if admin already exists
        const existingAdmin = await User.findOne({ email: 'admin@gmail.com' });

        if (existingAdmin) {
            console.log('Admin user already exists!');
            console.log('Email: admin@gmail.com');
            process.exit(0);
        }

        // Create admin user
        const admin = await User.create({
            name: 'Admin',
            email: 'admin@gmail.com',
            password: 'admin123',
            role: 'admin',
            isActive: true
        });

        console.log('Admin user created successfully!');
        console.log('----------------------------');
        console.log('Email: admin@gmail.com');
        console.log('Password: admin123');
        console.log('Role: admin');
        console.log('----------------------------');

        process.exit(0);
    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    }
};

seedAdmin();
