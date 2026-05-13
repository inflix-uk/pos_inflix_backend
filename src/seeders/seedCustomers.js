const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../../.env') });

const Customer = require('../models/Customer');

const customers = [
    { name: 'Ali Hassan', email: 'ali.hassan@email.com', phone: '+92-300-1234567', address: { street: 'House 123, Block 5', city: 'Karachi', state: 'Sindh', zipCode: '75500', country: 'Pakistan' }, loyaltyPoints: 150, totalPurchases: 25, isActive: true },
    { name: 'Fatima Ahmed', email: 'fatima.ahmed@email.com', phone: '+92-301-2345678', address: { street: 'Flat 45, Garden Town', city: 'Lahore', state: 'Punjab', zipCode: '54000', country: 'Pakistan' }, loyaltyPoints: 320, totalPurchases: 48, isActive: true },
    { name: 'Muhammad Usman', email: 'usman.m@email.com', phone: '+92-302-3456789', address: { street: 'Street 7, Sector F-8', city: 'Islamabad', state: 'ICT', zipCode: '44000', country: 'Pakistan' }, loyaltyPoints: 85, totalPurchases: 12, isActive: true },
    { name: 'Ayesha Khan', email: 'ayesha.khan@email.com', phone: '+92-303-4567890', address: { street: 'Plaza Heights, DHA', city: 'Karachi', state: 'Sindh', zipCode: '75600', country: 'Pakistan' }, loyaltyPoints: 500, totalPurchases: 72, isActive: true },
    { name: 'Bilal Malik', email: 'bilal.malik@email.com', phone: '+92-304-5678901', address: { street: 'Model Town Extension', city: 'Faisalabad', state: 'Punjab', zipCode: '38000', country: 'Pakistan' }, loyaltyPoints: 200, totalPurchases: 30, isActive: true },
    { name: 'Sana Qureshi', email: 'sana.q@email.com', phone: '+92-305-6789012', address: { street: 'Gulberg III', city: 'Lahore', state: 'Punjab', zipCode: '54660', country: 'Pakistan' }, loyaltyPoints: 450, totalPurchases: 65, isActive: true },
    { name: 'Hassan Raza', email: 'hassan.raza@email.com', phone: '+92-306-7890123', address: { street: 'Bahria Town Phase 4', city: 'Rawalpindi', state: 'Punjab', zipCode: '46000', country: 'Pakistan' }, loyaltyPoints: 100, totalPurchases: 15, isActive: true },
    { name: 'Maryam Javed', email: 'maryam.j@email.com', phone: '+92-307-8901234', address: { street: 'Cantt Area', city: 'Multan', state: 'Punjab', zipCode: '60000', country: 'Pakistan' }, loyaltyPoints: 275, totalPurchases: 40, isActive: true },
    { name: 'Ahmed Sheikh', email: 'ahmed.sheikh@email.com', phone: '+92-308-9012345', address: { street: 'University Town', city: 'Peshawar', state: 'KPK', zipCode: '25000', country: 'Pakistan' }, loyaltyPoints: 180, totalPurchases: 28, isActive: true },
    { name: 'Zainab Ali', email: 'zainab.ali@email.com', phone: '+92-309-0123456', address: { street: 'Satellite Town', city: 'Quetta', state: 'Balochistan', zipCode: '87300', country: 'Pakistan' }, loyaltyPoints: 50, totalPurchases: 8, isActive: true },
    { name: 'Imran Hussain', email: 'imran.h@email.com', phone: '+92-310-1234567', address: { street: 'Civil Lines', city: 'Hyderabad', state: 'Sindh', zipCode: '71000', country: 'Pakistan' }, loyaltyPoints: 380, totalPurchases: 55, isActive: true },
    { name: 'Nadia Aslam', email: 'nadia.aslam@email.com', phone: '+92-311-2345678', address: { street: 'Defence Colony', city: 'Sialkot', state: 'Punjab', zipCode: '51310', country: 'Pakistan' }, loyaltyPoints: 220, totalPurchases: 33, isActive: true },
    { name: 'Kamran Shah', email: 'kamran.shah@email.com', phone: '+92-312-3456789', address: { street: 'Peoples Colony', city: 'Gujranwala', state: 'Punjab', zipCode: '52250', country: 'Pakistan' }, loyaltyPoints: 95, totalPurchases: 14, isActive: true },
    { name: 'Sara Iqbal', email: 'sara.iqbal@email.com', phone: '+92-313-4567890', address: { street: 'Johar Town', city: 'Lahore', state: 'Punjab', zipCode: '54000', country: 'Pakistan' }, loyaltyPoints: 600, totalPurchases: 88, isActive: true },
    { name: 'Inactive Customer', email: 'inactive@email.com', phone: '+92-300-0000000', address: { street: 'Unknown Street', city: 'Unknown', state: 'N/A', zipCode: '00000', country: 'Pakistan' }, loyaltyPoints: 0, totalPurchases: 2, isActive: false }
];

const seed = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('MongoDB Connected');

        console.log('\nSeeding Customers...\n');

        await Customer.deleteMany({});
        const created = await Customer.insertMany(customers);
        console.log(`✓ ${created.length} Customers seeded`);

        console.log('\n✅ Customers seeding completed!\n');
        process.exit(0);
    } catch (error) {
        console.error('❌ Seeding failed:', error.message);
        process.exit(1);
    }
};

seed();
