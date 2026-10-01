/**
 * Baileys (the WhatsApp Web client) is an ES module, so this CommonJS app loads it with
 * import() — once, shared by every caller. Rejects with code WA_DEP_MISSING if it can't load.
 */
let baileysPromise = null;

function loadBaileys() {
    if (!baileysPromise) {
        baileysPromise = import('@whiskeysockets/baileys').catch((e) => {
            baileysPromise = null;
            const err = new Error(
                `WhatsApp gateway dependency could not be loaded (${e.message}). `
                + 'Run `npm install` in pos_inflix_backend (Node.js 20+ is required).'
            );
            err.code = 'WA_DEP_MISSING';
            throw err;
        });
    }
    return baileysPromise;
}

module.exports = loadBaileys;
