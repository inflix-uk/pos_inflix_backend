const { escposQrCodeCommand, packRasterGsV0 } = require('../src/utils/escposGraphics');

describe('escposGraphics', () => {
    it('builds native QR store+print commands', () => {
        const buf = escposQrCodeCommand('INV-000553', 22);
        expect(buf).toBeTruthy();
        expect(buf.indexOf(Buffer.from([0x1d, 0x28, 0x6b]))).toBeGreaterThanOrEqual(0);
        expect(buf.toString('utf8')).toContain('INV-000553');
    });

    it('packRasterGsV0 produces GS v 0 header', () => {
        const pixels = Buffer.alloc(8, 0);
        const raster = packRasterGsV0(pixels, 8, 1);
        expect(raster[0]).toBe(0x1d);
        expect(raster[1]).toBe(0x76);
    });
});
