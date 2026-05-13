const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

// Load env vars - try multiple paths
const envPath = path.resolve(__dirname, '../../.env');
dotenv.config({ path: envPath });

// Fallback - try current working directory
if (!process.env.MONGO_URI && !process.env.MONGODB_URI) {
    dotenv.config({ path: path.resolve(process.cwd(), '.env') });
}

// Support both MONGO_URI and MONGODB_URI
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

console.log('Loading .env from:', envPath);
console.log('MONGO_URI exists:', !!MONGO_URI);

if (!MONGO_URI) {
    console.error('ERROR: MONGO_URI/MONGODB_URI not found in environment variables');
    console.error('Please ensure .env file exists with MONGO_URI or MONGODB_URI defined');
    process.exit(1);
}

const VariantAttribute = require('../models/VariantAttribute');

// Helper function to generate slug
const generateSlug = (name) => {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/(^_|_$)/g, '');
};

// Brand models mapping - All mobile phone models after 2015
const brandModels = {
    'Apple': [
        // iPhone 15 Series (2023)
        'iPhone 15 Pro Max', 'iPhone 15 Pro', 'iPhone 15 Plus', 'iPhone 15',
        // iPhone 14 Series (2022)
        'iPhone 14 Pro Max', 'iPhone 14 Pro', 'iPhone 14 Plus', 'iPhone 14',
        // iPhone 13 Series (2021)
        'iPhone 13 Pro Max', 'iPhone 13 Pro', 'iPhone 13 Mini', 'iPhone 13',
        // iPhone 12 Series (2020)
        'iPhone 12 Pro Max', 'iPhone 12 Pro', 'iPhone 12 Mini', 'iPhone 12',
        // iPhone 11 Series (2019)
        'iPhone 11 Pro Max', 'iPhone 11 Pro', 'iPhone 11',
        // iPhone XS/XR Series (2018)
        'iPhone XS Max', 'iPhone XS', 'iPhone XR',
        // iPhone X/8 Series (2017)
        'iPhone X', 'iPhone 8 Plus', 'iPhone 8',
        // iPhone 7 Series (2016)
        'iPhone 7 Plus', 'iPhone 7',
        // iPhone 6S Series (2015)
        'iPhone 6S Plus', 'iPhone 6S',
        // iPhone SE Series
        'iPhone SE (2022)', 'iPhone SE (2020)', 'iPhone SE (2016)'
    ],
    'Samsung': [
        // Galaxy S24 Series (2024)
        'Galaxy S24 Ultra', 'Galaxy S24+', 'Galaxy S24',
        // Galaxy S23 Series (2023)
        'Galaxy S23 Ultra', 'Galaxy S23+', 'Galaxy S23', 'Galaxy S23 FE',
        // Galaxy S22 Series (2022)
        'Galaxy S22 Ultra', 'Galaxy S22+', 'Galaxy S22',
        // Galaxy S21 Series (2021)
        'Galaxy S21 Ultra', 'Galaxy S21+', 'Galaxy S21', 'Galaxy S21 FE',
        // Galaxy S20 Series (2020)
        'Galaxy S20 Ultra', 'Galaxy S20+', 'Galaxy S20', 'Galaxy S20 FE',
        // Galaxy S10 Series (2019)
        'Galaxy S10+', 'Galaxy S10', 'Galaxy S10e', 'Galaxy S10 5G', 'Galaxy S10 Lite',
        // Galaxy S9 Series (2018)
        'Galaxy S9+', 'Galaxy S9',
        // Galaxy S8 Series (2017)
        'Galaxy S8+', 'Galaxy S8', 'Galaxy S8 Active',
        // Galaxy S7 Series (2016)
        'Galaxy S7 Edge', 'Galaxy S7', 'Galaxy S7 Active',
        // Galaxy S6 Series (2015)
        'Galaxy S6 Edge+', 'Galaxy S6 Edge', 'Galaxy S6', 'Galaxy S6 Active',
        // Galaxy Z Fold Series
        'Galaxy Z Fold 5', 'Galaxy Z Fold 4', 'Galaxy Z Fold 3', 'Galaxy Z Fold 2', 'Galaxy Fold',
        // Galaxy Z Flip Series
        'Galaxy Z Flip 5', 'Galaxy Z Flip 4', 'Galaxy Z Flip 3', 'Galaxy Z Flip',
        // Galaxy Note Series
        'Galaxy Note 20 Ultra', 'Galaxy Note 20', 'Galaxy Note 10+', 'Galaxy Note 10', 'Galaxy Note 10 Lite',
        'Galaxy Note 9', 'Galaxy Note 8', 'Galaxy Note 7', 'Galaxy Note 5',
        // Galaxy A Series (Premium)
        'Galaxy A73', 'Galaxy A72', 'Galaxy A71', 'Galaxy A70', 'Galaxy A54', 'Galaxy A53', 'Galaxy A52', 'Galaxy A52s', 'Galaxy A51',
        'Galaxy A50', 'Galaxy A34', 'Galaxy A33', 'Galaxy A32', 'Galaxy A24', 'Galaxy A23', 'Galaxy A22', 'Galaxy A15', 'Galaxy A14', 'Galaxy A13', 'Galaxy A12',
        // Galaxy M Series
        'Galaxy M54', 'Galaxy M53', 'Galaxy M52', 'Galaxy M51', 'Galaxy M34', 'Galaxy M33', 'Galaxy M32', 'Galaxy M31', 'Galaxy M30', 'Galaxy M21', 'Galaxy M20', 'Galaxy M14', 'Galaxy M13', 'Galaxy M12',
        // Galaxy F Series
        'Galaxy F54', 'Galaxy F34', 'Galaxy F23', 'Galaxy F22', 'Galaxy F14', 'Galaxy F13', 'Galaxy F12'
    ],
    'Google': [
        // Pixel 8 Series (2023)
        'Pixel 8 Pro', 'Pixel 8', 'Pixel 8a',
        // Pixel 7 Series (2022)
        'Pixel 7 Pro', 'Pixel 7', 'Pixel 7a',
        // Pixel 6 Series (2021)
        'Pixel 6 Pro', 'Pixel 6', 'Pixel 6a',
        // Pixel 5 Series (2020)
        'Pixel 5', 'Pixel 5a', 'Pixel 4a 5G',
        // Pixel 4 Series (2019)
        'Pixel 4 XL', 'Pixel 4', 'Pixel 4a',
        // Pixel 3 Series (2018)
        'Pixel 3 XL', 'Pixel 3', 'Pixel 3a XL', 'Pixel 3a',
        // Pixel 2 Series (2017)
        'Pixel 2 XL', 'Pixel 2',
        // Pixel 1 Series (2016)
        'Pixel XL', 'Pixel',
        // Pixel Fold
        'Pixel Fold'
    ],
    'OnePlus': [
        // OnePlus 12 Series (2024)
        'OnePlus 12', 'OnePlus 12R',
        // OnePlus 11 Series (2023)
        'OnePlus 11', 'OnePlus 11R',
        // OnePlus 10 Series (2022)
        'OnePlus 10 Pro', 'OnePlus 10T', 'OnePlus 10R',
        // OnePlus 9 Series (2021)
        'OnePlus 9 Pro', 'OnePlus 9', 'OnePlus 9R', 'OnePlus 9RT',
        // OnePlus 8 Series (2020)
        'OnePlus 8 Pro', 'OnePlus 8', 'OnePlus 8T',
        // OnePlus 7 Series (2019)
        'OnePlus 7 Pro', 'OnePlus 7', 'OnePlus 7T Pro', 'OnePlus 7T',
        // OnePlus 6 Series (2018)
        'OnePlus 6', 'OnePlus 6T',
        // OnePlus 5 Series (2017)
        'OnePlus 5', 'OnePlus 5T',
        // OnePlus 3 Series (2016)
        'OnePlus 3', 'OnePlus 3T',
        // OnePlus X/2 (2015)
        'OnePlus X', 'OnePlus 2',
        // OnePlus Nord Series
        'OnePlus Nord 3', 'OnePlus Nord 2T', 'OnePlus Nord 2', 'OnePlus Nord', 'OnePlus Nord CE 3', 'OnePlus Nord CE 2', 'OnePlus Nord CE',
        'OnePlus Nord N30', 'OnePlus Nord N20', 'OnePlus Nord N10', 'OnePlus Nord N100',
        // OnePlus Open
        'OnePlus Open'
    ],
    'Xiaomi': [
        // Xiaomi 14 Series (2024)
        'Xiaomi 14 Ultra', 'Xiaomi 14 Pro', 'Xiaomi 14',
        // Xiaomi 13 Series (2023)
        'Xiaomi 13 Ultra', 'Xiaomi 13 Pro', 'Xiaomi 13', 'Xiaomi 13T Pro', 'Xiaomi 13T', 'Xiaomi 13 Lite',
        // Xiaomi 12 Series (2022)
        'Xiaomi 12 Pro', 'Xiaomi 12', 'Xiaomi 12X', 'Xiaomi 12T Pro', 'Xiaomi 12T', 'Xiaomi 12 Lite',
        // Xiaomi 11 Series (2021)
        'Xiaomi 11 Ultra', 'Xiaomi 11 Pro', 'Xiaomi 11', 'Xiaomi 11T Pro', 'Xiaomi 11T', 'Xiaomi 11 Lite 5G NE', 'Xiaomi 11i',
        // Mi 10 Series (2020)
        'Mi 10 Ultra', 'Mi 10 Pro', 'Mi 10', 'Mi 10T Pro', 'Mi 10T', 'Mi 10T Lite', 'Mi 10 Lite',
        // Mi 9 Series (2019)
        'Mi 9 Pro', 'Mi 9', 'Mi 9T Pro', 'Mi 9T', 'Mi 9 SE', 'Mi 9 Lite',
        // Mi 8 Series (2018)
        'Mi 8 Pro', 'Mi 8', 'Mi 8 SE', 'Mi 8 Lite',
        // Mi 6 Series (2017)
        'Mi 6', 'Mi 6X',
        // Mi 5 Series (2016)
        'Mi 5', 'Mi 5s', 'Mi 5s Plus',
        // Mi Mix Series
        'Mi Mix Fold 3', 'Mi Mix Fold 2', 'Mi Mix Fold', 'Mi Mix 4', 'Mi Mix 3', 'Mi Mix 2S', 'Mi Mix 2', 'Mi Mix',
        // Mi Note Series
        'Mi Note 10 Pro', 'Mi Note 10', 'Mi Note 10 Lite'
    ],
    'Oppo': [
        // Find X Series
        'Find X7 Ultra', 'Find X7', 'Find X6 Pro', 'Find X6', 'Find X5 Pro', 'Find X5', 'Find X3 Pro', 'Find X3', 'Find X2 Pro', 'Find X2',
        'Find X', 'Find X7 Pro',
        // Find N Series (Foldable)
        'Find N3', 'Find N3 Flip', 'Find N2', 'Find N2 Flip', 'Find N',
        // Reno Series
        'Reno 11 Pro', 'Reno 11', 'Reno 10 Pro+', 'Reno 10 Pro', 'Reno 10', 'Reno 9 Pro+', 'Reno 9 Pro', 'Reno 9',
        'Reno 8 Pro', 'Reno 8', 'Reno 8T', 'Reno 7 Pro', 'Reno 7', 'Reno 7 SE', 'Reno 6 Pro', 'Reno 6', 'Reno 6 Z',
        'Reno 5 Pro', 'Reno 5', 'Reno 5 Z', 'Reno 4 Pro', 'Reno 4', 'Reno 4 Z', 'Reno 3 Pro', 'Reno 3',
        'Reno 2', 'Reno 2 Z', 'Reno', 'Reno Z',
        // A Series
        'A98', 'A96', 'A95', 'A94', 'A93', 'A92', 'A91', 'A78', 'A77', 'A76', 'A74', 'A73', 'A72', 'A58', 'A57', 'A55', 'A54', 'A53', 'A38', 'A18', 'A17', 'A16',
        // F Series
        'F25 Pro', 'F23', 'F21 Pro', 'F19 Pro+', 'F19 Pro', 'F19', 'F17 Pro', 'F17', 'F15', 'F11 Pro', 'F11'
    ],
    'Vivo': [
        // X Series
        'X100 Pro', 'X100', 'X90 Pro+', 'X90 Pro', 'X90', 'X80 Pro', 'X80', 'X70 Pro+', 'X70 Pro', 'X70',
        'X60 Pro+', 'X60 Pro', 'X60', 'X50 Pro', 'X50',
        // V Series
        'V30 Pro', 'V30', 'V29 Pro', 'V29', 'V27 Pro', 'V27', 'V25 Pro', 'V25', 'V23 Pro', 'V23',
        'V21 Pro', 'V21', 'V20 Pro', 'V20', 'V19', 'V17 Pro', 'V17', 'V15 Pro', 'V15',
        // Y Series
        'Y100', 'Y78', 'Y77', 'Y76', 'Y75', 'Y73', 'Y72', 'Y56', 'Y55', 'Y36', 'Y35', 'Y33', 'Y27', 'Y22', 'Y21', 'Y20', 'Y19', 'Y17', 'Y16', 'Y15',
        // T Series
        'T2 Pro', 'T2', 'T1 Pro', 'T1',
        // iQOO (Vivo sub-brand in some markets)
        'iQOO 12 Pro', 'iQOO 12', 'iQOO 11 Pro', 'iQOO 11', 'iQOO Neo 9 Pro', 'iQOO Neo 9', 'iQOO Z9', 'iQOO Z7 Pro', 'iQOO Z7'
    ],
    'Realme': [
        // GT Series
        'GT 5 Pro', 'GT 5', 'GT 3', 'GT Neo 5', 'GT Neo 5 SE', 'GT Neo 3', 'GT Neo 3T', 'GT Neo 2', 'GT Neo',
        'GT 2 Pro', 'GT 2', 'GT Master Edition', 'GT',
        // Number Series
        '12 Pro+', '12 Pro', '12', '11 Pro+', '11 Pro', '11', '10 Pro+', '10 Pro', '10',
        '9 Pro+', '9 Pro', '9', '9i', '8 Pro', '8', '8i', '7 Pro', '7', '7i', '6 Pro', '6', '6i', '5 Pro', '5', '5i', '5s',
        '3 Pro', '3', '3i', '2 Pro', '2', '1',
        // Narzo Series
        'Narzo 60 Pro', 'Narzo 60', 'Narzo 50 Pro', 'Narzo 50', 'Narzo 50A', 'Narzo 30 Pro', 'Narzo 30', 'Narzo 30A', 'Narzo 20 Pro', 'Narzo 20',
        // C Series
        'C67', 'C55', 'C53', 'C51', 'C35', 'C33', 'C31', 'C30', 'C25', 'C21', 'C20', 'C17', 'C15', 'C12', 'C11'
    ],
    'Huawei': [
        // Mate Series
        'Mate 60 Pro+', 'Mate 60 Pro', 'Mate 60', 'Mate 50 Pro', 'Mate 50', 'Mate 40 Pro+', 'Mate 40 Pro', 'Mate 40',
        'Mate 30 Pro', 'Mate 30', 'Mate 20 Pro', 'Mate 20', 'Mate 20 X', 'Mate 10 Pro', 'Mate 10', 'Mate 9 Pro', 'Mate 9',
        'Mate X5', 'Mate X3', 'Mate X2', 'Mate Xs 2', 'Mate Xs', 'Mate X',
        // P Series
        'P60 Pro', 'P60', 'P50 Pro', 'P50', 'P50 Pocket', 'P40 Pro+', 'P40 Pro', 'P40', 'P40 Lite',
        'P30 Pro', 'P30', 'P30 Lite', 'P20 Pro', 'P20', 'P20 Lite', 'P10 Plus', 'P10', 'P10 Lite', 'P9 Plus', 'P9', 'P9 Lite',
        // Nova Series
        'Nova 12 Pro', 'Nova 12', 'Nova 11 Pro', 'Nova 11', 'Nova 10 Pro', 'Nova 10', 'Nova 9 Pro', 'Nova 9',
        'Nova 8 Pro', 'Nova 8', 'Nova 7 Pro', 'Nova 7', 'Nova 6', 'Nova 5T', 'Nova 5 Pro', 'Nova 5',
        // Y Series
        'Y9 Prime', 'Y9', 'Y7 Prime', 'Y7', 'Y6 Prime', 'Y6'
    ],
    'Honor': [
        // Magic Series
        'Magic 6 Pro', 'Magic 6', 'Magic 5 Pro', 'Magic 5', 'Magic 4 Pro', 'Magic 4', 'Magic 3 Pro', 'Magic 3',
        'Magic V2', 'Magic Vs', 'Magic V',
        // Number Series
        '90 Pro', '90', '80 Pro', '80', '70 Pro', '70', '60 Pro', '60', '50 Pro', '50',
        // X Series
        'X9b', 'X9a', 'X8', 'X7', 'X6',
        // Play Series
        'Play 8T', 'Play 7T', 'Play 6T',
        // View Series
        'View 50', 'View 40', 'View 30 Pro', 'View 30', 'View 20', 'View 10'
    ],
    'Motorola': [
        // Edge Series
        'Edge 50 Pro', 'Edge 50', 'Edge 40 Pro', 'Edge 40', 'Edge 40 Neo', 'Edge 30 Ultra', 'Edge 30 Pro', 'Edge 30', 'Edge 30 Neo',
        'Edge 20 Pro', 'Edge 20', 'Edge 20 Lite', 'Edge+', 'Edge',
        // Razr Series (Foldable)
        'Razr 40 Ultra', 'Razr 40', 'Razr 2022', 'Razr 5G', 'Razr 2019',
        // G Series
        'Moto G84', 'Moto G73', 'Moto G72', 'Moto G71', 'Moto G64', 'Moto G54', 'Moto G53', 'Moto G52', 'Moto G51',
        'Moto G42', 'Moto G41', 'Moto G40', 'Moto G34', 'Moto G32', 'Moto G31', 'Moto G30', 'Moto G24', 'Moto G23', 'Moto G22',
        'Moto G Power', 'Moto G Stylus', 'Moto G Fast', 'Moto G Play',
        // E Series
        'Moto E32', 'Moto E30', 'Moto E22', 'Moto E20', 'Moto E13', 'Moto E7 Power', 'Moto E7', 'Moto E6 Plus', 'Moto E6',
        // One Series
        'One Fusion+', 'One Fusion', 'One Hyper', 'One Zoom', 'One Action', 'One Vision', 'One Power', 'One'
    ],
    'Nokia': [
        // X Series
        'X100', 'X30', 'X20', 'X10',
        // G Series
        'G400', 'G310', 'G300', 'G60', 'G50', 'G42', 'G22', 'G21', 'G20', 'G11', 'G10',
        // C Series
        'C32', 'C31', 'C30', 'C22', 'C21 Plus', 'C21', 'C20', 'C12', 'C10', 'C3', 'C2', 'C1',
        // XR Series
        'XR21', 'XR20',
        // Classic Number Series
        '8.3', '8.1', '7.2', '7.1', '6.2', '6.1 Plus', '6.1', '5.4', '5.3', '5.1 Plus', '5.1',
        '4.2', '3.4', '3.2', '3.1 Plus', '3.1', '2.4', '2.3', '2.2', '2.1', '1.4', '1.3', '1'
    ],
    'Sony': [
        // Xperia 1 Series
        'Xperia 1 VI', 'Xperia 1 V', 'Xperia 1 IV', 'Xperia 1 III', 'Xperia 1 II', 'Xperia 1',
        // Xperia 5 Series
        'Xperia 5 V', 'Xperia 5 IV', 'Xperia 5 III', 'Xperia 5 II', 'Xperia 5',
        // Xperia 10 Series
        'Xperia 10 VI', 'Xperia 10 V', 'Xperia 10 IV', 'Xperia 10 III', 'Xperia 10 II', 'Xperia 10', 'Xperia 10 Plus',
        // Xperia Pro Series
        'Xperia Pro-I', 'Xperia Pro',
        // Older Series
        'Xperia XZ3', 'Xperia XZ2 Premium', 'Xperia XZ2', 'Xperia XZ2 Compact', 'Xperia XZ1', 'Xperia XZ1 Compact',
        'Xperia XZ Premium', 'Xperia XZs', 'Xperia XZ', 'Xperia X Performance', 'Xperia X', 'Xperia X Compact',
        'Xperia Z5 Premium', 'Xperia Z5', 'Xperia Z5 Compact'
    ],
    'LG': [
        // V Series
        'V60 ThinQ', 'V50 ThinQ', 'V50S ThinQ', 'V40 ThinQ', 'V35 ThinQ', 'V30', 'V30+', 'V20', 'V10',
        // G Series
        'G8X ThinQ', 'G8 ThinQ', 'G8S ThinQ', 'G7 ThinQ', 'G7 One', 'G6', 'G5', 'G4',
        // Velvet Series
        'Velvet', 'Velvet 5G',
        // Wing
        'Wing',
        // K Series
        'K92', 'K71', 'K62', 'K61', 'K52', 'K51', 'K42', 'K41S', 'K40', 'K31', 'K30', 'K22', 'K20',
        // Stylo Series
        'Stylo 6', 'Stylo 5', 'Stylo 4'
    ],
    'Asus': [
        // ROG Phone Series
        'ROG Phone 8 Pro', 'ROG Phone 8', 'ROG Phone 7 Ultimate', 'ROG Phone 7', 'ROG Phone 6 Pro', 'ROG Phone 6',
        'ROG Phone 5s Pro', 'ROG Phone 5s', 'ROG Phone 5 Pro', 'ROG Phone 5', 'ROG Phone 3', 'ROG Phone 2', 'ROG Phone',
        // Zenfone Series
        'Zenfone 11 Ultra', 'Zenfone 10', 'Zenfone 9', 'Zenfone 8', 'Zenfone 8 Flip', 'Zenfone 7 Pro', 'Zenfone 7',
        'Zenfone 6', 'Zenfone 5Z', 'Zenfone 5', 'Zenfone 5 Lite', 'Zenfone 4 Pro', 'Zenfone 4', 'Zenfone 3 Ultra', 'Zenfone 3'
    ],
    'Lenovo': [
        // Legion Series
        'Legion Phone Duel 2', 'Legion Phone Duel', 'Legion Y90', 'Legion Y70',
        // Z Series
        'Z6 Pro', 'Z6', 'Z5 Pro GT', 'Z5 Pro', 'Z5', 'Z5s',
        // K Series
        'K14 Plus', 'K14', 'K13', 'K12', 'K10', 'K9', 'K6 Enjoy', 'K5 Pro', 'K5',
        // A Series
        'A7', 'A6 Note'
    ],
    'ZTE': [
        // Axon Series
        'Axon 60 Ultra', 'Axon 50 Ultra', 'Axon 40 Ultra', 'Axon 30 Ultra', 'Axon 30', 'Axon 20', 'Axon 11', 'Axon 10 Pro',
        // Nubia Series
        'Nubia Z60 Ultra', 'Nubia Z50 Ultra', 'Nubia Z50', 'Nubia Z40 Pro', 'Nubia Z30 Pro', 'Nubia Z20', 'Nubia Z17',
        'Nubia Red Magic 9 Pro', 'Nubia Red Magic 8 Pro', 'Nubia Red Magic 7', 'Nubia Red Magic 6', 'Nubia Red Magic 5G',
        // Blade Series
        'Blade V50', 'Blade V40', 'Blade V30', 'Blade A73', 'Blade A54', 'Blade A53', 'Blade A52', 'Blade A72'
    ],
    'Tecno': [
        // Phantom Series
        'Phantom X2 Pro', 'Phantom X2', 'Phantom X', 'Phantom V Fold', 'Phantom V Flip',
        // Camon Series
        'Camon 30 Pro', 'Camon 30', 'Camon 20 Pro', 'Camon 20', 'Camon 19 Pro', 'Camon 19', 'Camon 18 Premier', 'Camon 18',
        'Camon 17 Pro', 'Camon 17', 'Camon 16 Premier', 'Camon 16', 'Camon 15 Premier', 'Camon 15',
        // Spark Series
        'Spark 20 Pro', 'Spark 20', 'Spark 10 Pro', 'Spark 10', 'Spark 9 Pro', 'Spark 9', 'Spark 8', 'Spark 7 Pro', 'Spark 7',
        // Pova Series
        'Pova 6 Pro', 'Pova 5 Pro', 'Pova 5', 'Pova 4 Pro', 'Pova 4', 'Pova 3', 'Pova 2', 'Pova',
        // Pop Series
        'Pop 8', 'Pop 7 Pro', 'Pop 7', 'Pop 6', 'Pop 5'
    ],
    'Infinix': [
        // Zero Series
        'Zero 30', 'Zero 30 Ultra', 'Zero 20', 'Zero X Pro', 'Zero X', 'Zero 8', 'Zero 5',
        // Note Series
        'Note 40 Pro', 'Note 40', 'Note 30 Pro', 'Note 30', 'Note 12 Pro', 'Note 12', 'Note 11 Pro', 'Note 11', 'Note 10 Pro', 'Note 10',
        // Hot Series
        'Hot 40 Pro', 'Hot 40', 'Hot 30', 'Hot 30i', 'Hot 20', 'Hot 20i', 'Hot 12', 'Hot 12 Play', 'Hot 11', 'Hot 11 Play', 'Hot 10', 'Hot 10 Play',
        // Smart Series
        'Smart 8', 'Smart 7', 'Smart 6', 'Smart 5',
        // GT Series
        'GT 20 Pro', 'GT 10 Pro'
    ],
    'Nothing': [
        // Phone Series
        'Phone 2a', 'Phone 2', 'Phone 1'
    ],
    'Poco': [
        // F Series
        'Poco F6 Pro', 'Poco F6', 'Poco F5 Pro', 'Poco F5', 'Poco F4 GT', 'Poco F4', 'Poco F3', 'Poco F3 GT', 'Poco F2 Pro', 'Poco F1',
        // X Series
        'Poco X6 Pro', 'Poco X6', 'Poco X5 Pro', 'Poco X5', 'Poco X4 Pro', 'Poco X4 GT', 'Poco X3 Pro', 'Poco X3', 'Poco X3 NFC', 'Poco X2',
        // M Series
        'Poco M6 Pro', 'Poco M6', 'Poco M5', 'Poco M5s', 'Poco M4 Pro', 'Poco M4', 'Poco M3 Pro', 'Poco M3', 'Poco M2 Pro', 'Poco M2',
        // C Series
        'Poco C65', 'Poco C55', 'Poco C51', 'Poco C40', 'Poco C31', 'Poco C3'
    ],
    'iQOO': [
        // Number Series
        'iQOO 12 Pro', 'iQOO 12', 'iQOO 11 Pro', 'iQOO 11', 'iQOO 10 Pro', 'iQOO 10', 'iQOO 9 Pro', 'iQOO 9',
        'iQOO 8 Pro', 'iQOO 8', 'iQOO 7', 'iQOO 5 Pro', 'iQOO 5', 'iQOO 3',
        // Neo Series
        'iQOO Neo 9 Pro', 'iQOO Neo 9', 'iQOO Neo 8 Pro', 'iQOO Neo 8', 'iQOO Neo 7 Pro', 'iQOO Neo 7',
        'iQOO Neo 6', 'iQOO Neo 5', 'iQOO Neo 3',
        // Z Series
        'iQOO Z9', 'iQOO Z9x', 'iQOO Z7 Pro', 'iQOO Z7', 'iQOO Z6 Pro', 'iQOO Z6', 'iQOO Z5', 'iQOO Z3'
    ],
    'Redmi': [
        // Note Series
        'Redmi Note 13 Pro+', 'Redmi Note 13 Pro', 'Redmi Note 13', 'Redmi Note 12 Pro+', 'Redmi Note 12 Pro', 'Redmi Note 12',
        'Redmi Note 11 Pro+', 'Redmi Note 11 Pro', 'Redmi Note 11', 'Redmi Note 11S', 'Redmi Note 10 Pro', 'Redmi Note 10', 'Redmi Note 10S',
        'Redmi Note 9 Pro', 'Redmi Note 9', 'Redmi Note 9S', 'Redmi Note 8 Pro', 'Redmi Note 8', 'Redmi Note 7 Pro', 'Redmi Note 7',
        // K Series
        'Redmi K70 Pro', 'Redmi K70', 'Redmi K60 Pro', 'Redmi K60', 'Redmi K60 Ultra', 'Redmi K50 Pro', 'Redmi K50',
        'Redmi K40 Pro', 'Redmi K40', 'Redmi K30 Pro', 'Redmi K30', 'Redmi K20 Pro', 'Redmi K20',
        // Number Series
        'Redmi 13', 'Redmi 13C', 'Redmi 12', 'Redmi 12C', 'Redmi 11 Prime', 'Redmi 10', 'Redmi 10 Prime', 'Redmi 10C',
        'Redmi 9', 'Redmi 9 Prime', 'Redmi 9A', 'Redmi 9C', 'Redmi 8', 'Redmi 8A', 'Redmi 7', 'Redmi 7A',
        // A Series
        'Redmi A3', 'Redmi A2', 'Redmi A1'
    ]
};

