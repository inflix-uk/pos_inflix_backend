const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../../.env') });

const Location = require('../models/Location');

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

const seed = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('MongoDB Connected');

        console.log('\nSeeding Locations...\n');

        await Location.deleteMany({});
        const created = await Location.insertMany(locations);
        console.log(`✓ ${created.length} Locations seeded`);

        console.log('\n✅ Locations seeding completed!\n');
        process.exit(0);
    } catch (error) {
        console.error('❌ Seeding failed:', error.message);
        process.exit(1);
    }
};

seed();
