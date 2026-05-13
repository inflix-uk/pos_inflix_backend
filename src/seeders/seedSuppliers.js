const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../../.env') });

const Supplier = require('../models/Supplier');

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

const seed = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('MongoDB Connected');

        console.log('\nSeeding Suppliers...\n');

        await Supplier.deleteMany({});
        const created = await Supplier.insertMany(suppliers);
        console.log(`✓ ${created.length} Suppliers seeded`);

        console.log('\n✅ Suppliers seeding completed!\n');
        process.exit(0);
    } catch (error) {
        console.error('❌ Seeding failed:', error.message);
        process.exit(1);
    }
};

seed();
