/*
 * Lore Master — SillyTavern extension
 *
 * v0.1: import lorebooks made for other sites (JanitorAI first), merge several books
 * into one, find what makes them misfire in SillyTavern (recursion chains, keys that
 * are everywhere, generic words, clashing names, duplicates…), fix it with a tap,
 * test the result on real text, then save — optionally as the card's own lorebook
 * so the card carries it when shared.
 *
 * Pure logic lives in lib.js; this file is the SillyTavern glue and the UI.
 */

import * as WI from '../../../world-info.js';
import {
    escapeHtml, readLorebook, mergeBooks, diagnose, applyChanges, simulate, summarize, toWorld,
    estTokens, overCap, detectFormat, FORMAT_LABEL, POSITION, THAI,
} from './lib.js';

const MODULE = 'lore-master';
const LOG = '[LoreMaster]';
const VERSION = '0.1.0';
const ctx = () => SillyTavern.getContext();
const toast = globalThis.toastr ?? { success: console.log, info: console.log, warning: console.warn, error: console.error };

const DEFAULTS = {
    interceptImport: true,
    /** @type {Record<string, number>} book -> max entries per turn */
    caps: {},
    defaultCap: 10,
    position: POSITION.before,
};

function settings() {
    const all = ctx().extensionSettings;
    all[MODULE] = Object.assign({}, structuredClone(DEFAULTS), all[MODULE] ?? {});
    if (!all[MODULE].caps || typeof all[MODULE].caps !== 'object') all[MODULE].caps = {};
    return all[MODULE];
}
const save = () => ctx().saveSettingsDebounced();
const template = () => WI.newWorldInfoEntryTemplate ?? undefined;

// ---------------------------------------------------------------- Thai word check (same idea as Lore Lens)

let thaiSeg = null;
try { thaiSeg = new Intl.Segmenter('th', { granularity: 'word' }); } catch { thaiSeg = null; }
function isThaiDictWord(s) {
    if (!thaiSeg || !THAI.test(s)) return false;
    const segs = [...thaiSeg.segment(s)].filter(x => x.isWordLike);
    return segs.length === 1 && segs[0].segment === s;
}

// ---------------------------------------------------------------- backups (IndexedDB, this browser only)

