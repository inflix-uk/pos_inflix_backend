const mongoose = require('mongoose');

const emailSettingsSchema = new mongoose.Schema({
    smtpHost: {
        type: String,
        required: [true, 'SMTP host is required'],
        trim: true,
        maxlength: [255, 'SMTP host cannot exceed 255 characters']
    },
    smtpPort: {
        type: Number,
        required: [true, 'SMTP port is required'],
        min: [1, 'Port must be at least 1'],
        max: [65535, 'Port cannot exceed 65535'],
        default: 587
    },
    smtpSecure: {
        type: String,
        enum: ['none', 'ssl', 'tls'],
        default: 'tls'
    },
    smtpUsername: {
        type: String,
        required: [true, 'SMTP username is required'],
        trim: true,
        maxlength: [255, 'SMTP username cannot exceed 255 characters']
    },
    smtpPassword: {
        type: String,
        required: [true, 'SMTP password is required'],
        maxlength: [255, 'SMTP password cannot exceed 255 characters']
    },
    fromEmail: {
        type: String,
        required: [true, 'From email is required'],
        trim: true,
        lowercase: true,
        maxlength: [255, 'From email cannot exceed 255 characters'],
        match: [/^\S+@\S+\.\S+$/, 'Please enter a valid email address']
    },
    fromName: {
        type: String,
        required: [true, 'From name is required'],
        trim: true,
        maxlength: [100, 'From name cannot exceed 100 characters']
    },
    replyToEmail: {
        type: String,
        trim: true,
        lowercase: true,
        maxlength: [255, 'Reply-to email cannot exceed 255 characters'],
        default: ''
    },
    replyToName: {
        type: String,
        trim: true,
        maxlength: [100, 'Reply-to name cannot exceed 100 characters'],
        default: ''
    },
    enableEmailNotifications: {
        type: Boolean,
        default: true
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    updatedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }
}, {
    timestamps: true
});

// Ensure only one document exists (singleton pattern)
emailSettingsSchema.statics.getSettings = async function() {
    let settings = await this.findOne();
    return settings;
};

module.exports = require('../lib/tenantModel')('EmailSettings', emailSettingsSchema);
