const jwt = require('jsonwebtoken');
const config = require('../config');

/**
 * Protect customer-portal routes.
 * Verifies JWT with type === 'customer-portal' and attaches req.portalCustomer.
 */
const protectCustomerPortal = async (req, res, next) => {
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        token = req.headers.authorization.split(' ')[1];
    }
    if (!token) {
        return res.status(401).json({ success: false, message: 'Not authorized' });
    }
    try {
        const decoded = jwt.verify(token, config.jwtSecret);
        if (decoded.type !== 'customer-portal') {
            return res.status(401).json({ success: false, message: 'Invalid token type' });
        }
        req.portalCustomer = { id: decoded.id };
        next();
    } catch (error) {
        return res.status(401).json({ success: false, message: 'Not authorized' });
    }
};

module.exports = { protectCustomerPortal };
