const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

// Load env vars
dotenv.config({ path: path.join(__dirname, '../../.env') });

// Import model
const GiftCard = require('../models/GiftCard');

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

// Avatar colors for variety
const avatarColors = [
    'bg-blue-100',
    'bg-red-100',
    'bg-green-100',
    'bg-yellow-100',
    'bg-purple-100',
    'bg-pink-100',
    'bg-indigo-100',
    'bg-orange-100',
    'bg-teal-100',
    'bg-gray-100'
];

// Gift Card data - 10 different gift cards
const giftCardsData = [
    {
        code: 'GFT1110',
        customer: {
            name: 'Carl Evans',
            avatar: 'user',
            color: avatarColors[0]
        },
        issuedDate: getPastDate(30),
        expiryDate: getFutureDate(30),
        amount: 200,
        balance: 100,
        status: 'Active'
    },
    {
        code: 'GFT1109',
        customer: {
            name: 'Minerva Rametz',
            avatar: 'user',
            color: avatarColors[1]
        },
        issuedDate: getPastDate(45),
        expiryDate: getFutureDate(15),
        amount: 500,
        balance: 200,
        status: 'Active'
    },
    {
        code: 'GFT1108',
        customer: {
            name: 'Robert Lamon',
            avatar: 'user',
            color: avatarColors[9]
        },
        issuedDate: getPastDate(60),
        expiryDate: getFutureDate(30),
        amount: 200,
        balance: 150,
        status: 'Active'
    },
    {
        code: 'GFT1107',
        customer: {
            name: 'Patricia Lewis',
            avatar: 'user',
            color: avatarColors[7]
        },
        issuedDate: getPastDate(75),
        expiryDate: getFutureDate(15),
        amount: 120,
        balance: 0,
        status: 'Redeemed'
    },
    {
        code: 'GFT1106',
        customer: {
            name: 'Mark Jordyn',
            avatar: 'user',
            color: avatarColors[0]
        },
        issuedDate: getPastDate(90),
        expiryDate: getFutureDate(60),
        amount: 350,
        balance: 300,
        status: 'Active'
    },
    {
        code: 'GFT1105',
        customer: {
            name: 'Marsha Betts',
            avatar: 'user',
            color: avatarColors[2]
        },
        issuedDate: getPastDate(45),
        expiryDate: getFutureDate(45),
        amount: 500,
        balance: 400,
        status: 'Active'
    },
    {
        code: 'GFT1104',
        customer: {
            name: 'Daniel Jude',
            avatar: 'user',
            color: avatarColors[4]
        },
        issuedDate: getPastDate(30),
        expiryDate: getFutureDate(60),
        amount: 250,
        balance: 150,
        status: 'Active'
    },
    {
        code: 'GFT1103',
        customer: {
            name: 'Emma Bates',
            avatar: 'user',
            color: avatarColors[5]
        },
        issuedDate: getPastDate(120),
        expiryDate: getPastDate(30),
        amount: 200,
        balance: 220,
        status: 'Expired'
    },
    {
        code: 'GFT1102',
        customer: {
            name: 'Richard Fralick',
            avatar: 'user',
            color: avatarColors[3]
        },
        issuedDate: getPastDate(60),
        expiryDate: getFutureDate(30),
        amount: 200,
        balance: 180,
        status: 'Active'
    },
    {
        code: 'GFT1101',
        customer: {
            name: 'Michelle Robison',
            avatar: 'user',
            color: avatarColors[6]
        },
        issuedDate: getPastDate(150),
        expiryDate: getPastDate(60),
        amount: 400,
        balance: 350,
        status: 'Expired'
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

// Seed gift cards
const seedGiftCards = async () => {
    try {
        await connectDB();

        console.log('\n🎁 Starting gift card seeding...\n');

        // Clear existing gift cards
        await GiftCard.deleteMany({});
        console.log('✓ Cleared existing gift cards');

        // Create gift cards
        const createdGiftCards = await GiftCard.insertMany(giftCardsData);
        console.log(`✓ ${createdGiftCards.length} Gift cards seeded`);

        // Summary
        const activeCards = createdGiftCards.filter(gc => gc.status === 'Active').length;
        const redeemedCards = createdGiftCards.filter(gc => gc.status === 'Redeemed').length;
        const expiredCards = createdGiftCards.filter(gc => gc.status === 'Expired').length;
        const totalValue = createdGiftCards.reduce((sum, gc) => sum + gc.amount, 0);
        const totalBalance = createdGiftCards.reduce((sum, gc) => sum + gc.balance, 0);

        console.log('\n📊 Gift Card Summary:');
        console.log(`   - Active: ${activeCards}`);
        console.log(`   - Redeemed: ${redeemedCards}`);
        console.log(`   - Expired: ${expiredCards}`);
        console.log(`   - Total Value: $${totalValue}`);
        console.log(`   - Total Balance: $${totalBalance}`);

        console.log('\n✅ Gift card seeding completed successfully!\n');

        process.exit(0);
    } catch (error) {
        console.error('\n❌ Gift card seeding failed:', error.message);
        process.exit(1);
    }
};

// Run seeder
seedGiftCards();
