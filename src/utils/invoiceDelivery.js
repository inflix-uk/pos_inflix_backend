/**
 * Emailing / WhatsApp-ing an invoice PDF, shared by Invoice documents and Sales.
 *
 * The PDF is rendered by the client (same file as Print / Download) and posted as base64, so a
 * document only needs { _id, reference, customerName, total } here.
 */
const EmailSettings = require('../models/EmailSettings');
const emailService = require('../lib/emailService');
const whatsappSession = require('../services/whatsappSessionService');
const whatsappQueue = require('../services/whatsappQueueService');
const whatsappWorker = require('../services/whatsappQueueWorker');
const { getTenantIdFromReq } = require('../middleware/auth');

const formatTotal = (n) =>
    new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(Number(n) || 0);

/** base64 → PDF buffer, or null when it isn't a usable PDF. */
function decodePdf(pdfBase64, { requireHeader = false } = {}) {
    let buffer;
    try {
        buffer = Buffer.from(String(pdfBase64), 'base64');
    } catch {
        return null;
    }
    if (buffer.length < 100) return null;
    if (requireHeader && buffer.subarray(0, 5).toString('latin1') !== '%PDF-') return null;
    return buffer;
}

/** Email the PDF. Responds on `res`; `doc` is an Invoice or Sale. */
async function sendPdfByEmail(req, res, doc) {
    const { to, pdfBase64, filename } = req.body || {};
    const toTrim = String(to || '').trim();
    if (!toTrim) {
        return res.status(400).json({ success: false, message: 'Recipient email is required' });
    }
    if (!/^\S+@\S+\.\S+$/.test(toTrim)) {
        return res.status(400).json({ success: false, message: 'Invalid email address' });
    }
    if (!pdfBase64) {
        return res.status(400).json({ success: false, message: 'PDF attachment is required' });
    }

    const settings = await EmailSettings.getSettings();
    if (!settings || !settings.smtpHost) {
        return res.status(503).json({
            success: false,
            message: 'Email is not configured. Go to Settings → Email and save your SMTP settings.',
        });
    }

    const pdfBuffer = decodePdf(pdfBase64);
    if (!pdfBuffer) {
        return res.status(400).json({ success: false, message: 'PDF attachment is empty or invalid' });
    }

    const ref = doc.reference || 'invoice';
    const customer = doc.customerName || 'Customer';
    const safeFilename = String(filename || `invoice-${ref}.pdf`).replace(/[/\\]/g, '_');

    try {
        await emailService.sendWithPdfAttachment(settings, {
            to: toTrim,
            subject: `Invoice ${ref} — ${customer}`,
            text: `Please find attached invoice ${ref} for ${customer}.`,
            html: `<p>Please find attached invoice <strong>${ref}</strong> for <strong>${customer}</strong>.</p>`,
            pdfBuffer,
            filename: safeFilename,
        });
    } catch (err) {
        return res.status(502).json({ success: false, message: err.message || 'Failed to send email' });
    }

    return res.status(200).json({ success: true, message: `Invoice emailed to ${toTrim}` });
}

/**
 * Queue the PDF for delivery from the tenant's connected WhatsApp. Sending is paced by the
 * WhatsApp safety limits, so a successful response is 202 (queued, not yet sent).
 */
async function queuePdfForWhatsapp(req, res, doc) {
    const tenantId = getTenantIdFromReq(req);
    if (!whatsappSession.isConnected(tenantId)) {
        return res.status(409).json({
            success: false,
            code: 'WA_NOT_CONNECTED',
            message: 'WhatsApp is not connected. Go to Settings → WhatsApp and scan the QR code.',
        });
    }

    const { phone, pdfBase64, filename, message } = req.body || {};
    if (!pdfBase64) {
        return res.status(400).json({ success: false, message: 'PDF attachment is required' });
    }
    const pdfBuffer = decodePdf(pdfBase64, { requireHeader: true });
    if (!pdfBuffer) {
        return res.status(400).json({ success: false, message: 'PDF attachment is empty or invalid' });
    }

    const ref = doc.reference || 'invoice';
    const customer = doc.customerName || 'Customer';
    const safeFilename = String(filename || `invoice-${ref}.pdf`).replace(/[/\\]/g, '_').slice(0, 255);
    const caption = String(message || '').trim()
        || `Invoice ${ref} for ${customer}. Total: ${formatTotal(doc.total)}.`;

    try {
        const out = await whatsappQueue.enqueueMessage({
            phone,
            recipientName: customer,
            text: caption,
            attachment: { filename: safeFilename, mimetype: 'application/pdf', data: pdfBuffer },
            source: 'invoice',
            sourceRef: { invoiceId: doc._id, reference: doc.reference },
            dedupeKey: whatsappQueue.invoiceDedupeKey(doc._id),
            createdByUserId: req.user && req.user._id,
        });
        whatsappWorker.kick(tenantId);
        return res.status(202).json({
            success: true,
            message: `Invoice ${ref} queued for WhatsApp to +${out.message.recipientPhone}`,
            data: out,
        });
    } catch (e) {
        if (e instanceof whatsappQueue.WhatsappQueueError) {
            return res.status(e.status).json({ success: false, code: e.code, message: e.message });
        }
        throw e;
    }
}

module.exports = { sendPdfByEmail, queuePdfForWhatsapp };
