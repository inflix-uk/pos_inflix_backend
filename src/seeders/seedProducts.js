const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

// Load env vars
dotenv.config({ path: path.join(__dirname, '../../.env') });

// Import models
const Product = require('../models/Product');
const Category = require('../models/Category');
const Brand = require('../models/Brand');
const Warehouse = require('../models/Warehouse');
const Store = require('../models/Store');
const Supplier = require('../models/Supplier');

// Product data - 20 different products
const productsData = [
    // Electronics
    {
        name: 'iPhone 15 Pro Max',
        slug: 'iphone-15-pro-max',
        description: 'Latest Apple smartphone with A17 Pro chip, titanium design, and advanced camera system',
        costPrice: 999,
        sellingPrice: 1199,
        quantity: 25,
        minStockLevel: 10,
        unit: 'piece',
        categoryName: 'Electronics',
        brandName: 'Apple',
        manufacturer: 'Apple Inc.',
        warranty: '1 Year',
    },
    {
        name: 'Samsung Galaxy S24 Ultra',
        slug: 'samsung-galaxy-s24-ultra',
        description: 'Premium Android smartphone with S Pen, AI features, and 200MP camera',
        costPrice: 899,
        sellingPrice: 1099,
        quantity: 18,
        minStockLevel: 15,
        unit: 'piece',
        categoryName: 'Electronics',
        brandName: 'Samsung',
        manufacturer: 'Samsung Electronics',
        warranty: '1 Year',
    },
    {
        name: 'MacBook Pro 14"',
        slug: 'macbook-pro-14',
        description: 'Apple laptop with M3 Pro chip, Liquid Retina XDR display',
        costPrice: 1599,
        sellingPrice: 1999,
        quantity: 8,
        minStockLevel: 5,
        unit: 'piece',
        categoryName: 'Electronics',
        brandName: 'Apple',
        manufacturer: 'Apple Inc.',
        warranty: '1 Year',
    },
    {
        name: 'Dell XPS 15',
        slug: 'dell-xps-15',
        description: 'Premium Windows laptop with Intel Core i7, 16GB RAM, 512GB SSD',
        costPrice: 1199,
        sellingPrice: 1499,
        quantity: 5,
        minStockLevel: 8,
        unit: 'piece',
        categoryName: 'Electronics',
        brandName: 'Dell',
        manufacturer: 'Dell Technologies',
        warranty: '2 Years',
    },
    {
        name: 'Sony WH-1000XM5 Headphones',
        slug: 'sony-wh-1000xm5',
        description: 'Industry-leading noise canceling wireless headphones',
        costPrice: 280,
        sellingPrice: 399,
        quantity: 30,
        minStockLevel: 20,
        unit: 'piece',
        categoryName: 'Electronics',
        brandName: 'Sony',
        manufacturer: 'Sony Corporation',
        warranty: '1 Year',
    },
    {
        name: 'Canon EOS R6 Mark II',
        slug: 'canon-eos-r6-mark-ii',
        description: 'Full-frame mirrorless camera with 24.2MP sensor and 4K video',
        costPrice: 1999,
        sellingPrice: 2499,
        quantity: 3,
        minStockLevel: 5,
        unit: 'piece',
        categoryName: 'Electronics',
        brandName: 'Canon',
        manufacturer: 'Canon Inc.',
        warranty: '2 Years',
    },

    // Clothing
    {
        name: 'Nike Air Max 270',
        slug: 'nike-air-max-270',
        description: 'Lifestyle sneakers with Max Air unit for all-day comfort',
        costPrice: 95,
        sellingPrice: 150,
        quantity: 45,
        minStockLevel: 30,
        unit: 'piece',
        categoryName: 'Clothing',
        brandName: 'Nike',
        manufacturer: 'Nike Inc.',
        warranty: '6 Months',
    },
    {
        name: 'Adidas Ultraboost 23',
        slug: 'adidas-ultraboost-23',
        description: 'Running shoes with Boost midsole technology',
        costPrice: 120,
        sellingPrice: 190,
        quantity: 12,
        minStockLevel: 20,
        unit: 'piece',
        categoryName: 'Clothing',
        brandName: 'Adidas',
        manufacturer: 'Adidas AG',
        warranty: '6 Months',
    },
    {
        name: 'Puma RS-X Sneakers',
        slug: 'puma-rs-x-sneakers',
        description: 'Retro-inspired running sneakers with cushioned comfort',
        costPrice: 70,
        sellingPrice: 110,
        quantity: 0,
        minStockLevel: 15,
        unit: 'piece',
        categoryName: 'Clothing',
        brandName: 'Puma',
        manufacturer: 'Puma SE',
        warranty: '6 Months',
    },

    // Food & Beverages
    {
        name: 'Nestle Coffee Mate',
        slug: 'nestle-coffee-mate',
        description: 'Premium coffee creamer, 500g pack',
        costPrice: 5,
        sellingPrice: 8.99,
        quantity: 100,
        minStockLevel: 50,
        unit: 'piece',
        categoryName: 'Food & Beverages',
        brandName: 'Nestle',
        manufacturer: 'Nestle SA',
        expiryDays: 365,
    },
    {
        name: 'Coca-Cola Classic 24 Pack',
        slug: 'coca-cola-classic-24-pack',
        description: '24 cans of original Coca-Cola, 330ml each',
        costPrice: 12,
        sellingPrice: 18.99,
        quantity: 60,
        minStockLevel: 40,
        unit: 'pack',
        categoryName: 'Food & Beverages',
        brandName: 'Coca-Cola',
        manufacturer: 'The Coca-Cola Company',
        expiryDays: 180,
    },
    {
        name: 'Pepsi Zero Sugar 12 Pack',
        slug: 'pepsi-zero-sugar-12-pack',
        description: '12 cans of Pepsi Zero Sugar, 355ml each',
        costPrice: 6,
        sellingPrice: 9.99,
        quantity: 35,
        minStockLevel: 30,
        unit: 'pack',
        categoryName: 'Food & Beverages',
        brandName: 'Pepsi',
        manufacturer: 'PepsiCo Inc.',
        expiryDays: 180,
    },

    // Health & Beauty
    {
        name: "L'Oreal Paris Revitalift Serum",
        slug: 'loreal-revitalift-serum',
        description: 'Anti-aging serum with Hyaluronic Acid, 30ml',
        costPrice: 18,
        sellingPrice: 29.99,
        quantity: 40,
        minStockLevel: 25,
        unit: 'piece',
        categoryName: 'Health & Beauty',
        brandName: "L'Oreal",
        manufacturer: "L'Oreal Paris",
        expiryDays: 730,
    },
    {
        name: 'Philips Electric Shaver',
        slug: 'philips-electric-shaver',
        description: 'Series 5000 wet & dry electric shaver',
        costPrice: 65,
        sellingPrice: 99.99,
        quantity: 15,
        minStockLevel: 10,
        unit: 'piece',
        categoryName: 'Health & Beauty',
        brandName: 'Philips',
        manufacturer: 'Philips Electronics',
        warranty: '2 Years',
    },

    // Home & Garden
    {
        name: 'LG Smart TV 55"',
        slug: 'lg-smart-tv-55',
        description: '55-inch 4K OLED Smart TV with webOS',
        costPrice: 899,
        sellingPrice: 1299,
        quantity: 7,
        minStockLevel: 5,
        unit: 'piece',
        categoryName: 'Home & Garden',
        brandName: 'LG',
        manufacturer: 'LG Electronics',
        warranty: '2 Years',
    },
    {
        name: 'Philips Air Fryer XXL',
        slug: 'philips-air-fryer-xxl',
        description: 'Extra large capacity air fryer with rapid air technology',
        costPrice: 150,
        sellingPrice: 249.99,
        quantity: 0,
        minStockLevel: 8,
        unit: 'piece',
        categoryName: 'Home & Garden',
        brandName: 'Philips',
        manufacturer: 'Philips Domestic Appliances',
        warranty: '2 Years',
    },

    // Sports & Outdoors
    {
        name: 'Nike Dri-FIT Training Shirt',
        slug: 'nike-dri-fit-training-shirt',
        description: 'Moisture-wicking training t-shirt for workouts',
        costPrice: 20,
        sellingPrice: 35,
        quantity: 80,
        minStockLevel: 40,
        unit: 'piece',
        categoryName: 'Sports & Outdoors',
        brandName: 'Nike',
        manufacturer: 'Nike Inc.',
    },
    {
        name: 'Adidas Training Shorts',
        slug: 'adidas-training-shorts',
        description: 'Lightweight training shorts with AEROREADY technology',
        costPrice: 18,
        sellingPrice: 30,
        quantity: 55,
        minStockLevel: 35,
        unit: 'piece',
        categoryName: 'Sports & Outdoors',
        brandName: 'Adidas',
        manufacturer: 'Adidas AG',
    },

    // Toys & Games
    {
        name: 'Sony PlayStation 5',
        slug: 'sony-playstation-5',
        description: 'Next-gen gaming console with DualSense controller',
        costPrice: 399,
        sellingPrice: 499,
        quantity: 4,
        minStockLevel: 10,
        unit: 'piece',
        categoryName: 'Toys & Games',
        brandName: 'Sony',
        manufacturer: 'Sony Interactive Entertainment',
        warranty: '1 Year',
    },
    {
        name: 'Xiaomi Mi Band 8',
        slug: 'xiaomi-mi-band-8',
        description: 'Smart fitness tracker with AMOLED display and heart rate monitor',
        costPrice: 35,
        sellingPrice: 49.99,
        quantity: 50,
        minStockLevel: 30,
        unit: 'piece',
        categoryName: 'Electronics',
        brandName: 'Xiaomi',
        manufacturer: 'Xiaomi Corporation',
        warranty: '1 Year',
    },
];

