const express = require('express');
const router = express.Router();
const upload = require('../middleware/upload');
const { protect, requirePermission } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const cloudinary = require('cloudinary').v2;

// Configure Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// Helper function to upload buffer to Cloudinary
const uploadToCloudinary = (buffer, folder = 'products') => {
    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            { folder: folder, resource_type: 'image' },
            (error, result) => {
                if (error) reject(error);
                else resolve(result);
            }
        );
        uploadStream.end(buffer);
    });
};

router.use(protect);

router.post('/image', requirePermission('product.create', 'settings.edit'), upload.single('image'), asyncHandler(async (req, res) => {
    if (!req.file) {
        return res.status(400).json({
            success: false,
            message: 'Please upload an image'
        });
    }

    const result = await uploadToCloudinary(req.file.buffer);

    res.status(200).json({
        success: true,
        message: 'Image uploaded successfully',
        data: {
            filename: result.public_id,
            url: result.secure_url,
            size: req.file.size
        }
    });
}));

// @desc    Upload multiple images
// @route   POST /api/upload/images
// @access  Private
router.post('/images', upload.array('images', 5), asyncHandler(async (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({
            success: false,
            message: 'Please upload at least one image'
        });
    }

    const uploadPromises = req.files.map(file => uploadToCloudinary(file.buffer));
    const results = await Promise.all(uploadPromises);

    const images = results.map((result, index) => ({
        filename: result.public_id,
        url: result.secure_url,
        size: req.files[index].size
    }));

    res.status(200).json({
        success: true,
        message: 'Images uploaded successfully',
        data: images
    });
}));

// @desc    Delete image
// @route   DELETE /api/upload/image/:publicId
// @access  Private
router.delete('/image/:publicId', asyncHandler(async (req, res) => {
    const publicId = req.params.publicId;

    const result = await cloudinary.uploader.destroy(publicId);

    if (result.result === 'ok') {
        res.status(200).json({
            success: true,
            message: 'Image deleted successfully'
        });
    } else {
        res.status(404).json({
            success: false,
            message: 'Image not found'
        });
    }
}));

module.exports = router;
