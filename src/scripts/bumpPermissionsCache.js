/**
 * One-off helper: invalidate the cached admin:permissions list in Redis.
 * Use when a new permission has been seeded but the running backend still
 * serves the stale catalog from cache.
 */

require('dotenv').config();

async function main() {
    const REDIS_URL = process.env.REDIS_URL;
    if (!REDIS_URL) {
        console.log('No REDIS_URL — nothing to do (in-memory cache is cleared on backend restart).');
        return;
    }
    const Redis = require('ioredis');
    const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });

    let cursor = '0';
    let bumped = 0;
    do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', 'pos:ver:admin:permissions:*', 'COUNT', 100);
        cursor = next;
        for (const key of keys) {
            await redis.incr(key);
            bumped++;
            console.log('bumped:', key);
        }
    } while (cursor !== '0');

    console.log(`Done. Bumped ${bumped} permissions-cache version key(s).`);
    await redis.quit();
}

main().catch((err) => { console.error(err); process.exit(1); });
