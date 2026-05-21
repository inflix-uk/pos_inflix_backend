/**
 * ESC/POS raster graphics for thermal receipts (QR as bitmap; logo disabled in print controller).
 */
const sharp = require('sharp');
const QRCode = require('qrcode');

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

function cmd(...bytes) {
    return Buffer.from(bytes);
}

function parseDataUrl(dataUrl) {
    if (!dataUrl || typeof dataUrl !== 'string') return null;
    const m = /^data:image\/[\w+.-]+;base64,(.+)$/i.exec(dataUrl.trim());
    if (!m) return null;
    try {
        return Buffer.from(m[1], 'base64');
    } catch (_) {
        return null;
    }
}

/** Pack 1-bit raster for GS v 0 (width in pixels, height in pixels, 0=black). */
function packRasterGsV0(pixels, widthPx, heightPx) {
    const bytesPerRow = Math.ceil(widthPx / 8);
    const raster = Buffer.alloc(bytesPerRow * heightPx);
    for (let y = 0; y < heightPx; y++) {
        for (let x = 0; x < widthPx; x++) {
            const v = pixels[y * widthPx + x];
            if (v < 128) {
                raster[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
            }
        }
    }
    const xL = bytesPerRow & 0xff;
    const xH = (bytesPerRow >> 8) & 0xff;
    const yL = heightPx & 0xff;
    const yH = (heightPx >> 8) & 0xff;
    return Buffer.concat([cmd(GS, 0x76, 0x30, 0x00, xL, xH, yL, yH), raster]);
}

/**
 * Convert About logo (data URL) to centered raster ESC/POS block.
 * @param {string} dataUrl
 * @param {number} paperWidthMm
 * @returns {Promise<Buffer|null>}
 */
async function logoDataUrlToEscposRaster(dataUrl, paperWidthMm = 80) {
    const input = parseDataUrl(dataUrl);
    if (!input) return null;
    const mm = Number(paperWidthMm) || 80;
    const printableMm = mm <= 58 ? 48 : 72;
    const maxWidthDots = Math.max(120, Math.round((Math.min(22, printableMm * 0.55) / 25.4) * 203));
    const maxHeightDots = Math.max(48, Math.round((16 / 25.4) * 203));
    try {
        const pipeline = sharp(input).rotate().flatten({ background: '#ffffff' }).greyscale();
        const meta = await pipeline.metadata();
        if (!meta.width || !meta.height) return null;
        const scale = Math.min(1, maxWidthDots / meta.width, maxHeightDots / meta.height);
        const w = Math.max(1, Math.floor(meta.width * scale));
        const h = Math.max(1, Math.floor(meta.height * scale));
        const { data, info } = await pipeline
            .resize(w, h, { fit: 'inside', withoutEnlargement: true })
            .threshold(160)
            .raw()
            .toBuffer({ resolveWithObject: true });
        const raster = packRasterGsV0(data, info.width, info.height);
        return Buffer.concat([cmd(ESC, 0x61, 1), raster, cmd(LF), cmd(ESC, 0x61, 0)]);
    } catch (e) {
        console.warn('[escposGraphics] logo raster failed:', e.message);
        return null;
    }
}

/**
 * QR as GS v 0 raster (works on printers that garble native GS ( k commands).
 * @param {string} text
 * @param {number} qrSizeMm
 * @returns {Promise<Buffer|null>}
 */
async function qrTextToEscposRaster(text, qrSizeMm = 22) {
    const payload = String(text || '').trim();
    if (!payload) return null;
    const mm = Number(qrSizeMm) || 22;
    const dots = Math.min(280, Math.max(120, Math.round((mm / 25.4) * 203)));
    try {
        const png = await QRCode.toBuffer(payload, {
            type: 'png',
            width: dots,
            margin: 1,
            errorCorrectionLevel: 'M'
        });
        const { data, info } = await sharp(png).greyscale().threshold(128).raw().toBuffer({ resolveWithObject: true });
        const raster = packRasterGsV0(data, info.width, info.height);
        return Buffer.concat([cmd(ESC, 0x61, 1), raster, cmd(LF, LF), cmd(ESC, 0x61, 0)]);
    } catch (e) {
        console.warn('[escposGraphics] QR raster failed:', e.message);
        return null;
    }
}

module.exports = {
    logoDataUrlToEscposRaster,
    qrTextToEscposRaster,
    parseDataUrl,
    packRasterGsV0
};
