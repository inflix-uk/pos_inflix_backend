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
        // Fail fast so Coolify/Traefik does not kill the request with a blank "Failed to fetch".
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 45000,
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
    if (!settings?.smtpHost || !settings?.smtpUsername || !settings?.fromEmail) {
        throw new Error('Email is not configured. Go to Settings → Email and save your SMTP settings.');
    }
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
    try {
        return await transporter.sendMail(mailOptions);
    } catch (err) {
        const detail = err && err.message ? err.message : 'Failed to send email';
        const host = settings.smtpHost;
        const port = settings.smtpPort || 587;
        if (/timeout|etimedout|econnrefused|enotfound|edns|certificate/i.test(detail)) {
            throw new Error(`Mail server error (${host}:${port}): ${detail}`);
        }
        throw new Error(detail);
    }
}

async function sendTestEmail(settings, testEmail) {
    return sendMail(settings, {
        to: testEmail,
        subject: 'Test Email from POS Inflix',
        text: 'This is a test email to verify your email settings are working correctly.',
        html: '<p>This is a test email to verify your email settings are working correctly.</p>',
    });
}

async function sendWithPdfAttachment(settings, { to, subject, text, html, pdfBuffer, filename }) {
    return sendMail(settings, {
        to,
        subject,
        text,
        html,
        attachments: [
            {
                filename,
                content: pdfBuffer,
                contentType: 'application/pdf',
            },
        ],
    });
}

module.exports = {
    transportOptionsFromSettings,
    sendMail,
    sendTestEmail,
    sendWithPdfAttachment,
    getEmailSettings,
};
