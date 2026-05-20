const { qrTextToEscposRaster, packRasterGsV0 } = require('../src/utils/escposGraphics');

describe('escposGraphics', () => {
    it('packRasterGsV0 produces GS v 0 header', () => {
        const pixels = Buffer.alloc(8, 0);
        const raster = packRasterGsV0(pixels, 8, 1);
        expect(raster[0]).toBe(0x1d);
        expect(raster[1]).toBe(0x76);
    });

    it('builds raster QR block (GS v 0, not native GS ( k)', async () => {
        const buf = await qrTextToEscposRaster('INV-000559', 22);
        expect(buf).toBeTruthy();
        expect(buf.indexOf(Buffer.from([0x1d, 0x76, 0x30]))).toBeGreaterThanOrEqual(0);
        expect(buf.toString('utf8')).not.toContain('k1P1');
    });
});
