/*
 * Lore Master — remembers the Thai spellings the AI gave for each name (IndexedDB, this
 * browser), so a name is never asked twice: not when asking again, not for another book of
 * the same bot, not from the entry editor.
 */

const DB = { name: 'LoreMasterCache', store: 'names' };
let mem = null; // Map lower-case name -> record

function open() {
    return new Promise((res, rej) => {
        const r = indexedDB.open(DB.name, 1);
        r.onupgradeneeded = () => r.result.createObjectStore(DB.store, { keyPath: 'name' });
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
    });
}

/** All remembered names (loaded once). */
export async function nameCache() {
    if (mem) return mem;
    mem = new Map();
    try {
        const db = await open();
        const rows = await new Promise((res, rej) => {
            const q = db.transaction(DB.store).objectStore(DB.store).getAll();
            q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
        });
        for (const r of rows) mem.set(r.name, r.rec);
    } catch { /* private mode etc.: works without memory */ }
    return mem;
}

/** Remember answers: Map lower-case name -> record. Nicknames are entry-specific, not kept. */
export async function rememberNames(results) {
    const m = await nameCache();
    const rows = [];
    for (const [name, rec] of results) {
        const keep = { lang: rec.lang, translit: rec.translit, english: rec.english, translated: rec.translated, nick: [] };
        m.set(name, keep);
        rows.push({ name, rec: keep, at: Date.now() });
    }
    try {
        const db = await open();
        await new Promise((res, rej) => {
            const tx = db.transaction(DB.store, 'readwrite');
            for (const r of rows) tx.objectStore(DB.store).put(r);
            tx.oncomplete = res; tx.onerror = () => rej(tx.error);
        });
    } catch { /* memory only */ }
}

/** Forget everything (settings button). */
export async function clearNameCache() {
    mem = new Map();
    try {
        const db = await open();
        await new Promise((res, rej) => { const tx = db.transaction(DB.store, 'readwrite'); tx.objectStore(DB.store).clear(); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    } catch { /* ignore */ }
}
