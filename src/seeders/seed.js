const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

// Load env vars
dotenv.config({ path: path.join(__dirname, '../../.env') });

// Import models
const Category = require('../models/Category');
const SubCategory = require('../models/SubCategory');
const VariantAttribute = require('../models/VariantAttribute');
const Location = require('../models/Location');
const Supplier = require('../models/Supplier');
const Customer = require('../models/Customer');
const Tax = require('../models/Tax');

// Dummy Data
const categories = [
    { name: 'Electronics', slug: 'electronics', description: 'Electronic devices and gadgets', isActive: true },
    { name: 'Phones', slug: 'phones', description: 'Smartphones and mobile devices', isActive: true },
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
    // Electronics
    { name: 'Mobile Phones', slug: 'mobile-phones', code: 'EL-MP', description: 'Smartphones and feature phones', categoryName: 'Electronics' },
    { name: 'Laptops', slug: 'laptops', code: 'EL-LP', description: 'Notebooks and laptops', categoryName: 'Electronics' },
    { name: 'Tablets', slug: 'tablets', code: 'EL-TB', description: 'Tablets and iPads', categoryName: 'Electronics' },
    { name: 'Accessories', slug: 'electronics-accessories', code: 'EL-AC', description: 'Electronic accessories', categoryName: 'Electronics' },
    { name: 'Cameras', slug: 'cameras', code: 'EL-CM', description: 'Digital cameras and DSLRs', categoryName: 'Electronics' },
    // Phones
    { name: 'Smartphones', slug: 'phones-smartphones', code: 'PH-SM', description: 'Smartphones and feature phones', categoryName: 'Phones' },
    // Clothing
    { name: 'Men\'s Wear', slug: 'mens-wear', code: 'CL-MW', description: 'Clothing for men', categoryName: 'Clothing' },
    { name: 'Women\'s Wear', slug: 'womens-wear', code: 'CL-WW', description: 'Clothing for women', categoryName: 'Clothing' },
    { name: 'Kids\' Wear', slug: 'kids-wear', code: 'CL-KW', description: 'Clothing for children', categoryName: 'Clothing' },
    { name: 'Footwear', slug: 'footwear', code: 'CL-FW', description: 'Shoes and sandals', categoryName: 'Clothing' },
    // Food & Beverages
    { name: 'Snacks', slug: 'snacks', code: 'FB-SN', description: 'Chips and snack items', categoryName: 'Food & Beverages' },
    { name: 'Beverages', slug: 'beverages', code: 'FB-BV', description: 'Drinks and juices', categoryName: 'Food & Beverages' },
    { name: 'Dairy Products', slug: 'dairy-products', code: 'FB-DP', description: 'Milk and dairy items', categoryName: 'Food & Beverages' },
    // Home & Garden
    { name: 'Furniture', slug: 'furniture', code: 'HG-FR', description: 'Home furniture', categoryName: 'Home & Garden' },
    { name: 'Kitchen Items', slug: 'kitchen-items', code: 'HG-KI', description: 'Kitchen utensils and appliances', categoryName: 'Home & Garden' },
    { name: 'Garden Tools', slug: 'garden-tools', code: 'HG-GT', description: 'Gardening equipment', categoryName: 'Home & Garden' },
    // Sports & Outdoors
    { name: 'Fitness Equipment', slug: 'fitness-equipment', code: 'SO-FE', description: 'Gym and fitness gear', categoryName: 'Sports & Outdoors' },
    { name: 'Camping Gear', slug: 'camping-gear', code: 'SO-CG', description: 'Camping and hiking equipment', categoryName: 'Sports & Outdoors' },
    // Health & Beauty
    { name: 'Skincare', slug: 'skincare', code: 'HB-SK', description: 'Skin care products', categoryName: 'Health & Beauty' },
    { name: 'Hair Care', slug: 'hair-care', code: 'HB-HC', description: 'Hair care products', categoryName: 'Health & Beauty' },
    { name: 'Supplements', slug: 'supplements', code: 'HB-SP', description: 'Health supplements', categoryName: 'Health & Beauty' }
];

