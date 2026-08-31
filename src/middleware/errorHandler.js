const errorHandler = (err, req, res, next) => {
    let error = { ...err };
    error.message = err.message;

    // Log error for dev
    console.error(err);

    // Mongoose bad ObjectId
    if (err.name === 'CastError') {
        const message = 'Resource not found';
        error = { message, statusCode: 404 };
    }

    // Mongoose duplicate key
    if (err.code === 11000) {
        const field = Object.keys(err.keyValue)[0];
        const message = field === 'purchaseNumber'
            ? 'A parcel with this number was just saved. Please click "Add parcel to inventory" again to get a new number.'
            : `Duplicate field value entered for ${field}`;
        error = { message, statusCode: 400 };
    }

    // Mongoose validation error
    if (err.name === 'ValidationError') {
        const message = Object.values(err.errors).map(val => val.message).join(', ');
        error = { message, statusCode: 400 };
    }

    // JWT errors
    if (err.name === 'JsonWebTokenError') {
        const message = 'Invalid token';
        error = { message, statusCode: 401 };
    }

    if (err.name === 'TokenExpiredError') {
        const message = 'Token expired';
        error = { message, statusCode: 401 };
    }

    // Body too large (e.g. invoice PDF base64 for email)
    if (err.type === 'entity.too.large' || err.name === 'PayloadTooLargeError' || err.status === 413) {
        error = {
            message: 'Attachment is too large to email. Try a simpler invoice template, or contact support.',
            statusCode: 413,
        };
    }

    res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Server Error',
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
};

module.exports = errorHandler;
