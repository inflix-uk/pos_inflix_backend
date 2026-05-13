const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../../.env') });

const Customer = require('../models/Customer');
const Supplier = require('../models/Supplier');

const ukCustomers = [
  {
    name: 'Bristol Retail Ltd',
    email: 'accounts@bristolretail.co.uk',
    phone: '+44 117 123 4567',
    mobile: '+44 7700 900123',
    address: {
      street: '42 Queen Square',
      addressLine2: 'Floor 2',
      city: 'Bristol',
      state: 'England',
      zipCode: 'BS1 4ND',
      country: 'United Kingdom',
    },
    companyNumber: '08472931',
    contactName: 'Sarah Mitchell',
    vatNumber: 'GB 123 4567 89',
    currency: 'GBP',
    loyaltyPoints: 120,
    totalPurchases: 18,
    isActive: true,
  },
  {
    name: 'Manchester Trade Co',
    email: 'orders@manchestertrade.co.uk',
    phone: '+44 161 555 7890',
    mobile: '+44 7700 900456',
    address: {
      street: '15 Deansgate',
      addressLine2: 'Suite 200',
      city: 'Manchester',
      state: 'England',
      zipCode: 'M3 2BQ',
      country: 'United Kingdom',
    },
    companyNumber: '09128465',
    contactName: 'James Wilson',
    vatNumber: 'GB 987 6543 21',
    currency: 'GBP',
    loyaltyPoints: 280,
    totalPurchases: 42,
    isActive: true,
  },
];

const ukSuppliers = [
  {
    name: 'London Wholesale Electronics Ltd',
    email: 'sales@londonwholesale.co.uk',
    phone: '+44 20 7946 0958',
    mobile: '+44 7700 900789',
    address: {
      street: '88 Commerce Road',
      addressLine2: 'Park Royal',
      city: 'London',
      state: 'England',
      zipCode: 'NW10 7PQ',
      country: 'United Kingdom',
    },
    contactPerson: 'David Clarke',
    companyNumber: '05678234',
    vatNumber: 'GB 456 7890 12',
    currency: 'GBP',
    isActive: true,
  },
  {
    name: 'Birmingham Supplies UK',
    email: 'orders@birminghamsupplies.co.uk',
    phone: '+44 121 456 3210',
    mobile: '+44 7700 900321',
    address: {
      street: '25 Digbeth High Street',
      addressLine2: 'Unit 5',
      city: 'Birmingham',
      state: 'England',
      zipCode: 'B5 6DR',
      country: 'United Kingdom',
    },
    contactPerson: 'Emma Thompson',
    companyNumber: '07234561',
    vatNumber: 'GB 654 3210 98',
    currency: 'GBP',
    isActive: true,
  },
];

const seed = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('MongoDB Connected');

    console.log('\nSeeding UK Customers and Suppliers...\n');

    const existingCustomerNames = ukCustomers.map((c) => c.name);
    const existingCount = await Customer.countDocuments({ name: { $in: existingCustomerNames } });
    if (existingCount > 0) {
      console.log('⚠ Some UK customers already exist, skipping customer insert to avoid duplicates.');
    } else {
      const createdCustomers = await Customer.insertMany(ukCustomers);
      console.log(`✓ ${createdCustomers.length} UK customers seeded`);
    }

    const existingSupplierNames = ukSuppliers.map((s) => s.name);
    const existingSuppCount = await Supplier.countDocuments({ name: { $in: existingSupplierNames } });
    if (existingSuppCount > 0) {
      console.log('⚠ Some UK suppliers already exist, skipping supplier insert to avoid duplicates.');
    } else {
      const createdSuppliers = await Supplier.insertMany(ukSuppliers);
      console.log(`✓ ${createdSuppliers.length} UK suppliers seeded`);
    }

    console.log('\n✅ UK accounts seeding completed!\n');
    process.exit(0);
  } catch (error) {
    console.error('❌ Seeding failed:', error.message);
    process.exit(1);
  }
};

seed();
