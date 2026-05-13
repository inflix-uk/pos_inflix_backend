const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

// Load env vars
dotenv.config({ path: path.join(__dirname, '../../.env') });

// Import model
const Coupon = require('../models/Coupon');

// Helper function to get future date
const getFutureDate = (days) => {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return date;
};

// Helper function to get past date
const getPastDate = (days) => {
    const date = new Date();
    date.setDate(date.getDate() - days);
    return date;
};

// Coupon data - 10 different coupons
const couponsData = [
    {
        name: 'New Year Blast',
        code: 'NEWYEAR30',
        description: '30% off on all products for New Year celebration',
        type: 'Percentage',
        discount: 30,
        limit: 100,
        startDate: getPastDate(30),
        endDate: getFutureDate(60),
        product: 'All',
        oncePerCustomer: false,
        status: 'Active',
        minPurchaseAmount: 50,
        maxDiscountAmount: 100
    },
    {
        name: 'Welcome Discount',
        code: 'WELCOME15',
        description: '15% off for first-time customers',
        type: 'Percentage',
        discount: 15,
        limit: 1,
        startDate: getPastDate(60),
        endDate: getFutureDate(365),
        product: 'All',
        oncePerCustomer: true,
        status: 'Active',
        minPurchaseAmount: 0,
        maxDiscountAmount: 50
    },
    {
        name: 'Flat $50 Off',
        code: 'FLAT50',
        description: '$50 off on orders above $200',
        type: 'Fixed Amount',
        discount: 50,
        limit: 500,
        startDate: getPastDate(15),
        endDate: getFutureDate(90),
        product: 'All',
        oncePerCustomer: false,
        status: 'Active',
        minPurchaseAmount: 200,
        maxDiscountAmount: null
    },
    {
        name: 'Weekend Special',
        code: 'WEEKEND20',
        description: '20% off on weekend purchases',
        type: 'Percentage',
        discount: 20,
        limit: 200,
        startDate: getPastDate(7),
        endDate: getFutureDate(30),
        product: 'All',
        oncePerCustomer: false,
        status: 'Active',
        minPurchaseAmount: 75,
        maxDiscountAmount: 75
    },
    {
        name: 'Summer Sale',
        code: 'SUMMER25',
        description: '25% off on summer collection',
        type: 'Percentage',
        discount: 25,
        limit: 300,
        startDate: getPastDate(45),
        endDate: getFutureDate(45),
        product: 'All',
        oncePerCustomer: false,
        status: 'Active',
        minPurchaseAmount: 100,
        maxDiscountAmount: 150
    },
    {
        name: 'Loyalty Reward',
        code: 'LOYAL10',
        description: '10% off for loyal customers',
        type: 'Percentage',
        discount: 10,
        limit: 3,
        startDate: getPastDate(90),
        endDate: getFutureDate(180),
        product: 'All',
        oncePerCustomer: false,
        status: 'Active',
        minPurchaseAmount: 0,
        maxDiscountAmount: null
    },
    {
        name: 'Flash Deal',
        code: 'FLASH40',
        description: '40% off - Limited time offer',
        type: 'Percentage',
        discount: 40,
        limit: 50,
        startDate: getPastDate(2),
        endDate: getFutureDate(5),
        product: 'All',
        oncePerCustomer: true,
        status: 'Active',
        minPurchaseAmount: 150,
        maxDiscountAmount: 200
    },
    {
        name: 'Bulk Order Discount',
        code: 'BULK100',
        description: '$100 off on orders above $500',
        type: 'Fixed Amount',
        discount: 100,
        limit: 100,
        startDate: getPastDate(30),
        endDate: getFutureDate(120),
        product: 'All',
        oncePerCustomer: false,
        status: 'Active',
        minPurchaseAmount: 500,
        maxDiscountAmount: null
    },
    {
        name: 'Expired Promo',
        code: 'EXPIRED20',
        description: 'This coupon has expired',
        type: 'Percentage',
        discount: 20,
        limit: 100,
        startDate: getPastDate(60),
        endDate: getPastDate(30),
        product: 'All',
        oncePerCustomer: false,
        status: 'Inactive',
        minPurchaseAmount: 50,
        maxDiscountAmount: 100
    },
    {
        name: 'VIP Exclusive',
        code: 'VIP35',
        description: '35% off exclusive for VIP members',
        type: 'Percentage',
        discount: 35,
        limit: 2,
        startDate: getPastDate(10),
        endDate: getFutureDate(90),
        product: 'All',
        oncePerCustomer: true,
        status: 'Active',
        minPurchaseAmount: 100,
        maxDiscountAmount: 250
    }
];

// Connect to database
const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('MongoDB Connected');
    } catch (error) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
    }
};

// Seed coupons
const seedCoupons = async () => {
    try {
        await connectDB();

        console.log('\n🌱 Starting coupon seeding...\n');

        // Clear existing coupons
        await Coupon.deleteMany({});
        console.log('✓ Cleared existing coupons');

        // Create coupons
        const createdCoupons = await Coupon.insertMany(couponsData);
        console.log(`✓ ${createdCoupons.length} Coupons seeded`);

        // Summary
        const activeCoupons = createdCoupons.filter(c => c.status === 'Active').length;
        const inactiveCoupons = createdCoupons.filter(c => c.status === 'Inactive').length;
        const percentageCoupons = createdCoupons.filter(c => c.type === 'Percentage').length;
        const fixedCoupons = createdCoupons.filter(c => c.type === 'Fixed Amount').length;

        console.log('\n📊 Coupon Summary:');
        console.log(`   - Active: ${activeCoupons}`);
        console.log(`   - Inactive: ${inactiveCoupons}`);
        console.log(`   - Percentage Type: ${percentageCoupons}`);
        console.log(`   - Fixed Amount Type: ${fixedCoupons}`);

        console.log('\n✅ Coupon seeding completed successfully!\n');

        process.exit(0);
    } catch (error) {
        console.error('\n❌ Coupon seeding failed:', error.message);
        process.exit(1);
    }
};

// Run seeder
seedCoupons();
