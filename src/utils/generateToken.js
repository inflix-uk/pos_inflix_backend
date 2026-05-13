const jwt = require('jsonwebtoken');
const config = require('../config');

const generateToken = (userId, role) => {
    return jwt.sign({ id: userId, role }, config.jwtSecret, {
        expiresIn: config.jwtExpire
    });
};

module.exports = generateToken;