const DB = { name: 'LoreMaster', store: 'backups', keep: 10 };
function idb() {
    return new Promise((res, rej) => {
        const r = indexedDB.open(DB.name, 1);
        r.onupgradeneeded = () => r.result.createObjectStore(DB.store, { keyPath: 'id', autoIncrement: true }).createIndex('book', 'book');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
    });
}
async function backupPut(book, data) {
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
async function backupList(book) {
    const db = await idb();
    return new Promise((res, rej) => {
        const req = db.transaction(DB.store).objectStore(DB.store).index('book').getAll(book);
        req.onsuccess = () => res(req.result.sort((a, b) => b.at - a.at));
        req.onerror = () => rej(req.error);
    });
}

// ---------------------------------------------------------------- state

const S = {
    open: false,
    tab: 'src',
    /** @type {{id:number, name:string, format:string, raw:any, book?:string, entries:any[]}[]} */
    sources: [],
    base: [],       // merged, before any fix
    work: [],       // current
    history: [],    // previous `work`s for undo
    applied: [],    // titles of applied fixes
    issues: [],
    expanded: new Set(),
    picker: false,
    pickerQuery: '',
    simText: '',
    simRecursive: null,
    saveName: '',
    saveMode: 'new',
    prefixSource: true,
    linkChar: true,
    unlinkOld: true,
    capOn: true,
    capN: 10,
    saved: null,    // { name, linked }
    busy: false,
};
let nextSourceId = 1;

function currentChar() {
    const c = ctx();
    if (c.groupId || c.characterId === undefined || c.characterId === null) return null;
    const ch = c.characters?.[c.characterId];
    return ch ? { ch, chid: c.characterId, stem: String(ch.avatar ?? '').replace(/\.[^.]+$/, '') } : null;
}
function charBooks(cc) {
    if (!cc) return { primary: '', extra: [] };
    const primary = cc.ch.data?.extensions?.world ?? '';
    const extra = WI.world_info?.charLore?.find(e => e.name === cc.stem)?.extraBooks ?? [];
    return { primary, extra: [...extra] };
}
function scanOpts() {
    const c = ctx();
    return {
        names: { char: c.name2 ?? '', user: c.name1 ?? '' },
        recursive: S.simRecursive ?? !!WI.world_info_recursive,
        wholeWords: !!WI.world_info_match_whole_words,
        caseSensitive: !!WI.world_info_case_sensitive,
        isThaiDictWord,
    };
}

function rebuild() {
    S.base = mergeBooks(S.sources.map(s => ({ name: s.name, entries: s.entries })));
    S.work = structuredClone(S.base);
    S.history = [];
    S.applied = [];
    S.saved = null;
    rediagnose();
    suggestName();
}
function rediagnose() {
    S.issues = S.work.length ? diagnose(S.work, scanOpts()) : [];
}
function suggestName() {
    const cc = currentChar();
    const stBooks = S.sources.filter(s => s.book);
    if (S.sources.length === 1 && stBooks.length === 1) { S.saveName = stBooks[0].book; S.saveMode = 'overwrite'; return; }
    S.saveMode = 'new';
    const base = S.sources.length > 1 && cc ? cc.ch.name : (S.sources[0]?.name ?? 'Lorebook');
    S.saveName = `${base} (Lore Master)`;
}

function addSource({ name, raw, book = undefined }) {
    const read = readLorebook(raw, { name, defaultPosition: Number(settings().position), template: template() });
    S.sources.push({ id: nextSourceId++, name: read.name || name, format: read.format, raw, book, entries: read.entries });
}
function rereadSources() {
    for (const s of S.sources) {
        if (s.book) continue;
        s.entries = readLorebook(s.raw, { name: s.name, defaultPosition: Number(settings().position), template: template() }).entries;
    }
}

// ---------------------------------------------------------------- chat text for testing

function chatSample() {
    const c = ctx();
    const depth = Math.max(2, Number(WI.world_info_depth) || 2);
    return (c.chat ?? []).filter(m => !m.is_system && m.mes).slice(-depth).map(m => `${m.name}: ${m.mes}`).join('\n');
}

// ---------------------------------------------------------------- UI shell

let root = null;
function ensureRoot() {
    if (root) return root;
    root = document.createElement('div');
    root.id = 'lm_root';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Lore Master');
    document.body.appendChild(root);
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('input', onInput);
    return root;
}

export function openLoreMaster(tab) {
    ensureRoot();
    S.open = true;
    if (tab) S.tab = tab;
    root.classList.add('lm_open');
    document.documentElement.classList.add('lm_noscroll');
    render();
}
function closeLoreMaster() {
    S.open = false;
    root?.classList.remove('lm_open');
    document.documentElement.classList.remove('lm_noscroll');
}

const TABS = [
    ['src', 'fa-folder-open', 'เลือกเล่ม'],
    ['fix', 'fa-stethoscope', 'ตรวจ'],
    ['test', 'fa-flask', 'ทดสอบ'],
    ['save', 'fa-floppy-disk', 'บันทึก'],
];

function render() {
    if (!root || !S.open) return;
    const scrollEl = root.querySelector('.lm_body');
    const keepScroll = scrollEl?.dataset.tab === S.tab ? scrollEl.scrollTop : 0;
    const highCount = S.issues.filter(i => i.severity === 'high').length;
    root.innerHTML = `
    <div class="lm_panel">
      <div class="lm_head">
        <div class="lm_title"><i class="fa-solid fa-book-atlas"></i> Lore Master <span class="lm_ver">v${VERSION}</span></div>
        <button class="lm_icon" data-act="close" title="ปิด" aria-label="ปิด"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <nav class="lm_tabs">${TABS.map(([id, icon, label]) => `
        <button class="lm_tab ${S.tab === id ? 'lm_on' : ''}" data-act="tab" data-tab="${id}" ${id !== 'src' && !S.work.length ? 'disabled' : ''}>
          <i class="fa-solid ${icon}"></i><span>${label}${id === 'fix' && highCount ? ` <b class="lm_badge">${highCount}</b>` : ''}</span>
        </button>`).join('')}
      </nav>
      <div class="lm_body" data-tab="${S.tab}">${S.tab === 'src' ? viewSources() : S.tab === 'fix' ? viewFix() : S.tab === 'test' ? viewTest() : viewSave()}</div>
    </div>`;
    const body = root.querySelector('.lm_body');
    if (body) body.scrollTop = keepScroll;
}

// ---------------------------------------------------------------- tab: sources

function viewSources() {
    const cc = currentChar();
    const hasForeign = S.sources.some(s => !s.book && s.format !== 'st');
    const total = S.sources.reduce((n, s) => n + s.entries.length, 0);
    const pos = Number(settings().position);
    return `
    <p class="lm_lead">เลือก lorebook ที่จะตรวจ ถ้าเลือกหลายเล่ม จะรวมเป็นเล่มเดียวให้ ไฟล์ export จาก <b>JanitorAI</b> ที่ ST import เองไม่ได้ ใช้ที่นี่ได้เลย</p>
    <div class="lm_row lm_wrap">
      <label class="lm_btn lm_primary"><i class="fa-solid fa-file-import"></i> เลือกไฟล์ .json
        <input type="file" accept=".json,application/json" multiple hidden data-act="files"></label>
      <button class="lm_btn" data-act="picker"><i class="fa-solid fa-book"></i> เลือกจากเล่มใน ST</button>
      ${cc ? `<button class="lm_btn" data-act="charbooks"><i class="fa-solid fa-user"></i> เล่มของ ${escapeHtml(cc.ch.name)}</button>` : ''}
    </div>
    ${S.picker ? viewPicker() : ''}
    ${S.sources.length ? `
      <h3 class="lm_h">เล่มที่เลือก (${S.sources.length})</h3>
      <div class="lm_list">${S.sources.map(s => `
        <div class="lm_card lm_src">
          <div class="lm_grow">
            <div class="lm_name">${escapeHtml(s.name)}</div>
            <div class="lm_dim">${FORMAT_LABEL[s.format] ?? s.format}${s.book ? ' · ใน ST' : ' · ไฟล์'} · ${s.entries.length} เอนทรี · ≈${s.entries.reduce((n, e) => n + estTokens(e.content), 0).toLocaleString()} โทเคน</div>
          </div>
          <button class="lm_icon" data-act="rmsrc" data-id="${s.id}" title="เอาออก" aria-label="เอาออก"><i class="fa-solid fa-xmark"></i></button>
        </div>`).join('')}
      </div>
      ${hasForeign ? `
      <div class="lm_card lm_opt">
        <label class="lm_label" for="lm_pos">ไฟล์จากเว็บอื่นไม่ได้บอกตำแหน่งใน prompt จะให้ใส่ตรงไหน</label>
        <select id="lm_pos" data-act="pos">
          <option value="${POSITION.before}" ${pos === POSITION.before ? 'selected' : ''}>ก่อนข้อมูลตัวละคร (แนะนำ)</option>
          <option value="${POSITION.after}" ${pos === POSITION.after ? 'selected' : ''}>หลังข้อมูลตัวละคร</option>
          <option value="${POSITION.atDepth}" ${pos === POSITION.atDepth ? 'selected' : ''}>ในแชท ลึก 4 ข้อความ (@D4)</option>
        </select>
        <div class="lm_hint">ก่อน/หลังข้อมูลตัวละคร: อยู่ในส่วนข้อมูลตั้งต้น เหมาะกับข้อมูลโลก ตัวละคร สถานที่ · ในแชท @D4: แทรกใกล้ข้อความล่าสุด โมเดลให้น้ำหนักมากกว่า แต่ถ้าติดหลายตัวจะรกบทสนทนา</div>
      </div>` : ''}
      <button class="lm_btn lm_primary lm_big" data-act="tab" data-tab="fix">ตรวจ ${total} เอนทรี <i class="fa-solid fa-arrow-right"></i></button>
    ` : `<div class="lm_empty"><i class="fa-solid fa-book-open"></i><div>ยังไม่ได้เลือกเล่ม</div></div>`}`;
}

function viewPicker() {
    const names = (WI.world_names ?? []).filter(n => !S.pickerQuery || n.toLowerCase().includes(S.pickerQuery.toLowerCase()));
    const chosen = new Set(S.sources.filter(s => s.book).map(s => s.book));
    return `
    <div class="lm_card lm_picker">
      <input type="search" class="lm_input" placeholder="ค้นหาชื่อเล่ม…" value="${escapeHtml(S.pickerQuery)}" data-act="pickq">
      <div class="lm_pick_list">${names.length ? names.map(n => `
        <label class="lm_check"><input type="checkbox" data-act="pickbook" data-book="${escapeHtml(n)}" ${chosen.has(n) ? 'checked' : ''}><span>${escapeHtml(n)}</span></label>`).join('')
        : '<div class="lm_dim">ไม่เจอเล่ม</div>'}</div>
      <button class="lm_btn" data-act="picker">เสร็จ</button>
    </div>`;
}

// ---------------------------------------------------------------- tab: fix

const SEV = { high: ['lm_high', 'ด่วน'], mid: ['lm_mid', 'ควรแก้'], low: ['lm_low', 'เล็กน้อย'] };

function viewFix() {
    const sum = summarize(S.work);
    const sample = chatSample();
    let live = '';
    if (sample) {
        const o = scanOpts();
        const before = simulate(S.base, sample, o);
        const now = simulate(S.work, sample, o);
        live = `<div class="lm_card lm_live">
          <div class="lm_dim">ลองกับข้อความล่าสุดในแชทที่เปิดอยู่ (recursion ${o.recursive ? 'เปิด' : 'ปิด'})</div>
          <div class="lm_vs"><span><b>${before.hits.length}</b> เอนทรี<br><small>≈${before.tokens.toLocaleString()} โทเคน · ก่อนซ่อม</small></span>
          <i class="fa-solid fa-arrow-right"></i>
          <span class="${now.hits.length < before.hits.length ? 'lm_good' : ''}"><b>${now.hits.length}</b> เอนทรี<br><small>≈${now.tokens.toLocaleString()} โทเคน · ตอนนี้</small></span></div>
        </div>`;
    }
    const checkedTotal = S.issues.reduce((n, i) => n + i.changes.filter(c => c.checked).length, 0);
    return `
    <div class="lm_sum">
      <span><b>${sum.count}</b> เอนทรี</span><span>≈<b>${sum.tokens.toLocaleString()}</b> โทเคนทั้งเล่ม</span>
      <span>ติดตลอด <b>${sum.constant}</b></span><span>มีคีย์ไทย <b>${sum.thaiKeys}</b></span>
    </div>
    ${live}
    <div class="lm_row lm_wrap lm_sticky">
      <button class="lm_btn lm_primary" data-act="fixall" ${checkedTotal ? '' : 'disabled'}><i class="fa-solid fa-wand-magic-sparkles"></i> ซ่อมทุกข้อที่ติ๊กไว้ (${checkedTotal})</button>
      <button class="lm_btn" data-act="undo" ${S.history.length ? '' : 'disabled'}><i class="fa-solid fa-rotate-left"></i> ย้อน</button>
    </div>
    ${S.applied.length ? `<div class="lm_card lm_done"><b><i class="fa-solid fa-check"></i> ซ่อมแล้ว</b><ul>${S.applied.map(t => `<li>${escapeHtml(t)}</li>`).join('')}</ul>
      <button class="lm_btn lm_primary" data-act="tab" data-tab="save">ไปบันทึก <i class="fa-solid fa-arrow-right"></i></button></div>` : ''}
    ${S.issues.length ? S.issues.map(viewIssue).join('') : '<div class="lm_empty"><i class="fa-solid fa-circle-check"></i><div>ไม่เจอปัญหาแล้ว</div></div>'}
    <p class="lm_hint">ทุกอย่างยังอยู่ในหน้านี้ ยังไม่ได้แก้ไฟล์จริงจนกว่าจะกดบันทึก</p>`;
}

function viewIssue(i) {
    const [cls, label] = SEV[i.severity];
    const open = S.expanded.has(i.id);
    const shown = open ? i.changes : i.changes.slice(0, 6);
    const on = i.changes.filter(c => c.checked).length;
    return `
    <section class="lm_card lm_issue ${cls}">
      <div class="lm_issue_head"><span class="lm_sev">${label}</span><h4>${escapeHtml(i.title)}</h4></div>
      <p class="lm_why">${escapeHtml(i.why)}</p>
      ${i.examples?.length ? `<ul class="lm_ex">${i.examples.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>` : ''}
      ${i.changes.length ? `
        ${i.changes.length > 1 ? `<div class="lm_row lm_mini"><button class="lm_link" data-act="checkall" data-issue="${i.id}" data-v="1">เลือกทั้งหมด</button><button class="lm_link" data-act="checkall" data-issue="${i.id}" data-v="0">ไม่เลือกเลย</button></div>` : ''}
        <div class="lm_changes">${shown.map(c => `
          <label class="lm_check"><input type="checkbox" data-act="check" data-id="${c.id}" ${c.checked ? 'checked' : ''}><span>${escapeHtml(c.label)}</span></label>`).join('')}
        </div>
        ${i.changes.length > 6 ? `<button class="lm_link" data-act="expand" data-issue="${i.id}">${open ? 'ย่อ' : `ดูทั้งหมด (${i.changes.length})`}</button>` : ''}
        <button class="lm_btn" data-act="fixone" data-issue="${i.id}" ${on ? '' : 'disabled'}><i class="fa-solid fa-wrench"></i> ซ่อมข้อนี้ (${on})</button>` : ''}
    </section>`;
}

function applyFix(issueIds) {
    const picked = S.issues.filter(i => issueIds.includes(i.id));
    const changes = picked.flatMap(i => i.changes.filter(c => c.checked));
    if (!changes.length) return;
    S.history.push({ work: S.work, applied: [...S.applied] });
    S.work = applyChanges(S.work, changes);
    for (const i of picked) {
        const n = i.changes.filter(c => c.checked).length;
        if (n) S.applied.push(`${i.short ?? i.title} — ${n} รายการ`);
    }
    S.saved = null;
    rediagnose();
    render();
}

// ---------------------------------------------------------------- tab: test

function viewTest() {
    const o = scanOpts();
    const text = S.simText;
    let result = '';
    if (text.trim()) {
        const before = simulate(S.base, text, o);
        const now = simulate(S.work, text, o);
        const nowSet = new Set(now.hits.map(h => h.entry.uid));
        const gone = before.hits.filter(h => !S.work.some(e => e.uid === h.entry.uid) ? false : !nowSet.has(h.entry.uid));
        result = `
        <div class="lm_vs lm_card"><span><b>${before.hits.length}</b> เอนทรี<br><small>≈${before.tokens.toLocaleString()} โทเคน · ก่อนซ่อม</small></span>
          <i class="fa-solid fa-arrow-right"></i>
          <span class="${now.hits.length < before.hits.length ? 'lm_good' : ''}"><b>${now.hits.length}</b> เอนทรี<br><small>≈${now.tokens.toLocaleString()} โทเคน · ตอนนี้</small></span></div>
        <h3 class="lm_h">ที่ติดตอนนี้</h3>
        <div class="lm_list">${now.hits.map(h => `
          <div class="lm_card lm_hit">
            <span class="lm_tag ${h.via === 'constant' ? 'lm_t_const' : h.via === 'recursion' ? 'lm_t_rec' : 'lm_t_key'}">${h.via === 'constant' ? 'ติดตลอด' : h.via === 'recursion' ? `ลูกโซ่ R${h.step}` : 'คีย์'}</span>
            <div class="lm_grow"><div class="lm_name">${escapeHtml(h.entry.comment || `#${h.entry.uid}`)}</div>
            <div class="lm_dim">${h.key ? `คีย์ “${escapeHtml(h.key)}” · ` : ''}≈${estTokens(h.entry.content)} โทเคน${h.entry._src && S.sources.length > 1 ? ` · ${escapeHtml(h.entry._src)}` : ''}</div></div>
          </div>`).join('') || '<div class="lm_dim">ไม่มีเอนทรีไหนติด</div>'}</div>
        ${gone.length ? `<h3 class="lm_h">ไม่ติดแล้วหลังซ่อม (${gone.length})</h3><div class="lm_dim lm_gone">${gone.map(h => escapeHtml(h.entry.comment || `#${h.entry.uid}`)).join(' · ')}</div>` : ''}`;
    }
    return `
    <p class="lm_lead">พิมพ์หรือวางข้อความ ดูว่าจะมีเอนทรีไหนติดบ้าง เทียบก่อนและหลังซ่อม ไม่เสียโควต้า API</p>
    <textarea class="lm_input lm_text" rows="6" placeholder="เช่น Cody เดินไปห้องสมุดกับ Jonah…" data-act="simtext">${escapeHtml(text)}</textarea>
    <div class="lm_row lm_wrap">
      <button class="lm_btn" data-act="usechat" ${chatSample() ? '' : 'disabled'}><i class="fa-solid fa-comments"></i> ใช้ข้อความล่าสุดในแชท</button>
      <label class="lm_check lm_inline"><input type="checkbox" data-act="simrec" ${o.recursive ? 'checked' : ''}><span>recursion${S.simRecursive === null ? ' (ตามที่ตั้งใน ST)' : ''}</span></label>
    </div>
    <p class="lm_hint">เป็นการจำลองแบบเต็มที่: ไม่นับ probability, inclusion group และงบโทเคน ของจริงอาจติดน้อยกว่านี้ ดูของจริงได้ใน Lore Lens</p>
    <div class="lm_result">${result}</div>`;
}

// ---------------------------------------------------------------- tab: save

function viewSave() {
    const cc = currentChar();
    const books = charBooks(cc);
    const srcBooks = S.sources.filter(s => s.book).map(s => s.book);
    const single = S.sources.length === 1 && srcBooks.length === 1 ? srcBooks[0] : null;
    const name = S.saveMode === 'overwrite' && single ? single : S.saveName;
    const exists = S.saveMode !== 'overwrite' && (WI.world_names ?? []).includes(S.saveName.trim());
    const oldPrimaryLost = cc && S.linkChar && books.primary && books.primary !== name && !srcBooks.includes(books.primary);
    const linkedSources = cc ? srcBooks.filter(b => (b === books.primary || books.extra.includes(b)) && b !== name) : [];
    const sum = summarize(S.work);
    if (S.saved) {
        return `<div class="lm_card lm_done lm_center">
          <i class="fa-solid fa-circle-check lm_bigicon"></i>
          <h3>บันทึก “${escapeHtml(S.saved.name)}” แล้ว</h3>
          <p>${S.saved.linked ? `ตั้งเป็น lorebook หลักของ ${escapeHtml(S.saved.linked)} แล้ว เวลา export การ์ด เล่มนี้จะติดไปกับการ์ด` : 'ไปผูกกับการ์ด/แชทได้ตามปกติในหน้า World Info'}</p>
          ${S.saved.cap ? `<p class="lm_dim">จำกัดไม่เกิน ${S.saved.cap} เอนทรีต่อเทิร์น (เฉพาะเครื่องที่ลง Lore Master)</p>` : ''}
          <div class="lm_row lm_wrap lm_centerrow">
            <button class="lm_btn lm_primary" data-act="openst" data-book="${escapeHtml(S.saved.name)}"><i class="fa-solid fa-pen"></i> เปิดในตัวแก้ไขของ ST</button>
            <button class="lm_btn" data-act="download"><i class="fa-solid fa-download"></i> ดาวน์โหลด .json</button>
            ${S.saved.backup ? `<button class="lm_btn" data-act="restore" data-book="${escapeHtml(S.saved.name)}"><i class="fa-solid fa-clock-rotate-left"></i> กู้เล่มเดิมคืน</button>` : ''}
          </div></div>`;
    }
    return `
    <div class="lm_sum"><span><b>${sum.count}</b> เอนทรี</span><span>≈<b>${sum.tokens.toLocaleString()}</b> โทเคน</span><span>ซ่อมไป <b>${S.applied.length}</b> ข้อ</span></div>
    <div class="lm_card lm_form">
      ${single ? `
        <label class="lm_check"><input type="radio" name="lm_mode" data-act="mode" value="overwrite" ${S.saveMode === 'overwrite' ? 'checked' : ''}><span>เขียนทับเล่มเดิม “${escapeHtml(single)}” <small class="lm_dim">(สำรองเล่มเดิมไว้ในเบราว์เซอร์ก่อน กู้คืนได้)</small></span></label>
        <label class="lm_check"><input type="radio" name="lm_mode" data-act="mode" value="new" ${S.saveMode === 'new' ? 'checked' : ''}><span>บันทึกเป็นเล่มใหม่</span></label>` : ''}
      ${S.saveMode !== 'overwrite' || !single ? `
        <label class="lm_label" for="lm_name">ชื่อเล่ม</label>
        <input id="lm_name" class="lm_input" value="${escapeHtml(S.saveName)}" data-act="name">
        ${exists ? '<div class="lm_warn"><i class="fa-solid fa-triangle-exclamation"></i> มีเล่มชื่อนี้อยู่แล้ว จะเขียนทับ (สำรองเล่มเดิมไว้ให้ก่อน)</div>' : ''}` : ''}
      ${S.sources.length > 1 ? `<label class="lm_check"><input type="checkbox" data-act="prefix" ${S.prefixSource ? 'checked' : ''}><span>ใส่ชื่อเล่มเดิมหน้าชื่อเอนทรี เช่น <code>[${escapeHtml(S.sources[0].name)}] …</code> หาในตัวแก้ไขง่ายขึ้น</span></label>` : ''}
      ${cc ? `
        <label class="lm_check"><input type="checkbox" data-act="link" ${S.linkChar ? 'checked' : ''}><span>ตั้งเป็น lorebook หลักของ <b>${escapeHtml(cc.ch.name)}</b><br><small class="lm_dim">เวลา export การ์ด เล่มนี้จะฝังไปในการ์ด คนที่ได้การ์ดไปใช้ได้เลยโดยไม่ต้องลง Lore Master</small></span></label>
        ${oldPrimaryLost ? `<div class="lm_warn"><i class="fa-solid fa-circle-info"></i> เล่มหลักเดิม “${escapeHtml(books.primary)}” จะย้ายไปเป็นเล่มเสริมของการ์ด ไม่หายไปไหน</div>` : ''}
        ${S.linkChar && linkedSources.length ? `<label class="lm_check"><input type="checkbox" data-act="unlink" ${S.unlinkOld ? 'checked' : ''}><span>ถอดเล่มที่รวมแล้วออกจากการ์ด: ${linkedSources.map(escapeHtml).join(', ')}<br><small class="lm_dim">ไม่งั้นเนื้อหาเดียวกันจะติดซ้ำ 2 ที่ (ตัวไฟล์เล่มไม่ถูกลบ)</small></span></label>` : ''}` : ''}
      <label class="lm_check"><input type="checkbox" data-act="capon" ${S.capOn ? 'checked' : ''}><span>จำกัดไม่เกิน <input type="number" min="1" max="99" class="lm_input lm_num" value="${S.capN}" data-act="capn"> เอนทรีต่อเทิร์นจากเล่มนี้<br><small class="lm_dim">กันระเบิด ถ้าติดเกิน จะตัดตัวที่สำคัญน้อยสุด (order ต่ำ / ติดจากลูกโซ่) ทิ้งก่อน ทำงานเฉพาะเครื่องที่ลง Lore Master</small></span></label>
    </div>
    <div class="lm_row lm_wrap">
      <button class="lm_btn lm_primary lm_big" data-act="save" ${S.busy ? 'disabled' : ''}><i class="fa-solid fa-floppy-disk"></i> ${S.busy ? 'กำลังบันทึก…' : 'บันทึก'}</button>
      <button class="lm_btn" data-act="download"><i class="fa-solid fa-download"></i> ดาวน์โหลด .json</button>
    </div>`;
}

function worldData() {
    return toWorld(S.work, { prefixSource: S.sources.length > 1 && S.prefixSource, template: template() });
}

async function doSave() {
    const cc = currentChar();
    const srcBooks = S.sources.filter(s => s.book).map(s => s.book);
    const single = S.sources.length === 1 && srcBooks.length === 1 ? srcBooks[0] : null;
    const name = (S.saveMode === 'overwrite' && single ? single : S.saveName).trim().replace(/[\\/:*?"<>|]/g, '_');
    if (!name) { toast.warning('ตั้งชื่อเล่มก่อน'); return; }
    S.busy = true; render();
    try {
        let backup = false;
        if ((WI.world_names ?? []).includes(name)) {
            try { await backupPut(name, await WI.loadWorldInfo(name)); backup = true; } catch (e) { console.warn(LOG, 'backup failed', e); }
        }
        await WI.saveWorldInfo(name, worldData(), true);
        await WI.updateWorldInfoList?.();
        try { WI.reloadEditor?.(name); } catch { /* editor not showing it */ }

        const s = settings();
        if (S.capOn && S.capN > 0) s.caps[name] = Number(S.capN); else delete s.caps[name];
        s.defaultCap = Number(S.capN) || s.defaultCap;
        save();

        let linked = '';
        if (cc && S.linkChar) {
            const books = charBooks(cc);
            // books folded into this one stop being attached to the card, so nothing fires twice
            const drop = new Set(S.unlinkOld ? srcBooks : []);
            drop.add(name);
            const extras = books.extra.filter(b => !drop.has(b));
            // the old main book is kept as an extra book, not lost
            if (books.primary && !drop.has(books.primary)) extras.push(books.primary);
            setExtraBooks(cc.stem, extras);
            save();
            await WI.charUpdatePrimaryWorld(name);
            linked = cc.ch.name;
        }
        S.saved = { name, linked, cap: S.capOn ? S.capN : 0, backup };
        toast.success(`บันทึก “${name}” แล้ว`, 'Lore Master');
        renderSettings();
    } catch (e) {
        console.error(LOG, e);
        toast.error(String(e?.message ?? e), 'บันทึกไม่สำเร็จ');
    } finally {
        S.busy = false;
        render();
    }
}

function setExtraBooks(stem, books) {
    WI.world_info.charLore ??= [];
    const list = WI.world_info.charLore;
    const i = list.findIndex(x => x.name === stem);
    if (!books.length) { if (i >= 0) list.splice(i, 1); return; }
    if (i >= 0) list[i].extraBooks = [...new Set(books)];
    else list.push({ name: stem, extraBooks: [...new Set(books)] });
}

async function restoreLatest(book) {
    const list = await backupList(book).catch(() => []);
    if (!list.length) { toast.warning('ไม่มีสำรองของเล่มนี้'); return; }
    await WI.saveWorldInfo(book, list[0].data, true);
    try { WI.reloadEditor?.(book); } catch { /* ignore */ }
    toast.success(`กู้ “${book}” คืนเป็นฉบับ ${new Date(list[0].at).toLocaleString()} แล้ว`);
}

function download() {
    const name = (S.saved?.name || S.saveName || 'lorebook').replace(/[\\/:*?"<>|]/g, '_');
    const blob = new Blob([JSON.stringify(worldData(), null, 2)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${name}.json` });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------------------------------------------------------------- events

async function readFiles(files) {
    let added = 0;
    for (const f of files) {
        try {
            const raw = JSON.parse(await f.text());
            addSource({ name: f.name.replace(/\.json$/i, ''), raw });
            added++;
        } catch (e) {
            toast.error(`${f.name}: ${e?.message ?? e}`, 'อ่านไฟล์ไม่ได้');
        }
    }
    if (added) rebuild();
    render();
}

async function addBook(name) {
    if (S.sources.some(s => s.book === name)) return;
    try {
        const raw = await WI.loadWorldInfo(name);
        if (!raw) throw new Error('โหลดไม่ได้');
        addSource({ name, raw, book: name });
    } catch (e) {
        toast.error(`${name}: ${e?.message ?? e}`);
    }
}

async function onClick(ev) {
    const t = ev.target.closest('[data-act]');
    if (!t || t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') return;
    const act = t.dataset.act;
    if (act === 'close') return closeLoreMaster();
    if (act === 'tab') { if (!t.disabled) { S.tab = t.dataset.tab; if (S.tab === 'test' && !S.simText) S.simText = chatSample(); render(); } return; }
    if (act === 'picker') { if (S.picker) rebuild(); S.picker = !S.picker; render(); return; }
    if (act === 'charbooks') {
        const b = charBooks(currentChar());
        for (const n of [b.primary, ...b.extra].filter(Boolean)) await addBook(n);
        if (!b.primary && !b.extra.length) toast.info('การ์ดนี้ยังไม่มี lorebook');
        rebuild(); render(); return;
    }
    if (act === 'rmsrc') { S.sources = S.sources.filter(s => s.id !== Number(t.dataset.id)); rebuild(); render(); return; }
    if (act === 'fixall') return applyFix(S.issues.map(i => i.id));
    if (act === 'fixone') return applyFix([t.dataset.issue]);
    if (act === 'undo') {
        const h = S.history.pop();
        if (h) { S.work = h.work; S.applied = h.applied; S.saved = null; rediagnose(); render(); }
        return;
    }
    if (act === 'expand') { const id = t.dataset.issue; S.expanded.has(id) ? S.expanded.delete(id) : S.expanded.add(id); render(); return; }
    if (act === 'checkall') {
        const i = S.issues.find(x => x.id === t.dataset.issue);
        i?.changes.forEach(c => { c.checked = t.dataset.v === '1'; });
        render(); return;
    }
    if (act === 'usechat') { S.simText = chatSample(); render(); return; }
    if (act === 'save') return doSave();
    if (act === 'download') return download();
    if (act === 'restore') return restoreLatest(t.dataset.book);
    if (act === 'openst') { closeLoreMaster(); WI.openWorldInfoEditor?.(t.dataset.book); return; }
}

let simTimer = null;
function onInput(ev) {
    const t = ev.target;
    const act = t.dataset?.act;
    if (act === 'simtext') {
        S.simText = t.value;
        clearTimeout(simTimer);
        simTimer = setTimeout(() => {
            const box = root.querySelector('.lm_result');
            if (!box) return;
            const tmp = document.createElement('div');
            tmp.innerHTML = viewTest();
            box.replaceWith(tmp.querySelector('.lm_result'));
        }, 350);
    } else if (act === 'pickq') {
        S.pickerQuery = t.value;
        const list = root.querySelector('.lm_pick_list');
        const tmp = document.createElement('div');
        tmp.innerHTML = viewPicker();
        list?.replaceWith(tmp.querySelector('.lm_pick_list'));
    } else if (act === 'name') {
        S.saveName = t.value;
    } else if (act === 'capn') {
        S.capN = Math.max(1, Math.min(99, Number(t.value) || 1));
    }
}

async function onChange(ev) {
    const t = ev.target;
    const act = t.dataset?.act;
    if (act === 'files') { await readFiles([...t.files]); t.value = ''; return; }
    if (act === 'pickbook') {
        const name = t.dataset.book;
        if (t.checked) await addBook(name); else S.sources = S.sources.filter(s => s.book !== name);
        rebuild();
        render();
        return;
    }
    if (act === 'pos') { settings().position = Number(t.value); save(); rereadSources(); rebuild(); render(); return; }
    if (act === 'check') {
        for (const i of S.issues) for (const c of i.changes) if (c.id === t.dataset.id) c.checked = t.checked;
        render(); return;
    }
    if (act === 'simrec') { S.simRecursive = t.checked; render(); return; }
    if (act === 'mode') { S.saveMode = t.value; render(); return; }
    if (act === 'name') { render(); return; }
    if (act === 'prefix') { S.prefixSource = t.checked; return; }
    if (act === 'link') { S.linkChar = t.checked; render(); return; }
    if (act === 'unlink') { S.unlinkOld = t.checked; return; }
    if (act === 'capon') { S.capOn = t.checked; return; }
}

// ---------------------------------------------------------------- runtime: per-turn cap

let lastCut = null;
function onScanDone(args) {
    const caps = settings().caps;
    if (!caps || !Object.keys(caps).length) return;
    const map = args?.activated?.entries;
    if (!(map instanceof Map) || !map.size) return;
    const drop = overCap([...map.values()], caps);
    if (!drop.length) return;
    for (const e of drop) map.delete(`${e.world}.${e.uid}`);
    lastCut = { at: Date.now(), n: drop.length, names: drop.map(e => e.comment || `#${e.uid}`) };
    console.info(LOG, `per-turn cap: dropped ${drop.length} entries`, lastCut.names);
}

// ---------------------------------------------------------------- import button interception

/** ST can't import JanitorAI exports ("Is not a valid world info file"); open them here instead. */
async function onImportChange(ev) {
    const input = ev.target;
    if (!(input instanceof HTMLInputElement) || input.id !== 'world_import_file' || !settings().interceptImport) return;
    const file = input.files?.[0];
    if (!file || !/\.json$/i.test(file.name)) return;
    ev.stopImmediatePropagation();
    let raw = null;
    try { raw = JSON.parse(await file.text()); } catch { raw = null; }
    const fmt = raw ? detectFormat(raw) : null;
    if (fmt === 'janitor' || fmt === 'charbook' || fmt === 'card') {
        input.value = '';
        S.sources = [];
        addSource({ name: file.name.replace(/\.json$/i, ''), raw });
        rebuild();
        openLoreMaster('fix');
        toast.info(`ไฟล์นี้เป็นแบบ ${FORMAT_LABEL[fmt]} ซึ่ง ST import เองไม่ได้ เปิดใน Lore Master ให้แล้ว ตรวจเสร็จกดบันทึก`, 'Lore Master', { timeOut: 9000 });
        return;
    }
    try { await WI.importWorldInfo(file); } finally { input.value = ''; }
}

// ---------------------------------------------------------------- settings drawer + entry points

function renderSettings() {
    const box = document.getElementById('lm_caps');
    if (!box) return;
    const caps = settings().caps;
    const names = Object.keys(caps);
    box.innerHTML = names.length ? names.map(n => `
        <div class="lm_caprow"><span class="lm_grow">${escapeHtml(n)}</span>
          <input type="number" min="1" max="99" class="text_pole lm_num" data-cap="${escapeHtml(n)}" value="${caps[n]}">
          <button class="menu_button lm_capx" data-capx="${escapeHtml(n)}" title="เลิกจำกัด"><i class="fa-solid fa-xmark"></i></button></div>`).join('')
        : '<div class="lm_dim">ยังไม่มีเล่มที่จำกัด</div>';
}

function mountSettings() {
    const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!host || document.getElementById('lm_settings')) return;
    const div = document.createElement('div');
    div.id = 'lm_settings';
    div.innerHTML = `
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header"><b>Lore Master</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
      <div class="inline-drawer-content">
        <div class="menu_button lm_open_btn" id="lm_open"><i class="fa-solid fa-book-atlas"></i> เปิด Lore Master</div>
        <small>ตรวจ ซ่อม และรวม lorebook ที่ import มาจากเว็บอื่น · เปิดได้จากปุ่ม <i class="fa-solid fa-stethoscope"></i> ในหน้า World Info หรือพิมพ์ <code>/loremaster</code></small>
        <label class="checkbox_label"><input type="checkbox" id="lm_intercept" ${settings().interceptImport ? 'checked' : ''}><span>ปุ่ม Import ของ World Info: ไฟล์ JanitorAI ให้เปิดใน Lore Master</span></label>
        <h4>จำกัดจำนวนเอนทรีต่อเทิร์น</h4>
        <div id="lm_caps"></div>
      </div>
    </div>`;
    host.appendChild(div);
    div.querySelector('#lm_open').addEventListener('click', () => openLoreMaster());
    div.querySelector('#lm_intercept').addEventListener('change', e => { settings().interceptImport = e.target.checked; save(); });
    div.querySelector('#lm_caps').addEventListener('input', e => {
        const n = e.target.dataset?.cap;
        if (n) { settings().caps[n] = Math.max(1, Number(e.target.value) || 1); save(); }
    });
    div.querySelector('#lm_caps').addEventListener('click', e => {
        const n = e.target.closest('[data-capx]')?.dataset.capx;
        if (n) { delete settings().caps[n]; save(); renderSettings(); }
    });
    renderSettings();
}

function mountWorldButton() {
    if (document.getElementById('lm_wi_btn')) return;
    const anchor = document.getElementById('world_import_button');
    if (!anchor) return;
    const b = document.createElement('div');
    b.id = 'lm_wi_btn';
    b.className = 'menu_button fa-solid fa-stethoscope';
    b.title = 'Lore Master: ตรวจ ซ่อม รวม lorebook';
    b.addEventListener('click', () => {
        // start from the book open in the editor, if any
        const sel = document.getElementById('world_editor_select');
        const name = sel && sel.value !== '' ? sel.options[sel.selectedIndex]?.text ?? '' : '';
        if (name && !S.sources.length) addBook(name).then(() => { rebuild(); openLoreMaster('fix'); });
        else openLoreMaster();
    });
    anchor.insertAdjacentElement('afterend', b);
}

function registerCommand() {
    try {
        const { SlashCommandParser, SlashCommand } = ctx();
        if (!SlashCommandParser || !SlashCommand) return;
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'loremaster',
            aliases: ['lm'],
            callback: () => { openLoreMaster(); return ''; },
            helpString: 'เปิด Lore Master: ตรวจ ซ่อม และรวม lorebook',
        }));
    } catch (e) { console.warn(LOG, 'slash command', e); }
}

// ---------------------------------------------------------------- start

(function init() {
    settings();
    S.capN = settings().defaultCap;
    mountSettings();
    mountWorldButton();
    registerCommand();
    document.addEventListener('change', onImportChange, true);
    const { eventSource, eventTypes } = ctx();
    const E = eventTypes ?? {};
    if (E.WORLDINFO_SCAN_DONE) eventSource.on(E.WORLDINFO_SCAN_DONE, onScanDone);
    else console.warn(LOG, 'no WORLDINFO_SCAN_DONE event — the per-turn cap needs a newer SillyTavern');
    if (E.APP_READY) eventSource.on(E.APP_READY, () => { mountSettings(); mountWorldButton(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.open) closeLoreMaster(); });
    globalThis.LoreMaster = { open: openLoreMaster, version: VERSION, lastCut: () => lastCut };
    console.log(LOG, `v${VERSION} ready`);
})();
