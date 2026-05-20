/**
 * ESC/POS bitmap logo (GS v 0) and native QR (GS ( k) for thermal receipts.
 */
const sharp = require('sharp');

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
 * Epson/Star-style QR (model 2) — encodes sale reference or id string.
 * @param {string} text
 * @param {number} qrSizeMm — from receiptReferenceQrSizeMm (14–30)
 * @returns {Buffer|null}
 */
function escposQrCodeCommand(text, qrSizeMm = 22) {
    const payload = String(text || '').trim();
    if (!payload) return null;
    const data = Buffer.from(payload, 'utf8');
    const moduleSize = qrSizeMm >= 26 ? 8 : qrSizeMm >= 22 ? 6 : qrSizeMm >= 18 ? 5 : 4;
    const storeLen = data.length + 3;
    const store = Buffer.concat([
        cmd(GS, 0x28, 0x6b, storeLen & 0xff, (storeLen >> 8) & 0xff, 0x31, 0x50, moduleSize, 0x31),
        data
    ]);
    const print = cmd(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30);
    return Buffer.concat([cmd(ESC, 0x61, 1), store, print, cmd(LF, LF), cmd(ESC, 0x61, 0)]);
}

module.exports = {
    logoDataUrlToEscposRaster,
    escposQrCodeCommand,
    parseDataUrl,
    packRasterGsV0
};