// Generate SKU
const generateSKU = (index) => {
    return `SKU-${String(index + 1).padStart(5, '0')}`;
};

// Generate Barcode
const generateBarcode = (index) => {
    return `${Date.now()}${String(index).padStart(4, '0')}`;
};

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

// Seed products
const seedProducts = async () => {
    try {
        await connectDB();

        console.log('\n🌱 Starting product seeding...\n');

        // Fetch existing data for references
        const categories = await Category.find({ isActive: true });
        const brands = await Brand.find({ isActive: true });
        const warehouses = await Warehouse.find({ isActive: true });
        const stores = await Store.find({ isActive: true });
        const suppliers = await Supplier.find({ isActive: true });

        if (categories.length === 0) {
            console.error('❌ No categories found. Please run the main seeder first: npm run seed');
            process.exit(1);
        }

        console.log(`Found ${categories.length} categories, ${brands.length} brands`);

        // Create category and brand maps
        const categoryMap = {};
        categories.forEach(cat => {
            categoryMap[cat.name] = cat._id;
        });

        const brandMap = {};
        brands.forEach(brand => {
            brandMap[brand.name] = brand._id;
        });

        // Clear existing products (optional - comment out if you want to keep existing)
        await Product.deleteMany({});
        console.log('✓ Cleared existing products');

        // Create products
        const productsToCreate = productsData.map((product, index) => {
            const categoryId = categoryMap[product.categoryName];
            const brandId = brandMap[product.brandName];

            if (!categoryId) {
                console.warn(`⚠ Category not found: ${product.categoryName}, using first available`);
            }

            // Calculate dates
            const manufacturedDate = new Date();
            manufacturedDate.setMonth(manufacturedDate.getMonth() - 3);

            let expiryDate = null;
            if (product.expiryDays) {
                expiryDate = new Date();
                expiryDate.setDate(expiryDate.getDate() + product.expiryDays);
            }

            return {
                name: product.name,
                slug: product.slug,
                sku: generateSKU(index),
                barcode: generateBarcode(index),
                barcodeSymbology: 'code128',
                description: product.description,
                category: categoryId || categories[0]._id,
                brand: brandId || null,
                store: stores.length > 0 ? stores[index % stores.length]._id : null,
                warehouse: warehouses.length > 0 ? warehouses[index % warehouses.length]._id : null,
                supplier: suppliers.length > 0 ? suppliers[index % suppliers.length]._id : null,
                sellingType: 'retail',
                costPrice: product.costPrice,
                sellingPrice: product.sellingPrice,
                taxType: 'none',
                taxRate: 0,
                discountType: 'none',
                discountValue: 0,
                quantity: product.quantity,
                minStockLevel: product.minStockLevel,
                unit: product.unit,
                warranty: product.warranty || null,
                manufacturer: product.manufacturer || null,
                manufacturedDate: manufacturedDate,
                expiryDate: expiryDate,
                isActive: true,
            };
        });

        const createdProducts = await Product.insertMany(productsToCreate);
        console.log(`✓ ${createdProducts.length} Products seeded`);

        // Summary
        const lowStockCount = createdProducts.filter(p => p.quantity <= p.minStockLevel && p.quantity > 0).length;
        const outOfStockCount = createdProducts.filter(p => p.quantity === 0).length;
        const normalStockCount = createdProducts.filter(p => p.quantity > p.minStockLevel).length;

        console.log('\n📊 Product Summary:');
        console.log(`   - Normal Stock: ${normalStockCount}`);
        console.log(`   - Low Stock: ${lowStockCount}`);
        console.log(`   - Out of Stock: ${outOfStockCount}`);

        console.log('\n✅ Product seeding completed successfully!\n');

        process.exit(0);
    } catch (error) {
        console.error('\n❌ Product seeding failed:', error.message);
        process.exit(1);
    }
};

// Run seeder
seedProducts();
