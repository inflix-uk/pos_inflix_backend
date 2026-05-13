const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../../.env') });

const Tax = require('../models/Tax');

const taxes = [
    { name: 'Standard VAT', rate: 20, type: 'percentage', code: 'VAT20', description: 'Standard UK VAT rate', isCompound: false, isDefault: true, isActive: true },
    { name: 'Reduced VAT', rate: 5, type: 'percentage', code: 'VAT5', description: 'Reduced UK VAT rate for certain goods', isCompound: false, isDefault: false, isActive: true },
    { name: 'Zero Rated', rate: 0, type: 'percentage', code: 'VAT0', description: 'Zero rated VAT for exempt items', isCompound: false, isDefault: false, isActive: true },
    { name: 'Exempt', rate: 0, type: 'percentage', code: 'EXEMPT', description: 'VAT exempt items', isCompound: false, isDefault: false, isActive: true },
    { name: 'Import Duty', rate: 12, type: 'percentage', code: 'IMP12', description: 'Standard import duty rate', isCompound: false, isDefault: false, isActive: true },
    { name: 'Service Tax', rate: 15, type: 'percentage', code: 'SVC15', description: 'Service tax applicable to services', isCompound: false, isDefault: false, isActive: true },
    { name: 'Shipping Tax', rate: 10, type: 'percentage', code: 'SHIP10', description: 'Tax on shipping and delivery', isCompound: false, isDefault: false, isActive: true },
    { name: 'Flat Processing Fee', rate: 5, type: 'fixed', code: 'FLAT5', description: 'Fixed processing fee per transaction', isCompound: false, isDefault: false, isActive: true },
    { name: 'Compound Tax', rate: 3, type: 'percentage', code: 'COMP3', description: 'Compound tax calculated on subtotal plus other taxes', isCompound: true, isDefault: false, isActive: true },
    { name: 'Luxury Tax', rate: 25, type: 'percentage', code: 'LUX25', description: 'Luxury goods tax', isCompound: false, isDefault: false, isActive: true },
    { name: 'Environmental Levy', rate: 2, type: 'fixed', code: 'ENV2', description: 'Environmental levy per item', isCompound: false, isDefault: false, isActive: true },
    { name: 'Old Tax Rate', rate: 17.5, type: 'percentage', code: 'OLD17', description: 'Previous VAT rate - no longer in use', isCompound: false, isDefault: false, isActive: false },
];

const seed = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('MongoDB Connected');

        console.log('\nSeeding Taxes...\n');

        await Tax.deleteMany({});
        const created = await Tax.insertMany(taxes);
        console.log(`✓ ${created.length} Taxes seeded`);

        console.log('\n✅ Taxes seeding completed!\n');
        process.exit(0);
    } catch (error) {
        console.error('❌ Seeding failed:', error.message);
        process.exit(1);
    }
};

seed();
