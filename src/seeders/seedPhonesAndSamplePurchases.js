const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../../.env') });

const Category = require('../models/Category');
const SubCategory = require('../models/SubCategory');
const VariantAttribute = require('../models/VariantAttribute');
const Location = require('../models/Location');
const Tax = require('../models/Tax');
const Supplier = require('../models/Supplier');
const Purchase = require('../models/Purchase');

// Sample 15-digit IMEIs (format is 14 digits + check digit; these are sample only)
const SAMPLE_IMEIS = [
    '351234567890123',
    '359876543210987',
    '356123456789012',
    '358765432109876',
    '352345678901234',
    '357654321098765',
];

// Copy a VariantAttribute value tree into category format (with new ObjectIds for stored values)
function copyValuesToCategoryFormat(attrValues) {
    if (!attrValues || !Array.isArray(attrValues)) return [];
    return attrValues.filter((v) => v && v.isActive !== false).map((v) => {
        const models = (v.models || []).filter((m) => m && m.isActive !== false).map((m) => ({
            _id: new mongoose.Types.ObjectId(),
            name: m.name,
            slug: m.slug || (m.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/(^_|_$)/g, ''),
            isActive: true,
            children: []
        }));
        return {
            _id: new mongoose.Types.ObjectId(),
            name: v.name,
            slug: v.slug || (v.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/(^_|_$)/g, ''),
            isActive: true,
            models
        };
    });
}