// Sample data for seeding - simple variant attributes
const rawData = [
    {
        name: 'Brands',
        values: ['Apple', 'Samsung', 'Google', 'OnePlus', 'Xiaomi', 'Oppo', 'Vivo', 'Realme', 'Huawei', 'Honor', 'Motorola', 'Nokia', 'Sony', 'LG', 'Asus', 'Lenovo', 'ZTE', 'Tecno', 'Infinix', 'Nothing', 'Poco', 'iQOO', 'Redmi'],
        description: 'Phone and electronics brands',
        isActive: true,
        hasModels: true
    },
    {
        name: 'Size',
        values: ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'],
        description: 'Clothing sizes',
        isActive: true
    },
    {
        name: 'Color',
        values: ['Red', 'Blue', 'Green', 'Black', 'White', 'Yellow', 'Orange', 'Purple', 'Pink', 'Grey', 'Brown', 'Navy'],
        description: 'Product colors',
        isActive: true
    },
    {
        name: 'Material',
        values: ['Cotton', 'Polyester', 'Wool', 'Silk', 'Leather', 'Denim', 'Linen', 'Nylon'],
        description: 'Fabric materials',
        isActive: true
    },
    {
        name: 'Storage',
        values: ['32GB', '64GB', '128GB', '256GB', '512GB', '1TB', '2TB'],
        description: 'Storage capacity',
        isActive: true
    },
    {
        name: 'RAM',
        values: ['4GB', '8GB', '16GB', '32GB', '64GB'],
        description: 'Memory size',
        isActive: true
    },
    {
        name: 'Screen Size',
        values: ['5.5"', '6.1"', '6.5"', '6.7"', '13"', '14"', '15.6"', '17"', '24"', '27"', '32"'],
        description: 'Display screen sizes',
        isActive: true
    },
    {
        name: 'Weight',
        values: ['Light', 'Medium', 'Heavy'],
        description: 'Product weight categories',
        isActive: true
    },
    {
        name: 'Pattern',
        values: ['Solid', 'Striped', 'Checkered', 'Floral', 'Polka Dot', 'Abstract', 'Geometric'],
        description: 'Design patterns',
        isActive: true
    },
    {
        name: 'Fit',
        values: ['Slim', 'Regular', 'Relaxed', 'Oversized', 'Tailored'],
        description: 'Clothing fit types',
        isActive: true
    },
    {
        name: 'Sleeve Length',
        values: ['Sleeveless', 'Short Sleeve', 'Half Sleeve', 'Three-Quarter', 'Full Sleeve'],
        description: 'Sleeve length options',
        isActive: true
    },
    {
        name: 'Collar Type',
        values: ['Round Neck', 'V-Neck', 'Collar', 'Mandarin', 'Polo', 'Hooded'],
        description: 'Collar/neck types',
        isActive: true
    },
    {
        name: 'Shoe Size',
        values: ['36', '37', '38', '39', '40', '41', '42', '43', '44', '45', '46'],
        description: 'European shoe sizes',
        isActive: true
    },
    {
        name: 'Processor',
        values: ['Intel i3', 'Intel i5', 'Intel i7', 'Intel i9', 'AMD Ryzen 3', 'AMD Ryzen 5', 'AMD Ryzen 7', 'Apple M1', 'Apple M2', 'Apple M3'],
        description: 'Computer processor types',
        isActive: true
    },
    {
        name: 'Connectivity',
        values: ['WiFi', 'Bluetooth', '4G', '5G', 'USB-C', 'HDMI', 'Ethernet'],
        description: 'Connectivity options',
        isActive: true
    },
    {
        name: 'Warranty',
        values: ['6 Months', '1 Year', '2 Years', '3 Years', '5 Years', 'Lifetime'],
        description: 'Warranty periods',
        isActive: true
    },
    {
        name: 'Grade',
        values: ['A - Pristine', 'B - Good', 'C - Fair', 'D - Poor', 'New', 'Refurbished', 'Open Box'],
        description: 'Product condition grades',
        isActive: true
    }
];

