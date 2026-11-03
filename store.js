/*
 * Lore Master — everything that reads or writes SillyTavern's lorebook data.
 * The views never call SillyTavern directly; they go through here.
 */

import * as WI from '../../../world-info.js';
import { entriesOf, bookStats, newEntry, ENTRY_DEFAULTS, upsertGlossaryList, glossaryLines } from './lib.js';

const LOG = '[LoreMaster]';
export const ctx = () => SillyTavern.getContext();
export const template = () => WI.newWorldInfoEntryTemplate ?? ENTRY_DEFAULTS;
export const WIref = WI;

// ---------------------------------------------------------------- book list & stats

export const bookNames = () => (Array.isArray(WI.world_names) ? [...WI.world_names] : []);
export const globalBooks = () => (Array.isArray(WI.selected_world_info) ? [...WI.selected_world_info] : []);

/** name -> { count, on, constant, tokens } ; filled lazily */
export const statCache = new Map();
let statQueue = Promise.resolve();
export function statsFor(name, onReady) {
    if (statCache.has(name)) return statCache.get(name);
    statCache.set(name, null);
    statQueue = statQueue.then(async () => {
        try {
            const data = await WI.loadWorldInfo(name);
            statCache.set(name, data ? bookStats(data) : { count: 0, on: 0, constant: 0, tokens: 0 });
        } catch { statCache.set(name, { count: 0, on: 0, constant: 0, tokens: 0, error: true }); }
        onReady?.(name);
    });
    return null;
}

// ---------------------------------------------------------------- who uses which book

export function currentChar() {
    const c = ctx();
    if (c.groupId || c.characterId === undefined || c.characterId === null || c.characterId === '') return null;
    const ch = c.characters?.[c.characterId];
    if (!ch) return null;
    return { ch, chid: c.characterId, stem: String(ch.avatar ?? '').replace(/\.[^.]+$/, '') };
}
export function charBooks(cc = currentChar()) {
    if (!cc) return { primary: '', extra: [] };
    return {
        primary: cc.ch.data?.extensions?.world ?? '',
        extra: [...(WI.world_info?.charLore?.find(e => e.name === cc.stem)?.extraBooks ?? [])],
    };
}
export function chatBook() {
    const c = ctx();
    if (!c.chatId && !c.getCurrentChatId?.()) return null;
    return c.chatMetadata?.[WI.METADATA_KEY ?? 'world_info'] ?? '';
}
export function personaBook() {
    return ctx().powerUserSettings?.persona_description_lorebook ?? '';
}

/** Where each book is used right now: name -> Set of tags (global|primary|extra|chat|persona). */
export function usage() {
    const map = new Map();
    const add = (n, tag) => { if (!n) return; if (!map.has(n)) map.set(n, new Set()); map.get(n).add(tag); };
    for (const n of globalBooks()) add(n, 'global');
    const cb = charBooks();
    add(cb.primary, 'primary');
    for (const n of cb.extra) add(n, 'extra');
    add(chatBook(), 'chat');
    add(personaBook(), 'persona');
    // group chats: every member's books
    const c = ctx();
    if (c.groupId) {
        const g = c.groups?.find(x => x.id === c.groupId);
        for (const av of g?.members ?? []) {
            const ch = c.characters?.find(x => x.avatar === av);
            if (!ch) continue;
            add(ch.data?.extensions?.world, 'primary');
            const stem = String(av).replace(/\.[^.]+$/, '');
            for (const n of WI.world_info?.charLore?.find(e => e.name === stem)?.extraBooks ?? []) add(n, 'extra');
        }
    }
    return map;
}

/** Characters whose main book is `name`. */
export function cardsUsing(name) {
    return (ctx().characters ?? []).filter(ch => ch?.data?.extensions?.world === name).map(ch => ch.name);
}

// ---------------------------------------------------------------- open book (a working copy)

/** The book being edited: { name, data, timer, saving, savedAt, error } */
export let cur = null;
const listeners = new Set();
export const onSaveState = fn => listeners.add(fn);
const emit = () => listeners.forEach(fn => { try { fn(cur); } catch (e) { console.error(e); } });

