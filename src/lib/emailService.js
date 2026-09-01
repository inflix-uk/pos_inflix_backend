const nodemailer = require('nodemailer');
const EmailSettings = require('../models/EmailSettings');

function formatSmtpError(err, settings) {
    const host = settings?.smtpHost || 'smtp';
    const port = Number(settings?.smtpPort) || 587;
    const parts = [];
    if (err?.code) parts.push(String(err.code));
    if (err?.response) parts.push(String(err.response).trim());
    const detail = parts.join(' — ') || (err?.message ? String(err.message) : 'Failed to send email');
    if (/timeout|etimedout/i.test(detail)) {
        return `Mail server timed out (${host}:${port}). Check host/port, encryption (SSL on 465, TLS on 587), and that outbound SMTP is allowed from your server.`;
    }
    if (/econnrefused|enotfound|edns|getaddrinfo/i.test(detail)) {
        return `Cannot reach mail server (${host}:${port}): ${detail}`;
    }
    if (/certificate|self signed|unable to verify/i.test(detail)) {
        return `TLS certificate error (${host}:${port}): ${detail}. Try port 587 with TLS, or ask your host to fix the mail certificate.`;
    }
    if (/auth|invalid login|535|534/i.test(detail)) {
        return `SMTP login failed for ${settings?.smtpUsername || 'user'}@${host}: ${detail}. Check username and password (use an app password if required).`;
    }
    return `Mail server error (${host}:${port}): ${detail}`;
}

function normalizeSmtpSecure(port, mode) {
    const p = Number(port) || 587;
    const m = String(mode || 'tls').toLowerCase();
    // cPanel-style mail: 465 = implicit SSL, 587 = STARTTLS (TLS).
    if (p === 465) return 'ssl';
    if (p === 587 || p === 2525) return m === 'ssl' ? 'tls' : (m === 'none' ? 'tls' : m);
    return m;
}

function transportOptionsFromSettings(settings, { fastFail = false } = {}) {
    const port = Number(settings.smtpPort) || 587;
    const mode = normalizeSmtpSecure(port, settings.smtpSecure || 'tls');
    // Port 465 uses implicit TLS (SSL). Port 587 uses STARTTLS (secure: false + requireTLS).
    const secure = mode === 'ssl';
    const host = String(settings.smtpHost || '').trim();
    const rejectUnauthorized = process.env.SMTP_TLS_REJECT_UNAUTHORIZED !== '0';
    const opts = {
        host,
        port,
        secure,
        auth: {
            user: settings.smtpUsername,
            pass: settings.smtpPassword,
        },
        connectionTimeout: fastFail ? 10000 : 20000,
        greetingTimeout: fastFail ? 10000 : 20000,
        socketTimeout: fastFail ? 15000 : 60000,
        tls: {
            servername: host,
            minVersion: 'TLSv1.2',
            rejectUnauthorized,
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
        throw new Error(formatSmtpError(err, settings));
    }
}

async function sendTestEmail(settings, testEmail) {
    if (!settings?.smtpHost || !settings?.smtpUsername || !settings?.fromEmail) {
        throw new Error('Email is not configured. Go to Settings → Email and save your SMTP settings.');
    }
    const transporter = nodemailer.createTransport(
        transportOptionsFromSettings(settings, { fastFail: true })
    );
    const mailOptions = {
        from: formatFrom(settings),
        to: testEmail,
        subject: 'Test Email from POS Inflix',
        text: 'This is a test email to verify your email settings are working correctly.',
        html: '<p>This is a test email to verify your email settings are working correctly.</p>',
    };
    const replyTo = formatReplyTo(settings);
    if (replyTo) {
        mailOptions.replyTo = replyTo;
    }
    try {
        return await transporter.sendMail(mailOptions);
    } catch (err) {
        throw new Error(formatSmtpError(err, settings));
    }
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
    normalizeSmtpSecure,
    transportOptionsFromSettings,
    sendMail,
    sendTestEmail,
    sendWithPdfAttachment,
    getEmailSettings,
};
