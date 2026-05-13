const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../../.env') });

const Category = require('../models/Category');
const SubCategory = require('../models/SubCategory');

const categories = [
    { name: 'Electronics', slug: 'electronics', description: 'Electronic devices and gadgets', isActive: true },
    { name: 'Clothing', slug: 'clothing', description: 'Apparel and fashion items', isActive: true },
    { name: 'Food & Beverages', slug: 'food-beverages', description: 'Food items and drinks', isActive: true },
    { name: 'Home & Garden', slug: 'home-garden', description: 'Home decor and garden supplies', isActive: true },
    { name: 'Sports & Outdoors', slug: 'sports-outdoors', description: 'Sports equipment and outdoor gear', isActive: true },
    { name: 'Health & Beauty', slug: 'health-beauty', description: 'Health products and beauty items', isActive: true },
    { name: 'Books & Stationery', slug: 'books-stationery', description: 'Books and office supplies', isActive: true },
    { name: 'Toys & Games', slug: 'toys-games', description: 'Toys and gaming products', isActive: true },
    { name: 'Automotive', slug: 'automotive', description: 'Car accessories and parts', isActive: true },
    { name: 'Jewelry & Watches', slug: 'jewelry-watches', description: 'Jewelry and timepieces', isActive: true }
];

const subCategoriesData = [
    { name: 'Mobile Phones', slug: 'mobile-phones', code: 'EL-MP', description: 'Smartphones and feature phones', categoryName: 'Electronics' },
    { name: 'Laptops', slug: 'laptops', code: 'EL-LP', description: 'Notebooks and laptops', categoryName: 'Electronics' },
    { name: 'Tablets', slug: 'tablets', code: 'EL-TB', description: 'Tablets and iPads', categoryName: 'Electronics' },
    { name: 'Accessories', slug: 'electronics-accessories', code: 'EL-AC', description: 'Electronic accessories', categoryName: 'Electronics' },
    { name: 'Cameras', slug: 'cameras', code: 'EL-CM', description: 'Digital cameras and DSLRs', categoryName: 'Electronics' },
    { name: 'Men\'s Wear', slug: 'mens-wear', code: 'CL-MW', description: 'Clothing for men', categoryName: 'Clothing' },
    { name: 'Women\'s Wear', slug: 'womens-wear', code: 'CL-WW', description: 'Clothing for women', categoryName: 'Clothing' },
    { name: 'Kids\' Wear', slug: 'kids-wear', code: 'CL-KW', description: 'Clothing for children', categoryName: 'Clothing' },
    { name: 'Footwear', slug: 'footwear', code: 'CL-FW', description: 'Shoes and sandals', categoryName: 'Clothing' },
    { name: 'Snacks', slug: 'snacks', code: 'FB-SN', description: 'Chips and snack items', categoryName: 'Food & Beverages' },
    { name: 'Beverages', slug: 'beverages', code: 'FB-BV', description: 'Drinks and juices', categoryName: 'Food & Beverages' },
    { name: 'Dairy Products', slug: 'dairy-products', code: 'FB-DP', description: 'Milk and dairy items', categoryName: 'Food & Beverages' },
    { name: 'Furniture', slug: 'furniture', code: 'HG-FR', description: 'Home furniture', categoryName: 'Home & Garden' },
    { name: 'Kitchen Items', slug: 'kitchen-items', code: 'HG-KI', description: 'Kitchen utensils and appliances', categoryName: 'Home & Garden' },
    { name: 'Garden Tools', slug: 'garden-tools', code: 'HG-GT', description: 'Gardening equipment', categoryName: 'Home & Garden' },
    { name: 'Fitness Equipment', slug: 'fitness-equipment', code: 'SO-FE', description: 'Gym and fitness gear', categoryName: 'Sports & Outdoors' },
    { name: 'Camping Gear', slug: 'camping-gear', code: 'SO-CG', description: 'Camping and hiking equipment', categoryName: 'Sports & Outdoors' },
    { name: 'Skincare', slug: 'skincare', code: 'HB-SK', description: 'Skin care products', categoryName: 'Health & Beauty' },
    { name: 'Hair Care', slug: 'hair-care', code: 'HB-HC', description: 'Hair care products', categoryName: 'Health & Beauty' },
    { name: 'Supplements', slug: 'supplements', code: 'HB-SP', description: 'Health supplements', categoryName: 'Health & Beauty' }
];

const seed = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('MongoDB Connected');

        console.log('\nSeeding Categories & Sub-Categories...\n');

        await Category.deleteMany({});
        const createdCategories = await Category.insertMany(categories);
        console.log(`✓ ${createdCategories.length} Categories seeded`);

        await SubCategory.deleteMany({});
        const subCategoriesWithIds = subCategoriesData.map(subCat => {
            const category = createdCategories.find(c => c.name === subCat.categoryName);
            if (!category) throw new Error(`Category not found: ${subCat.categoryName}`);
            return {
                name: subCat.name,
                slug: subCat.slug,
                code: subCat.code,
                description: subCat.description,
                category: category._id,
                isActive: true
            };
        });
        const createdSubCategories = await SubCategory.insertMany(subCategoriesWithIds);
        console.log(`✓ ${createdSubCategories.length} Sub-Categories seeded`);

        console.log('\n✅ Categories seeding completed!\n');
        process.exit(0);
    } catch (error) {
        console.error('❌ Seeding failed:', error.message);
        process.exit(1);
    }
};

seed();