export async function openBook(name) {
    if (cur?.name === name) return cur;
    await flush();
    const data = await WI.loadWorldInfo(name);
    if (!data) throw new Error(`โหลดเล่ม “${name}” ไม่ได้`);
    data.entries ??= {};
    cur = { name, data: structuredClone(data), timer: null, saving: false, savedAt: 0, dirty: false, error: '' };
    return cur;
}
export function closeBook() { flush(); }

/** Save soon (typing), or now. */
export function touch(now = false) {
    if (!cur) return;
    cur.dirty = true;
    clearTimeout(cur.timer);
    emit();
    if (now) return flush();
    cur.timer = setTimeout(flush, 700);
}
export async function flush() {
    if (!cur || !cur.dirty) return;
    const book = cur;
    clearTimeout(book.timer);
    book.dirty = false;
    book.saving = true;
    emit();
    try {
        await WI.saveWorldInfo(book.name, structuredClone(book.data), true);
        statCache.set(book.name, bookStats(book.data));
        book.savedAt = Date.now();
        book.error = '';
        try { WI.reloadEditor?.(book.name); } catch { /* ST editor not on this book */ }
    } catch (e) {
        console.error(LOG, 'save failed', e);
        book.error = String(e?.message ?? e);
        book.dirty = true;
    } finally {
        book.saving = false;
        emit();
    }
}
/** Re-read the open book after someone else (ST's own editor, another tab) changed it. */
export async function reloadIfOpen(name) {
    if (!cur || cur.name !== name || cur.dirty || cur.saving) return false;
    const data = await WI.loadWorldInfo(name);
    if (!data) return false;
    cur.data = structuredClone(data);
    cur.data.entries ??= {};
    return true;
}

export const entryList = () => (cur ? entriesOf(cur.data) : []);
export const getEntry = uid => cur?.data.entries?.[uid] ?? null;

export function addEntry(patch = {}) {
    const e = newEntry(cur.data, template(), patch);
    cur.data.entries[e.uid] = e;
    touch(true);
    return e;
}
export function duplicateEntry(uid) {
    const src = getEntry(uid);
    if (!src) return null;
    const e = newEntry(cur.data, template(), { ...structuredClone(src), comment: `${src.comment || ''} (สำเนา)`.trim() });
    // put the copy right after the original
    const list = entriesOf(cur.data);
    const at = list.findIndex(x => x.uid === src.uid);
    list.splice(at + 1, 0, e);
    cur.data.entries[e.uid] = e;
    list.forEach((x, i) => { x.displayIndex = i; });
    touch(true);
    return e;
}
export function deleteEntries(uids) {
    for (const uid of uids) {
        delete cur.data.entries[uid];
        // keep the "original data" (embedded card book) in step, like ST does
        const od = cur.data.originalData;
        if (od?.entries && Array.isArray(od.entries)) od.entries = od.entries.filter(x => x.id !== Number(uid));
    }
    touch(true);
}
/** Move entry up/down within the book order. */
export function moveEntry(uid, delta) {
    const list = entriesOf(cur.data);
    const i = list.findIndex(x => x.uid === Number(uid));
    const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    list.forEach((x, k) => { x.displayIndex = k; });
    touch(true);
}

/** Copy (or move) entries to another book. */
export async function copyEntriesTo(target, uids, { move = false } = {}) {
    if (target === cur.name) return 0;
    await flush();
    const data = structuredClone(await WI.loadWorldInfo(target));
    if (!data) throw new Error(`โหลดเล่ม “${target}” ไม่ได้`);
    data.entries ??= {};
    let n = 0;
    for (const uid of uids) {
        const src = getEntry(uid);
        if (!src) continue;
        const e = newEntry(data, template(), { ...structuredClone(src) });
        data.entries[e.uid] = e;
        n++;
    }
    await WI.saveWorldInfo(target, data, true);
    statCache.set(target, bookStats(data));
    try { WI.reloadEditor?.(target); } catch { /* ignore */ }
    if (move) deleteEntries(uids);
    return n;
}

