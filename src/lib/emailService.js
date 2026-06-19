const nodemailer = require('nodemailer');
const EmailSettings = require('../models/EmailSettings');

function transportOptionsFromSettings(settings) {
    const port = Number(settings.smtpPort) || 587;
    const mode = settings.smtpSecure || 'tls';
    // Port 465 uses implicit TLS (SSL) even when the UI says "TLS".
    const secure = mode === 'ssl' || port === 465;
    const opts = {
        host: settings.smtpHost,
        port,
        secure,
        auth: {
            user: settings.smtpUsername,
            pass: settings.smtpPassword,
        },
    };
    if (mode === 'tls' && !secure) {
        opts.requireTLS = true;
    }
    return opts;
}

function formatFrom(settings) {
    const name = String(settings.fromName || '').replace(/"/g, "'");
    const email = settings.fromEmail;
    return name ? `"${name}" <${email}>` : email;
}

function formatReplyTo(settings) {
    if (!settings.replyToEmail) return undefined;
    const name = String(settings.replyToName || '').replace(/"/g, "'");
    return name ? `"${name}" <${settings.replyToEmail}>` : settings.replyToEmail;
}

async function getEmailSettings() {
    return EmailSettings.findOne();
}

async function sendMail(settings, { to, subject, text, html, attachments }) {
    const transporter = nodemailer.createTransport(transportOptionsFromSettings(settings));
    const mailOptions = {
        from: formatFrom(settings),
        to,
        subject,
        text,
        html,
        attachments,
    };
    const replyTo = formatReplyTo(settings);
    if (replyTo) {
        mailOptions.replyTo = replyTo;
    }
    return transporter.sendMail(mailOptions);
}

async function sendTestEmail(settings, testEmail) {
    return sendMail(settings, {
        to: testEmail,
        subject: 'Test Email from POS Inflix',
        text: 'This is a test email to verify your email settings are working correctly.',
        html: '<p>This is a test email to verify your email settings are working correctly.</p>',
    });
}

module.exports = {
    transportOptionsFromSettings,
    sendMail,
    sendTestEmail,
    getEmailSettings,
};
