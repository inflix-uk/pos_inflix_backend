/**
 * Baileys auth state stored in the tenant database (models/WhatsappAuth) — the same shape
 * as Baileys' useMultiFileAuthState, but it survives redeploys. Socket callbacks run outside
 * any request, so every read/write enters the tenant explicitly via runInTenant.
 */
const runInTenant = require('../lib/runInTenant');
const WhatsappAuth = require('../models/WhatsappAuth');

const CREDS_ID = 'creds';
const keyId = (type, id) => `${type}:${id}`;

/** Load (or start) a tenant's pairing. `baileys` is the loaded Baileys module. */
async function useMongoAuthState(tenantKey, baileys) {
    const { initAuthCreds, BufferJSON, proto } = baileys;
    const encode = (value) => JSON.stringify(value, BufferJSON.replacer);
    const decode = (text) => JSON.parse(text, BufferJSON.reviver);
    const inTenant = (fn) => runInTenant(tenantKey, fn);

    const saved = await inTenant(() => WhatsappAuth.findById(CREDS_ID).lean());
    const creds = saved ? decode(saved.value) : initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    if (!ids || ids.length === 0) return data;
                    const docs = await inTenant(() =>
                        WhatsappAuth.find({ _id: { $in: ids.map((id) => keyId(type, id)) } }).lean()
                    );
                    const byId = new Map(docs.map((d) => [d._id, d.value]));
                    for (const id of ids) {
                        const text = byId.get(keyId(type, id));
                        let value = text ? decode(text) : null;
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }
                    return data;
                },
                set: async (data) => {
                    const ops = [];
                    for (const type of Object.keys(data)) {
                        for (const id of Object.keys(data[type] || {})) {
                            const value = data[type][id];
                            const _id = keyId(type, id);
                            ops.push(value
                                ? { updateOne: { filter: { _id }, update: { $set: { value: encode(value) } }, upsert: true } }
                                : { deleteOne: { filter: { _id } } });
                        }
                    }
                    if (ops.length) await inTenant(() => WhatsappAuth.bulkWrite(ops, { ordered: false }));
                },
            },
        },
        saveCreds: () => inTenant(() =>
            WhatsappAuth.updateOne({ _id: CREDS_ID }, { $set: { value: encode(creds) } }, { upsert: true })
        ),
    };
}

/**
 * Whether the tenant has a completed pairing. Baileys logs in with saved creds when
 * `creds.me` is set and otherwise starts a new QR registration.
 */
async function hasPairedCreds(tenantKey) {
    const saved = await runInTenant(tenantKey, () => WhatsappAuth.findById(CREDS_ID).lean());
    if (!saved) return false;
    try {
        const creds = JSON.parse(saved.value);
        return !!(creds && creds.me && creds.me.id);
    } catch {
        return false;
    }
}

/** Remove the tenant's pairing (logged out, device removed, or a pair that never finished). */
async function clearAuth(tenantKey) {
    await runInTenant(tenantKey, () => WhatsappAuth.deleteMany({}));
}

module.exports = { useMongoAuthState, hasPairedCreds, clearAuth };
