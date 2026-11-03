/*
 * Lore Master — backups kept in this browser (IndexedDB): whole books before they are
 * overwritten, and entry contents before an AI rewrite.
 */

const DB = { name: 'LoreMaster', store: 'backups', keep: 10 };
function idb() {
    return new Promise((res, rej) => {
        const r = indexedDB.open(DB.name, 1);
        r.onupgradeneeded = () => r.result.createObjectStore(DB.store, { keyPath: 'id', autoIncrement: true }).createIndex('book', 'book');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
    });
}
export async function backupPut(book, data) {
    const db = await idb();
    await new Promise((res, rej) => {
        const tx = db.transaction(DB.store, 'readwrite');
        tx.objectStore(DB.store).add({ book, at: Date.now(), data: structuredClone(data) });
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
    const list = await backupList(book);
    if (list.length > DB.keep) {
        const tx = db.transaction(DB.store, 'readwrite');
        for (const b of list.slice(DB.keep)) tx.objectStore(DB.store).delete(b.id);
    }
}
export async function backupList(book) {
    const db = await idb();
    return new Promise((res, rej) => {
        const req = db.transaction(DB.store).objectStore(DB.store).index('book').getAll(book);
        req.onsuccess = () => res(req.result.sort((a, b) => b.at - a.at));
        req.onerror = () => rej(req.error);
    });
}