/** Rebuild the glossary entry of a book from its Thai keys. Returns the number of names. */
export async function updateGlossary(name) {
    const open = cur?.name === name;
    const data = open ? cur.data : structuredClone(await WI.loadWorldInfo(name));
    if (!data) throw new Error(`โหลดเล่ม “${name}” ไม่ได้`);
    const list = upsertGlossaryList(entriesOf(data), template());
    data.entries = Object.fromEntries(list.map(e => [e.uid, e]));
    if (open) await touch(true);
    else {
        await WI.saveWorldInfo(name, data, true);
        statCache.set(name, bookStats(data));
        try { WI.reloadEditor?.(name); } catch { /* ignore */ }
    }
    return glossaryLines(list).length;
}

// ---------------------------------------------------------------- books

export async function createBook(name, data = { entries: {} }) {
    name = cleanName(name);
    if (!name) throw new Error('ตั้งชื่อเล่มก่อน');
    if (bookNames().includes(name)) throw new Error(`มีเล่มชื่อ “${name}” อยู่แล้ว`);
    await WI.saveWorldInfo(name, data, true);
    await WI.updateWorldInfoList?.();
    statCache.set(name, bookStats(data));
    return name;
}
export const cleanName = s => String(s ?? '').trim().replace(/[\\/:*?"<>|]/g, '_');
export function freeName(base) {
    const names = new Set(bookNames().map(n => n.toLowerCase()));
    let n = cleanName(base), i = 2;
    while (names.has(n.toLowerCase())) n = `${cleanName(base)} (${i++})`;
    return n;
}

export async function duplicateBook(name) {
    if (cur?.name === name) await flush();
    const data = structuredClone(await WI.loadWorldInfo(name));
    return createBook(freeName(`${name} (สำเนา)`), data);
}

export async function deleteBook(name) {
    if (cur?.name === name) { clearTimeout(cur.timer); cur = null; }
    const ok = await WI.deleteWorldInfo(name);
    if (!ok) throw new Error('ลบไม่สำเร็จ');
    statCache.delete(name);
    // ST does not clean up the extra-book lists
    const lore = WI.world_info?.charLore;
    if (Array.isArray(lore)) {
        for (let i = lore.length - 1; i >= 0; i--) {
            lore[i].extraBooks = (lore[i].extraBooks ?? []).filter(b => b !== name);
            if (!lore[i].extraBooks.length) lore.splice(i, 1);
        }
    }
    if (chatBook() === name) await setChatBook('');
    ctx().saveSettingsDebounced();
}

/** Rename and re-point every link to it (global, extra books, chat, persona, main book of cards). */
export async function renameBook(oldName, newName) {
    newName = cleanName(newName);
    if (!newName || newName === oldName) return oldName;
    if (bookNames().some(n => n.toLowerCase() === newName.toLowerCase())) throw new Error(`มีเล่มชื่อ “${newName}” อยู่แล้ว`);
    if (cur?.name === oldName) await flush();
    const data = structuredClone(await WI.loadWorldInfo(oldName));
    const wasGlobal = globalBooks().includes(oldName);
    const wasChat = chatBook() === oldName;
    const c = ctx();
    const pu = c.powerUserSettings;
    const wasPersona = pu?.persona_description_lorebook === oldName;
    const cards = (c.characters ?? []).map((ch, chid) => ({ ch, chid })).filter(x => x.ch?.data?.extensions?.world === oldName);

    await WI.saveWorldInfo(newName, data, true);
    await WI.updateWorldInfoList?.();
    await WI.deleteWorldInfo(oldName);
    statCache.delete(oldName);
    statCache.set(newName, bookStats(data));

    for (const e of WI.world_info?.charLore ?? []) e.extraBooks = (e.extraBooks ?? []).map(b => (b === oldName ? newName : b));
    if (wasGlobal) setGlobal(newName, true);
    if (wasChat) await setChatBook(newName);
    if (wasPersona && pu) {
        pu.persona_description_lorebook = newName;
        const d = pu.persona_descriptions?.[c.userAvatarId ?? globalThis.user_avatar];
        if (d) d.lorebook = newName;
    }
    for (const d of Object.values(pu?.persona_descriptions ?? {})) if (d?.lorebook === oldName) d.lorebook = newName;
    const cc = currentChar();
    for (const { ch, chid } of cards) {
        if (cc && String(cc.chid) === String(chid)) { await WI.charUpdatePrimaryWorld(newName); continue; }
        await mergeCard(ch, { data: { extensions: { world: newName } } });
    }
    c.saveSettingsDebounced();
    if (cur?.name === oldName) cur.name = newName;
    return newName;
}

async function mergeCard(ch, patch) {
    const res = await fetch('/api/characters/merge-attributes', {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({ avatar: ch.avatar, ...patch }),
    });
    if (!res.ok) throw new Error(`แก้การ์ด ${ch.name} ไม่สำเร็จ (${res.status})`);
    ch.data ??= {}; ch.data.extensions ??= {};
    ch.data.extensions.world = patch.data.extensions.world;
}

// ---------------------------------------------------------------- links

export function setGlobal(name, on) {
    const isOn = globalBooks().includes(name);
    if (on === isOn) return;
    WI.onWorldInfoChange({ state: on ? 'on' : 'off', silent: 'true' }, name);
}

export async function setPrimary(name) {
    const cc = currentChar();
    if (!cc) throw new Error('เปิดแชทกับตัวละครก่อน');
    const b = charBooks(cc);
    if (name && b.extra.includes(name)) setExtras(cc, b.extra.filter(x => x !== name));
    await WI.charUpdatePrimaryWorld(name);
}
export function setExtras(cc, list) {
    if (WI.charSetAuxWorlds) WI.charSetAuxWorlds(cc.stem, [...new Set(list)]);
    else {
        WI.world_info.charLore ??= [];
        const lore = WI.world_info.charLore;
        const i = lore.findIndex(x => x.name === cc.stem);
        if (!list.length) { if (i >= 0) lore.splice(i, 1); } else if (i >= 0) lore[i].extraBooks = [...new Set(list)]; else lore.push({ name: cc.stem, extraBooks: [...new Set(list)] });
        ctx().saveSettingsDebounced();
    }
}
export function setExtra(name, on) {
    const cc = currentChar();
    if (!cc) throw new Error('เปิดแชทกับตัวละครก่อน');
    const b = charBooks(cc);
    const list = b.extra.filter(x => x !== name);
    if (on) list.push(name);
    setExtras(cc, list);
}
export async function setChatBook(name) {
    const c = ctx();
    const key = WI.METADATA_KEY ?? 'world_info';
    if (name) c.chatMetadata[key] = name; else delete c.chatMetadata[key];
    document.querySelectorAll('.chat_lorebook_button').forEach(el => el.classList.toggle('world_set', !!name));
    await c.saveMetadata?.();
}

// ---------------------------------------------------------------- ST global World Info settings

/** ST keeps these in its own inputs; setting the input runs ST's own handler, which saves. */
export const GLOBAL_SETTINGS = [
    { id: 'world_info_depth', type: 'range', min: 0, max: 1000, label: 'สแกนย้อนหลังกี่ข้อความ (Scan Depth)', help: 'ดูคีย์ในข้อความล่าสุดกี่ข้อความ ปกติ 2–4 ยิ่งมากยิ่งติดเยอะ' },
    { id: 'world_info_budget', type: 'range', min: 1, max: 100, unit: '%', label: 'งบโทเคน (% ของ context)', help: 'lore ทั้งหมดรวมกันใช้ได้ไม่เกินกี่ % ของ context เกินแล้วตัวที่สำคัญน้อยกว่าจะไม่ถูกใส่' },
    { id: 'world_info_budget_cap', type: 'range', min: 0, max: 65536, label: 'เพดานงบ (โทเคน)', help: 'จำกัดเป็นจำนวนโทเคนตรง ๆ 0 = ไม่จำกัด (ใช้แค่ % ด้านบน) กันระเบิดได้ดี เช่นตั้ง 2000' },
    { id: 'world_info_min_activations', type: 'range', min: 0, max: 100, label: 'ติดอย่างน้อยกี่เอนทรี', help: 'ถ้าติดไม่ถึงจำนวนนี้ จะสแกนย้อนหลังลึกขึ้นเรื่อย ๆ 0 = ปิด (ใช้พร้อมกับจำกัดรอบลูกโซ่ไม่ได้)' },
    { id: 'world_info_min_activations_depth_max', type: 'range', min: 0, max: 100, label: 'สแกนลึกสุดตอนหาให้ครบ', help: 'ใช้คู่กับข้อบน 0 = ไม่จำกัด' },
    { id: 'world_info_max_recursion_steps', type: 'range', min: 0, max: 10, label: 'ลูกโซ่ได้กี่ทอด (Max Recursion Steps)', help: 'จำกัดจำนวนรอบของ recursion 0 = ไม่จำกัด ตั้ง 1–2 กันลากกันเป็นพวงได้' },
    { id: 'world_info_recursive', type: 'check', label: 'เปิด recursion (ลูกโซ่)', help: 'เนื้อหาของเอนทรีที่ติดแล้วจะถูกสแกนหาคีย์ของเอนทรีอื่นต่อ' },
    { id: 'world_info_include_names', type: 'check', label: 'สแกนชื่อคนพูดด้วย', help: 'นับชื่อหน้าข้อความ (เช่น “Cody:”) ด้วย คีย์ที่เป็นชื่อตัวละครหลักจะติดทุกเทิร์น' },
    { id: 'world_info_case_sensitive', type: 'check', label: 'แยกตัวพิมพ์เล็ก/ใหญ่', help: 'ค่าเริ่มต้นของทุกเอนทรี เอนทรีตั้งเองทับได้' },
    { id: 'world_info_match_whole_words', type: 'check', label: 'จับทั้งคำ (Match Whole Words)', help: 'คีย์ภาษาอังกฤษต้องเป็นคำทั้งคำ เช่น park ไม่ติดใน parked ภาษาไทยไม่มีผลเพราะไม่เว้นวรรค' },
    { id: 'world_info_use_group_scoring', type: 'check', label: 'ให้คะแนนในกลุ่ม (Group Scoring)', help: 'ในกลุ่มเดียวกัน เลือกตัวที่เจอคีย์มากสุด แทนการสุ่ม' },
    { id: 'world_info_overflow_alert', type: 'check', label: 'เตือนเมื่องบเต็ม', help: 'ขึ้นแจ้งเตือนเมื่อ lore ถูกตัดเพราะงบโทเคนไม่พอ' },
    { id: 'world_info_character_strategy', type: 'select', label: 'ลำดับระหว่างเล่ม', help: 'เล่ม Global กับเล่มของตัวละคร ใครได้ก่อนเมื่องบจำกัด', options: [[0, 'เรียงตาม order รวมกัน'], [1, 'ตัวละครก่อน'], [2, 'Global ก่อน']] },
];
export function readGlobal(def) {
    const el = document.getElementById(def.id);
    if (!el) return null;
    return def.type === 'check' ? el.checked : Number(el.value);
}
export function writeGlobal(def, value) {
    const el = document.getElementById(def.id);
    if (!el) return false;
    if (def.type === 'check') el.checked = !!value; else el.value = String(value);
    // ST listens with jQuery on input/change
    const ev = def.type === 'select' || def.id === 'world_info_overflow_alert' || def.id === 'world_info_use_group_scoring' ? 'change' : 'input';
    if (globalThis.jQuery) globalThis.jQuery(el).trigger(ev); else el.dispatchEvent(new Event(ev, { bubbles: true }));
    return true;
}

// ---------------------------------------------------------------- tokens

export async function countTokens(text) {
    try { return await ctx().getTokenCountAsync(String(text ?? '')); } catch { return null; }
}

export function chatSample() {
    const c = ctx();
    const depth = Math.max(2, Number(WI.world_info_depth) || 2);
    return (c.chat ?? []).filter(m => !m.is_system && m.mes).slice(-depth).map(m => `${m.name}: ${m.mes}`).join('\n');
}

export { entriesOf };