const variantAttributes = [
    { name: 'Color', values: ['Red', 'Blue', 'Green', 'Black', 'White', 'Yellow', 'Orange', 'Purple', 'Pink', 'Gray'], description: 'Product color options', isActive: true },
    { name: 'Size', values: ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'], description: 'Clothing size options', isActive: true },
    { name: 'Storage', values: ['32GB', '64GB', '128GB', '256GB', '512GB', '1TB', '2TB'], description: 'Storage capacity options', isActive: true },
    { name: 'RAM', values: ['2GB', '4GB', '6GB', '8GB', '12GB', '16GB', '32GB', '64GB'], description: 'Memory capacity options', isActive: true },
    { name: 'Material', values: ['Cotton', 'Polyester', 'Leather', 'Silk', 'Wool', 'Denim', 'Linen', 'Nylon'], description: 'Material type options', isActive: true },
    { name: 'Shoe Size', values: ['6', '7', '8', '9', '10', '11', '12', '13'], description: 'Footwear size options', isActive: true },
    { name: 'Weight', values: ['100g', '250g', '500g', '1kg', '2kg', '5kg'], description: 'Product weight options', isActive: true },
    { name: 'Flavor', values: ['Vanilla', 'Chocolate', 'Strawberry', 'Mango', 'Orange', 'Mint', 'Coffee'], description: 'Flavor options', isActive: true },
    { name: 'Screen Size', values: ['5.5"', '6.1"', '6.5"', '6.7"', '13"', '14"', '15.6"', '17"', '24"', '27"', '32"'], description: 'Display size options', isActive: true },
    { name: 'Wattage', values: ['5W', '10W', '15W', '20W', '40W', '60W', '100W'], description: 'Power wattage options', isActive: true }
];

const locations = [
    // Warehouses
    { name: 'Main Warehouse', type: 'warehouse', contactPerson: 'John Smith', phone: '+1-555-0101', email: 'main@warehouse.com', address: '123 Industrial Park Road', city: 'New York', country: 'USA', isActive: true },
    { name: 'East Coast Distribution', type: 'warehouse', contactPerson: 'Sarah Johnson', phone: '+1-555-0102', email: 'eastcoast@warehouse.com', address: '456 Harbor Drive', city: 'Boston', country: 'USA', isActive: true },
    { name: 'West Coast Hub', type: 'warehouse', contactPerson: 'Michael Chen', phone: '+1-555-0103', email: 'westcoast@warehouse.com', address: '789 Pacific Boulevard', city: 'Los Angeles', country: 'USA', isActive: true },
    { name: 'Central Storage Facility', type: 'warehouse', contactPerson: 'Emily Davis', phone: '+1-555-0104', email: 'central@warehouse.com', address: '321 Midwest Avenue', city: 'Chicago', country: 'USA', isActive: true },
    { name: 'Southern Distribution Center', type: 'warehouse', contactPerson: 'Robert Wilson', phone: '+1-555-0105', email: 'southern@warehouse.com', address: '654 Sunbelt Road', city: 'Houston', country: 'USA', isActive: true },
    { name: 'European Warehouse', type: 'warehouse', contactPerson: 'Hans Mueller', phone: '+49-30-12345', email: 'europe@warehouse.com', address: '12 Industriestrasse', city: 'Berlin', country: 'Germany', isActive: true },
    { name: 'UK Distribution', type: 'warehouse', contactPerson: 'James Brown', phone: '+44-20-7946-0958', email: 'uk@warehouse.com', address: '88 Commerce Street', city: 'London', country: 'United Kingdom', isActive: true },
    { name: 'Asia Pacific Center', type: 'warehouse', contactPerson: 'Yuki Tanaka', phone: '+81-3-1234-5678', email: 'asiapacific@warehouse.com', address: '5-10 Shibuya District', city: 'Tokyo', country: 'Japan', isActive: true },
    { name: 'Australia Warehouse', type: 'warehouse', contactPerson: 'David Miller', phone: '+61-2-9876-5432', email: 'australia@warehouse.com', address: '42 Harbour View Road', city: 'Sydney', country: 'Australia', isActive: true },
    { name: 'Canada Distribution', type: 'warehouse', contactPerson: 'Marie Leblanc', phone: '+1-416-555-0199', email: 'canada@warehouse.com', address: '100 Maple Street', city: 'Toronto', country: 'Canada', isActive: true },
    { name: 'Returns Processing Center', type: 'warehouse', contactPerson: 'Lisa Anderson', phone: '+1-555-0106', email: 'returns@warehouse.com', address: '999 Return Lane', city: 'Phoenix', country: 'USA', isActive: true },
    { name: 'Cold Storage Facility', type: 'warehouse', contactPerson: 'Tom Peters', phone: '+1-555-0107', email: 'coldstorage@warehouse.com', address: '777 Frozen Way', city: 'Seattle', country: 'USA', isActive: false },
    // Stores
    { name: 'Downtown Flagship Store', type: 'store', contactPerson: 'Alice Cooper', phone: '+1-555-1001', email: 'downtown@store.com', address: '100 Main Street', city: 'New York', country: 'USA', isActive: true },
    { name: 'Westside Mall Outlet', type: 'store', contactPerson: 'Bob Martinez', phone: '+1-555-1002', email: 'westside@store.com', address: '250 Shopping Center Blvd', city: 'Los Angeles', country: 'USA', isActive: true },
    { name: 'Lakefront Store', type: 'store', contactPerson: 'Carol White', phone: '+1-555-1003', email: 'lakefront@store.com', address: '500 Lake Shore Drive', city: 'Chicago', country: 'USA', isActive: true },
    { name: 'Tech Hub Store', type: 'store', contactPerson: 'David Lee', phone: '+1-555-1004', email: 'techhub@store.com', address: '888 Innovation Way', city: 'San Francisco', country: 'USA', isActive: true },
    { name: 'Airport Express', type: 'store', contactPerson: 'Eva Green', phone: '+1-555-1005', email: 'airport@store.com', address: 'Terminal 3, Gate 45', city: 'Miami', country: 'USA', isActive: true },
    { name: 'University District Shop', type: 'store', contactPerson: 'Frank Adams', phone: '+1-555-1006', email: 'university@store.com', address: '1200 College Avenue', city: 'Boston', country: 'USA', isActive: true },
    { name: 'London Oxford Street', type: 'store', contactPerson: 'George Wilson', phone: '+44-20-7123-4567', email: 'oxford@store.com', address: '300 Oxford Street', city: 'London', country: 'United Kingdom', isActive: true },
    { name: 'Paris Champs-Elysees', type: 'store', contactPerson: 'Henri Dupont', phone: '+33-1-4567-8901', email: 'paris@store.com', address: '120 Avenue des Champs-Elysees', city: 'Paris', country: 'France', isActive: true },
    { name: 'Tokyo Shibuya', type: 'store', contactPerson: 'Kenji Yamamoto', phone: '+81-3-9876-5432', email: 'shibuya@store.com', address: '2-1 Shibuya Crossing', city: 'Tokyo', country: 'Japan', isActive: true },
    { name: 'Sydney Harbor Store', type: 'store', contactPerson: 'Laura Thompson', phone: '+61-2-8765-4321', email: 'sydney@store.com', address: '50 Circular Quay', city: 'Sydney', country: 'Australia', isActive: true },
    { name: 'Berlin Alexanderplatz', type: 'store', contactPerson: 'Max Schmidt', phone: '+49-30-9876-5432', email: 'berlin@store.com', address: 'Alexanderplatz 5', city: 'Berlin', country: 'Germany', isActive: true },
    { name: 'Seasonal Pop-up Store', type: 'store', contactPerson: 'Nancy Drew', phone: '+1-555-1099', email: 'popup@store.com', address: '999 Temporary Lane', city: 'Denver', country: 'USA', isActive: false }
];

const suppliers = [
    { name: 'Tech Distributors Inc', email: 'sales@techdist.com', phone: '+1-555-2001', address: { street: '100 Tech Park', city: 'San Jose', state: 'CA', zipCode: '95110', country: 'USA' }, contactPerson: 'John Tech', isActive: true },
    { name: 'Fashion Wholesale Co', email: 'orders@fashionwholesale.com', phone: '+1-555-2002', address: { street: '200 Fashion Ave', city: 'New York', state: 'NY', zipCode: '10018', country: 'USA' }, contactPerson: 'Maria Style', isActive: true },
    { name: 'Global Electronics Ltd', email: 'supply@globalelec.com', phone: '+44-20-7890-1234', address: { street: '50 Electronics Way', city: 'London', state: '', zipCode: 'EC1A 1BB', country: 'United Kingdom' }, contactPerson: 'James Circuit', isActive: true },
    { name: 'Fresh Foods Supply', email: 'fresh@foodsupply.com', phone: '+1-555-2003', address: { street: '300 Farm Road', city: 'Sacramento', state: 'CA', zipCode: '95814', country: 'USA' }, contactPerson: 'Sarah Fresh', isActive: true },
    { name: 'Home Goods Intl', email: 'sales@homegoods.com', phone: '+1-555-2004', address: { street: '400 Home Plaza', city: 'Chicago', state: 'IL', zipCode: '60601', country: 'USA' }, contactPerson: 'Mike Home', isActive: true },
    { name: 'Sports Equipment Pro', email: 'orders@sportspro.com', phone: '+1-555-2005', address: { street: '500 Stadium Blvd', city: 'Phoenix', state: 'AZ', zipCode: '85001', country: 'USA' }, contactPerson: 'Tom Athlete', isActive: true },
    { name: 'Beauty Products Asia', email: 'asia@beautyproducts.com', phone: '+81-3-5678-9012', address: { street: '10 Ginza District', city: 'Tokyo', state: '', zipCode: '104-0061', country: 'Japan' }, contactPerson: 'Yuki Beauty', isActive: true },
    { name: 'Auto Parts Direct', email: 'parts@autodirect.com', phone: '+1-555-2006', address: { street: '600 Motor Way', city: 'Detroit', state: 'MI', zipCode: '48201', country: 'USA' }, contactPerson: 'Bob Motor', isActive: true },
    { name: 'Office Supplies Plus', email: 'office@suppliesplus.com', phone: '+1-555-2007', address: { street: '700 Business Park', city: 'Austin', state: 'TX', zipCode: '78701', country: 'USA' }, contactPerson: 'Lisa Office', isActive: true },
    { name: 'Karachi Trading Co', email: 'info@karachitrading.pk', phone: '+92-21-3456-7890', address: { street: 'Block 5, Clifton', city: 'Karachi', state: 'Sindh', zipCode: '75600', country: 'Pakistan' }, contactPerson: 'Ahmed Khan', isActive: true },
    { name: 'Lahore Wholesale', email: 'sales@lahorewholesale.pk', phone: '+92-42-3567-8901', address: { street: 'Mall Road', city: 'Lahore', state: 'Punjab', zipCode: '54000', country: 'Pakistan' }, contactPerson: 'Usman Ali', isActive: true },
    { name: 'Discontinued Supplier', email: 'old@supplier.com', phone: '+1-555-0000', address: { street: '999 Old Street', city: 'Nowhere', state: 'NA', zipCode: '00000', country: 'USA' }, contactPerson: 'Old Contact', isActive: false }
];

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

// Seed functions
const seedCategories = async () => {
    try {
        await Category.deleteMany({});
        const createdCategories = await Category.insertMany(categories);
        console.log(`✓ ${createdCategories.length} Categories seeded`);
        return createdCategories;
    } catch (error) {
        console.error('Error seeding categories:', error.message);
        throw error;
    }
};

const seedSubCategories = async (categoriesMap) => {
    try {
        await SubCategory.deleteMany({});

        const subCategoriesWithIds = subCategoriesData.map(subCat => {
            const category = categoriesMap.find(c => c.name === subCat.categoryName);
            if (!category) {
                throw new Error(`Category not found: ${subCat.categoryName}`);
            }
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
        return createdSubCategories;
    } catch (error) {
        console.error('Error seeding sub-categories:', error.message);
        throw error;
    }
};

const seedVariantAttributes = async () => {
    try {
        await VariantAttribute.deleteMany({});
        const createdVariantAttributes = await VariantAttribute.insertMany(variantAttributes);
        console.log(`✓ ${createdVariantAttributes.length} Variant Attributes seeded`);
        return createdVariantAttributes;
    } catch (error) {
        console.error('Error seeding variant attributes:', error.message);
        throw error;
    }
};

const seedLocations = async () => {
    try {
        await Location.deleteMany({});
        const createdLocations = await Location.insertMany(locations);
        console.log(`✓ ${createdLocations.length} Locations seeded`);
        return createdLocations;
    } catch (error) {
        console.error('Error seeding locations:', error.message);
        throw error;
    }
};

const seedSuppliers = async () => {
    try {
        await Supplier.deleteMany({});
        const createdSuppliers = await Supplier.insertMany(suppliers);
        console.log(`✓ ${createdSuppliers.length} Suppliers seeded`);
        return createdSuppliers;
    } catch (error) {
        console.error('Error seeding suppliers:', error.message);
        throw error;
    }
};

const seedCustomers = async () => {
    try {
        await Customer.deleteMany({});
        const createdCustomers = await Customer.insertMany(customers);
        console.log(`✓ ${createdCustomers.length} Customers seeded`);
        return createdCustomers;
    } catch (error) {
        console.error('Error seeding customers:', error.message);
        throw error;
    }
};

const seedTaxes = async () => {
    try {
        await Tax.deleteMany({});
        const createdTaxes = await Tax.insertMany(taxes);
        console.log(`✓ ${createdTaxes.length} Taxes seeded`);
        return createdTaxes;
    } catch (error) {
        console.error('Error seeding taxes:', error.message);
        throw error;
    }
};

// Main seed function
const seedAll = async () => {
    try {
        await connectDB();

        console.log('\n🌱 Starting database seeding...\n');

        // Seed in order (categories first for subcategories reference)
        const createdCategories = await seedCategories();
        await seedSubCategories(createdCategories);
        await seedVariantAttributes();
        await seedLocations();
        await seedSuppliers();
        await seedCustomers();
        await seedTaxes();

        console.log('\n✅ Database seeding completed successfully!\n');

        process.exit(0);
    } catch (error) {
        console.error('\n❌ Database seeding failed:', error.message);
        process.exit(1);
    }
};

// Run seeder
seedAll();