const seed = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('MongoDB Connected');

        console.log('\nSeeding Phones category and sample purchases with IMEIs...\n');

        // 1) Find or create Phones category
        let phonesCategory = await Category.findOne({ name: 'Phones' });
        if (!phonesCategory) {
            phonesCategory = await Category.create({
                name: 'Phones',
                slug: 'phones',
                description: 'Smartphones and mobile devices',
                isActive: true
            });
            console.log('✓ Created Phones category');
        } else {
            console.log('✓ Using existing Phones category');
        }

        // 2) Find or create Smartphones subcategory under Phones (avoid slug conflict with Electronics/Mobile Phones)
        let phonesSub = await SubCategory.findOne({ category: phonesCategory._id });
        if (!phonesSub) {
            phonesSub = await SubCategory.create({
                name: 'Smartphones',
                slug: 'phones-smartphones',
                code: 'PH-SM',
                description: 'Smartphones and feature phones',
                category: phonesCategory._id,
                isActive: true
            });
            console.log('✓ Created Smartphones subcategory under Phones');
        } else {
            console.log('✓ Using existing subcategory under Phones');
        }

        // 3) Get variant attributes (Brands, Grade, Storage, Color) - slugs from variantAttributeSeeder or seed.js
        const brandsAttr = await VariantAttribute.findOne({ $or: [{ slug: 'brands' }, { name: 'Brands' }] });
        const gradeAttr = await VariantAttribute.findOne({ $or: [{ slug: 'grade' }, { name: 'Grade' }] });
        const storageAttr = await VariantAttribute.findOne({ $or: [{ slug: 'storage' }, { name: 'Storage' }] });
        const colorAttr = await VariantAttribute.findOne({ $or: [{ slug: 'color' }, { name: 'Color' }] });

        const attrsToAssign = [brandsAttr, gradeAttr, storageAttr, colorAttr].filter(Boolean);
        if (attrsToAssign.length === 0) {
            console.log('⚠ No variant attributes found. Run seed:variants or seed first.');
        } else {
            const existingIds = (phonesCategory.variantAttributes || []).map((id) => id.toString());
            let modified = false;
            for (const attr of attrsToAssign) {
                if (!existingIds.includes(attr._id.toString())) {
                    phonesCategory.variantAttributes = phonesCategory.variantAttributes || [];
                    phonesCategory.variantAttributes.push(attr._id);
                    existingIds.push(attr._id.toString());
                    modified = true;
                }
                // Copy attribute values into category's variantAttributeValues (for first attribute, full tree)
                const categoryValues = phonesCategory.variantAttributeValues || [];
                let entry = categoryValues.find(
                    (e) => e.attribute && e.attribute.toString() === attr._id.toString()
                );
                if (!entry) {
                    const values = copyValuesToCategoryFormat(attr.values);
                    phonesCategory.variantAttributeValues.push({
                        attribute: attr._id,
                        values
                    });
                    modified = true;
                }
            }
            if (modified) {
                phonesCategory.markModified('variantAttributes');
                phonesCategory.markModified('variantAttributeValues');
                await phonesCategory.save();
                console.log(`✓ Assigned ${attrsToAssign.length} variant attribute(s) to Phones with sample values`);
            }
        }

        // 4) Create sample purchases with IMEI items (need Location, Tax, Supplier)
        const location = await Location.findOne({ isActive: true });
        const tax = await Tax.findOne({ isActive: true });
        const supplier = await Supplier.findOne({ isActive: true });

        if (!location || !tax || !supplier) {
            console.log('⚠ Skip sample purchases: need at least one Location, Tax, and Supplier. Run seed (and seed:uk-accounts) first.');
        } else {
            const existingSample = await Purchase.findOne({ parcelNumber: 'SAMPLE-PHONES-001' });
            if (existingSample) {
                console.log('✓ Sample purchases already exist (SAMPLE-PHONES-001), skipping.');
            } else {
                const purchaseNumber1 = 'PUR-SAMPLE-001';
                const purchaseNumber2 = 'PUR-SAMPLE-002';

                const items1 = [
                    {
                        sendTo: location._id,
                        tax: tax._id,
                        category: phonesCategory._id,
                        subCategory: phonesSub._id,
                        grade: 'A - Pristine',
                        brand: 'APPLE',
                        brandModel: 'IPHONE 15',
                        capacity: '128GB',
                        colour: 'BLACK',
                        variantValues: [
                            { slug: 'brands', value: 'APPLE' },
                            { slug: 'brand_model', value: 'IPHONE 15' },
                            { slug: 'grade', value: 'A - PRISTINE' },
                            { slug: 'storage', value: '128GB' },
                            { slug: 'color', value: 'BLACK' }
                        ],
                        purchasePrice: 699,
                        salePrice: 849,
                        imeis: [SAMPLE_IMEIS[0], SAMPLE_IMEIS[1]],
                        quantity: 0,
                        isOtherItem: false
                    },
                    {
                        sendTo: location._id,
                        tax: tax._id,
                        category: phonesCategory._id,
                        subCategory: phonesSub._id,
                        grade: 'B - Good',
                        brand: 'SAMSUNG',
                        brandModel: 'GALAXY S24',
                        capacity: '256GB',
                        colour: 'WHITE',
                        variantValues: [
                            { slug: 'brands', value: 'SAMSUNG' },
                            { slug: 'brand_model', value: 'GALAXY S24' },
                            { slug: 'grade', value: 'B - GOOD' },
                            { slug: 'storage', value: '256GB' },
                            { slug: 'color', value: 'WHITE' }
                        ],
                        purchasePrice: 599,
                        salePrice: 749,
                        imeis: [SAMPLE_IMEIS[2]],
                        quantity: 0,
                        isOtherItem: false
                    }
                ];

                const items2 = [
                    {
                        sendTo: location._id,
                        tax: tax._id,
                        category: phonesCategory._id,
                        subCategory: phonesSub._id,
                        grade: 'A - Pristine',
                        brand: 'GOOGLE',
                        brandModel: 'PIXEL 8',
                        capacity: '128GB',
                        colour: 'BLUE',
                        variantValues: [
                            { slug: 'brands', value: 'GOOGLE' },
                            { slug: 'brand_model', value: 'PIXEL 8' },
                            { slug: 'grade', value: 'A - PRISTINE' },
                            { slug: 'storage', value: '128GB' },
                            { slug: 'color', value: 'BLUE' }
                        ],
                        purchasePrice: 499,
                        salePrice: 599,
                        imeis: [SAMPLE_IMEIS[3], SAMPLE_IMEIS[4], SAMPLE_IMEIS[5]],
                        quantity: 0,
                        isOtherItem: false
                    }
                ];

                const total1 = items1.reduce((sum, it) => sum + (it.purchasePrice || 0) * (it.imeis?.length || 1), 0);
                const total2 = items2.reduce((sum, it) => sum + (it.purchasePrice || 0) * (it.imeis?.length || 1), 0);

                await Purchase.create({
                    purchaseNumber: purchaseNumber1,
                    account: supplier._id,
                    accountModel: 'Supplier',
                    parcelNumber: 'SAMPLE-PHONES-001',
                    date: new Date(),
                    currency: 'GBP',
                    imeiQuantity: 3,
                    otherQuantity: 0,
                    items: items1,
                    totalIMEIs: 3,
                    totalOtherQuantity: 0,
                    grandTotal: total1,
                    status: 'Received',
                    paymentStatus: 'Unpaid'
                });

                await Purchase.create({
                    purchaseNumber: purchaseNumber2,
                    account: supplier._id,
                    accountModel: 'Supplier',
                    parcelNumber: 'SAMPLE-PHONES-002',
                    date: new Date(),
                    currency: 'GBP',
                    imeiQuantity: 3,
                    otherQuantity: 0,
                    items: items2,
                    totalIMEIs: 3,
                    totalOtherQuantity: 0,
                    grandTotal: total2,
                    status: 'Received',
                    paymentStatus: 'Unpaid'
                });

                console.log('✓ Created 2 sample purchases with phone items and sample IMEIs');
                console.log('  - SAMPLE-PHONES-001: 2 items (Apple iPhone 15, Samsung Galaxy S24)');
                console.log('  - SAMPLE-PHONES-002: 1 item (Google Pixel 8)');
            }
        }

        console.log('\n✅ Phones category and sample IMEI data seeding completed!\n');
        process.exit(0);
    } catch (error) {
        console.error('❌ Seeding failed:', error.message);
        process.exit(1);
    }
};

seed();