// Convert string values to objects with name, slug, isActive, and models (for brands)
const variantAttributesData = rawData.map(item => ({
    ...item,
    slug: generateSlug(item.name),
    values: item.values.map(val => {
        const valueObj = {
            name: val,
            slug: generateSlug(val),
            isActive: true
        };
        // Add models for brands
        if (item.hasModels && brandModels[val]) {
            valueObj.models = brandModels[val].map(model => ({
                name: model,
                slug: generateSlug(model),
                isActive: true
            }));
        }
        return valueObj;
    })
}));

const seedVariantAttributes = async () => {
    try {
        // Connect to MongoDB
        await mongoose.connect(MONGO_URI);
        console.log('MongoDB connected...');

        // Clear existing data
        await VariantAttribute.deleteMany({});
        console.log('Cleared existing variant attributes...');

        // Insert seed data
        const result = await VariantAttribute.insertMany(variantAttributesData);
        console.log(`Seeded ${result.length} variant attributes successfully!`);

        result.forEach(attr => {
            const totalModels = attr.values?.reduce((sum, val) => sum + (val.models?.length || 0), 0) || 0;
            if (totalModels > 0) {
                console.log(`  - ${attr.name} (${attr.slug}): ${attr.values?.length || 0} values, ${totalModels} models`);
            } else {
                console.log(`  - ${attr.name} (${attr.slug}): ${attr.values?.length || 0} values`);
            }
        });

        console.log('\nSeeding completed successfully!');
        process.exit(0);
    } catch (error) {
        console.error('Error seeding data:', error);
        process.exit(1);
    }
};

// Run the seeder
seedVariantAttributes();
