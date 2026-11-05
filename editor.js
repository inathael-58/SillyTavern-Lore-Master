/*
 * Lore Master — the lorebook editor: library (all books) → one book (entries) → one entry.
 * Replaces SillyTavern's World Info panel, built for phones first.
 */

import {
    entryStatus, entryWarnings, entryMatches, keyWarnings, positionShort, positionInfo, POSITION_INFO, ROLE_INFO,
    LOGIC_INFO, TRIGGER_INFO, SORTS, estTokens, cleanKeys, firingKey, THAI, entriesOf, LONG_TOKENS, isGlossary,
    NAME_SYSTEM, properNames, collectNames, deriveNames, nameRequest, parseNameReply, entrySuggestions, preferThaiKey, LANG_LABEL, vetThaiKey, CONDENSE_SYSTEM, condenseRequest, cleanCondensed,
} from './lib.js';
import { ask } from './ai.js';
import { nameCache, rememberNames } from './cache.js';
import { backupPut, backupList } from './backup.js';
import { settings } from './prefs.js';
import * as St from './store.js';
import { esc, icon, act, shell, UI, top, push, back, goTab, sheet, confirmBox, promptBox, previewBox, pickBook, download, toast, fmt, switchHtml, rangeHtml } from './ui.js';

let thaiSeg = null;
try { thaiSeg = new Intl.Segmenter('th', { granularity: 'word' }); } catch { thaiSeg = null; }
export function isThaiDictWord(s) {
    if (!thaiSeg || !THAI.test(s)) return false;
    const segs = [...thaiSeg.segment(s)].filter(x => x.isWordLike);
    return segs.length === 1 && segs[0].segment === s;
}
const names = () => ({ char: St.ctx().name2 ?? '', user: St.ctx().name1 ?? '' });
const warnCtx = () => ({ names: names(), isThaiDictWord });
const collator = new Intl.Collator(['th', 'en'], { sensitivity: 'base', numeric: true });

/** Hooks the doctor module fills in (avoids a circular import). */
export const hooks = { checkBook: async () => {}, importFiles: async () => {}, mergeBooks: () => {}, thaiBook: async () => {}, condenseBook: async () => {} };

const PAGE = 60; // entry cards shown at once (books with 500+ entries stay fast)
const L = { q: '', bookQ: '', filter: 'all', sort: 'book', selecting: false, selected: new Set(), focus: null, limit: PAGE };

const USE_TAGS = {
    chat: ['fa-comment', 'แชทนี้'],
    primary: ['fa-user', 'เล่มหลักของการ์ด'],
    extra: ['fa-paperclip', 'เล่มเสริมของการ์ด'],
    persona: ['fa-masks-theater', 'Persona'],
    global: ['fa-globe', 'Global'],
};
function hue(s) { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.codePointAt(0)) % 360; return h; }
const coverLetter = s => [...String(s).replace(/^[^\p{L}\p{N}]+/u, '')][0]?.toUpperCase() ?? '📖';

// ================================================================ library

export function viewLibrary() {
    const all = St.bookNames().sort(collator.compare);
    const use = St.usage();
    const q = L.q.trim().toLowerCase();
    const match = n => !q || n.toLowerCase().includes(q);
    const order = ['chat', 'primary', 'extra', 'persona', 'global'];
    const active = [...use.keys()].filter(n => all.includes(n) && match(n))
        .sort((a, b) => Math.min(...[...use.get(a)].map(t => order.indexOf(t))) - Math.min(...[...use.get(b)].map(t => order.indexOf(t))) || collator.compare(a, b));
    const rest = all.filter(n => match(n) && !use.has(n));
    const cc = St.currentChar();
    const chatOpen = St.chatBook() !== null;
    return {
        title: 'Lore Master',
        sub: `${all.length} เล่ม`,
        actions: `<button class="lm_icon" data-act="lib-new" title="สร้าง / นำเข้า" aria-label="สร้าง หรือนำเข้า">${icon('fa-plus')}</button>`,
        body: `
        <div class="lm_search">${icon('fa-magnifying-glass')}<input type="search" class="lm_input" placeholder="ค้นหาเล่ม…" value="${esc(L.q)}" data-act="lib-q" enterkeyhint="search"></div>
        <div class="lm_liblist">${libraryList(active, rest, use, cc, chatOpen)}</div>
        <button class="lm_fab" data-act="lib-new" aria-label="สร้าง หรือนำเข้า">${icon('fa-plus')}</button>`,
    };
}

function libraryList(active, rest, use, cc, chatOpen) {
    const who = cc ? cc.ch.name : (St.ctx().groupId ? 'กลุ่มนี้' : '');
    return `
    <h3 class="lm_h">${icon('fa-bolt')} ใช้อยู่ตอนนี้${who ? ` <small>· ${esc(who)}</small>` : ''}</h3>
    ${active.length ? `<div class="lm_grid">${active.map(n => bookCard(n, use)).join('')}</div>`
        : `<div class="lm_card lm_soft">${chatOpen ? 'แชทนี้ยังไม่มี lorebook ผูกได้จากปุ่ม ⋯ ของเล่มด้านล่าง' : 'ยังไม่ได้เปิดแชท'}</div>`}
    <h3 class="lm_h">${icon('fa-book')} ${active.length ? 'เล่มอื่น ๆ' : 'ทั้งหมด'} <small>· ${rest.length}</small></h3>
    ${rest.length ? `<div class="lm_grid">${rest.map(n => bookCard(n, use)).join('')}</div>` : '<div class="lm_empty">ไม่เจอเล่ม</div>'}
    <div class="lm_bottom_pad"></div>`;
}

function bookCard(name, use) {
    const st = St.statsFor(name, () => refreshCard(name));
    const tags = [...(use.get(name) ?? [])];
    return `
    <div class="lm_bookcard" data-act="openbook" data-name="${esc(name)}" role="button" tabindex="0">
      <div class="lm_cover" style="--h:${hue(name)}">${esc(coverLetter(name))}</div>
      <div class="lm_grow">
        <div class="lm_name">${esc(name)}</div>
        <div class="lm_meta" data-stat="${esc(name)}">${statLine(st)}</div>
        ${tags.length ? `<div class="lm_badges">${tags.map(t => `<span class="lm_badge_use lm_u_${t}">${icon(USE_TAGS[t][0])} ${USE_TAGS[t][1]}</span>`).join('')}</div>` : ''}
      </div>
      <button class="lm_icon" data-act="bookmenu" data-name="${esc(name)}" aria-label="เมนูของเล่ม">${icon('fa-ellipsis-vertical')}</button>
    </div>`;
}
const statLine = st => (!st ? '<span class="lm_shimmer">กำลังนับ…</span>' : st.error ? 'อ่านไม่ได้' : `${fmt(st.count)} เอนทรี · ≈${fmt(st.tokens)} โทเคน${st.constant ? ` · ติดตลอด ${st.constant}` : ''}`);
function refreshCard(name) {
    shell.root?.querySelectorAll(`[data-stat="${CSS.escape(name)}"]`).forEach(el => { el.innerHTML = statLine(St.statCache.get(name)); });
}

async function bookMenu(name) {
    const use = St.usage().get(name) ?? new Set();
    const cc = St.currentChar();
    const chatOpen = St.chatBook() !== null;
    const v = await sheet({
        title: name,
        sub: St.cardsUsing(name).length ? `เล่มหลักของ: ${St.cardsUsing(name).join(', ')}` : '',
        items: [
            { value: 'open', label: 'เปิด', icon: 'fa-book-open' },
            { value: 'check', label: 'ตรวจหาปัญหา', icon: 'fa-stethoscope', hint: 'คีย์ระเบิด ลูกโซ่ คีย์ซ้ำ ฯลฯ' },
            '-',
            { value: 'global', label: 'Global (ใช้กับทุกแชท)', icon: 'fa-globe', on: use.has('global') },
            { value: 'primary', label: cc ? `เล่มหลักของ ${cc.ch.name}` : 'เล่มหลักของการ์ด', icon: 'fa-user', on: use.has('primary'), disabled: !cc, hint: cc ? 'ฝังไปกับการ์ดตอน export' : 'เปิดแชทกับตัวละครก่อน' },
            { value: 'extra', label: cc ? `เล่มเสริมของ ${cc.ch.name}` : 'เล่มเสริมของการ์ด', icon: 'fa-paperclip', on: use.has('extra'), disabled: !cc },
            { value: 'chat', label: 'ผูกกับแชทนี้ (Chat Lore)', icon: 'fa-comment', on: use.has('chat'), disabled: !chatOpen },
            '-',
            { value: 'rename', label: 'เปลี่ยนชื่อ', icon: 'fa-i-cursor' },
            { value: 'dup', label: 'ทำสำเนา', icon: 'fa-clone' },
            { value: 'merge', label: 'รวมกับเล่มอื่น…', icon: 'fa-object-group' },
            '-',
            { value: 'thai', label: 'ให้ AI คิดคีย์ไทยทั้งเล่ม', icon: 'fa-language', hint: 'ตรวจและเลือกก่อนเพิ่ม' },
            { value: 'condense', label: 'ให้ AI ย่อเอนทรีที่ยาว', icon: 'fa-compress', hint: 'ตัดคำบรรยายฟุ่มเฟือย เก็บข้อเท็จจริงไว้' },
            { value: 'gloss', label: 'สร้าง / อัปเดตอภิธานชื่อ', icon: 'fa-spell-check', hint: 'ชื่ออังกฤษ = ตัวสะกดไทย จากคีย์ไทยที่มี' },
            { value: 'export', label: 'ดาวน์โหลด .json', icon: 'fa-download' },
            '-',
            { value: 'delete', label: 'ลบเล่มนี้', icon: 'fa-trash', danger: true },
        ],
    });
    if (!v) return;
    try {
        if (v === 'open') return push({ v: 'book', name });
        if (v === 'check') return hooks.checkBook(name);
        if (v === 'global') St.setGlobal(name, !use.has('global'));
        if (v === 'primary') await St.setPrimary(use.has('primary') ? '' : name);
        if (v === 'extra') St.setExtra(name, !use.has('extra'));
        if (v === 'chat') await St.setChatBook(use.has('chat') ? '' : name);
        if (v === 'rename') {
            const n = await promptBox({ title: 'เปลี่ยนชื่อเล่ม', value: name, ok: 'เปลี่ยน', text: 'ลิงก์ทุกที่ที่ใช้เล่มนี้ (Global, การ์ด, แชท, persona) จะเปลี่ยนตามให้' });
            if (n && n !== name) {
                const nn = await St.renameBook(name, n);
                for (const s of UI.stack) if (s.name === name) s.name = nn;
                toast.success(`เปลี่ยนชื่อเป็น “${nn}” แล้ว`);
            }
        }
        if (v === 'dup') { const nn = await St.duplicateBook(name); toast.success(`สร้าง “${nn}” แล้ว`); }
        if (v === 'merge') return hooks.mergeBooks([name]);
        if (v === 'thai') return hooks.thaiBook(name);
        if (v === 'condense') return hooks.condenseBook(name);
        if (v === 'gloss') {
            const n = await St.updateGlossary(name);
            toast.success(n ? `อภิธานชื่อมี ${n} ชื่อ${settings().glossarySmart ? ' · โหมดประหยัดเปิดอยู่: ส่งเฉพาะชื่อที่เกี่ยวในแต่ละเทิร์น' : ''}` : 'ยังไม่มีเอนทรีที่มีคีย์ไทย เลยไม่มีชื่อให้ทำอภิธาน');
        }
        if (v === 'export') { if (St.cur?.name === name) await St.flush(); download(name, await St.WIref.loadWorldInfo(name)); }
        if (v === 'delete') {
            const used = [...use].map(t => USE_TAGS[t][1]);
            const cards = St.cardsUsing(name);
            const ok = await confirmBox({
                title: `ลบ “${name}”?`, danger: true, ok: 'ลบ',
                text: `ลบแล้วกู้คืนไม่ได้ (ดาวน์โหลด .json เก็บไว้ก่อนได้จากเมนูเดียวกัน)${used.length ? `<br><br>ตอนนี้ใช้เป็น: ${esc(used.join(', '))}` : ''}${cards.length ? `<br>เล่มหลักของ: ${esc(cards.join(', '))}` : ''}`,
            });
            if (!ok) return;
            await St.deleteBook(name);
            UI.stack = UI.stack.filter(s => s.name !== name);
            if (!UI.stack.length) UI.stack = [{ v: 'library' }];
            toast.success(`ลบ “${name}” แล้ว`);
        }
    } catch (e) {
        toast.error(String(e?.message ?? e));
    }
    shell.render();
}

async function newMenu() {
    const v = await sheet({
        title: 'เพิ่มเล่ม',
        items: [
            { value: 'new', label: 'สร้างเล่มเปล่า', icon: 'fa-file-circle-plus' },
            { value: 'import', label: 'นำเข้าไฟล์ .json / การ์ด .png', icon: 'fa-file-import', hint: 'ไฟล์ของ ST, JanitorAI, character_book หรือ lorebook ในการ์ด — ตรวจและซ่อมก่อนบันทึก' },
            { value: 'merge', label: 'รวมหลายเล่มเป็นเล่มเดียว', icon: 'fa-object-group' },
        ],
    });
    if (v === 'new') {
        const cc = St.currentChar();
        const n = await promptBox({ title: 'ชื่อเล่มใหม่', value: St.freeName(cc ? `${cc.ch.name} Lore` : 'Lorebook ใหม่'), ok: 'สร้าง' });
        if (!n) return;
        try {
            const name = await St.createBook(n);
            push({ v: 'book', name });
            if (cc && !St.charBooks(cc).primary) {
                if (await confirmBox({ title: `ตั้งเป็นเล่มหลักของ ${cc.ch.name}?`, text: 'การ์ดนี้ยังไม่มีเล่มหลัก ตั้งแล้วเล่มจะติดไปกับการ์ดตอน export', ok: 'ตั้งเลย' })) {
                    await St.setPrimary(name);
                    shell.render();
                }
            }
        } catch (e) { toast.error(String(e?.message ?? e)); }
    }
    if (v === 'import') {
        const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.json,application/json,.png,image/png', multiple: true });
        input.addEventListener('change', () => hooks.importFiles([...input.files]));
        input.click();
    }
    if (v === 'merge') hooks.mergeBooks([]);
}

// ================================================================ one book

const FILTERS = {
    all: { label: 'ทั้งหมด', fn: () => true },
    key: { label: 'ติดเมื่อเจอคีย์', fn: e => entryStatus(e) === 'key' },
    constant: { label: 'ติดตลอด', fn: e => entryStatus(e) === 'constant' },
    off: { label: 'ปิดอยู่', fn: e => e.disable },
    warn: { label: 'มีคำเตือน', fn: e => entryWarnings(e, warnCtx()).length > 0 },
    nothai: { label: 'ไม่มีคีย์ไทย', fn: e => !(e.key ?? []).some(k => THAI.test(k)) },
};

export async function enterBook(name) {
    if (St.cur?.name !== name) {
        L.bookQ = ''; L.filter = 'all'; L.selecting = false; L.selected.clear(); L.limit = PAGE;
    }
    await St.openBook(name);
}

export function viewBook(v) {
    const book = St.cur;
    if (!book || book.name !== v.name) return { title: v.name, sub: 'กำลังโหลด…', body: '<div class="lm_empty"><span class="lm_spin"></span></div>' };
    const all = St.entryList();
    const wc = warnCtx();
    const list = all.filter(FILTERS[L.filter].fn).filter(e => entryMatches(e, L.bookQ));
    if (L.sort !== 'book') list.sort(SORTS[L.sort].fn);
    const tokens = all.filter(e => !e.disable).reduce((n, e) => n + estTokens(e.content), 0);
    const use = St.usage().get(v.name) ?? new Set();
    const cc = St.currentChar();
    const chatOpen = St.chatBook() !== null;
    const chip = (key, on, iconName, label, disabled = false) => `<button class="lm_linkchip ${on ? 'lm_on' : ''}" data-act="book-link" data-k="${key}" ${disabled ? 'disabled' : ''}>${icon(iconName)} ${esc(label)}${on ? ` ${icon('fa-check')}` : ''}</button>`;
    return {
        title: v.name,
        sub: `<span>${all.length} เอนทรี · ≈${fmt(tokens)} โทเคน</span> ${saveBadge()}`,
        actions: `
          <button class="lm_icon ${L.selecting ? 'lm_on' : ''}" data-act="book-select" title="เลือกหลายรายการ" aria-label="เลือกหลายรายการ">${icon('fa-list-check')}</button>
          <button class="lm_icon" data-act="bookmenu" data-name="${esc(v.name)}" aria-label="เมนูของเล่ม">${icon('fa-ellipsis-vertical')}</button>`,
        body: `
        <div class="lm_linkrow">
          ${chip('global', use.has('global'), 'fa-globe', 'Global')}
          ${cc ? chip('primary', use.has('primary'), 'fa-user', `หลักของ ${cc.ch.name}`) : ''}
          ${cc ? chip('extra', use.has('extra'), 'fa-paperclip', 'เล่มเสริม') : ''}
          ${chatOpen ? chip('chat', use.has('chat'), 'fa-comment', 'แชทนี้') : ''}
        </div>
        <div class="lm_toolbar">
          <div class="lm_search lm_grow">${icon('fa-magnifying-glass')}<input type="search" class="lm_input" placeholder="ค้นหาชื่อ คีย์ เนื้อหา…" value="${esc(L.bookQ)}" data-act="book-q" enterkeyhint="search"></div>
          <button class="lm_btn lm_sortbtn" data-act="book-sort" aria-label="เรียง">${icon('fa-arrow-down-wide-short')}<span>${SORTS[L.sort].label}</span></button>
        </div>
        <div class="lm_chiprow">${Object.entries(FILTERS).map(([k, f]) => {
            const n = k === 'all' ? all.length : all.filter(f.fn).length;
            return `<button class="lm_fchip ${L.filter === k ? 'lm_on' : ''}" data-act="book-filter" data-k="${k}" ${!n && k !== 'all' ? 'disabled' : ''}>${f.label} <b>${n}</b></button>`;
        }).join('')}</div>
        <div class="lm_entries">${list.length ? list.slice(0, L.limit).map(e => entryCard(e, wc)).join('') : `<div class="lm_empty">${icon('fa-feather')}<div>${all.length ? 'ไม่เจอเอนทรีที่ตรง' : 'เล่มนี้ยังว่าง กด + เพื่อเพิ่มเอนทรีแรก'}</div></div>`}</div>
        ${list.length > L.limit ? `<div class="lm_row lm_centerrow"><button class="lm_btn" data-act="book-more">${icon('fa-angles-down')} แสดงเพิ่ม (อีก ${list.length - L.limit})</button></div>` : ''}
        <div class="lm_bottom_pad"></div>
        ${L.selecting ? selectBar(list) : `<button class="lm_fab" data-act="entry-new" aria-label="เพิ่มเอนทรี">${icon('fa-plus')}</button>`}`,
    };
}

function entryCard(e, wc) {
    const st = entryStatus(e);
    const warns = entryWarnings(e, wc);
    const keys = e.key ?? [];
    const flags = [];
    if (e.preventRecursion) flags.push(`<span title="ไม่ลากเอนทรีอื่นต่อ">${icon('fa-link-slash')}</span>`);
    if (e.useProbability && Number(e.probability) < 100) flags.push(`<span title="ความน่าจะเป็น">${icon('fa-dice')} ${e.probability}%</span>`);
    if (e.group) flags.push(`<span title="Inclusion group">${icon('fa-layer-group')} ${esc(e.group)}</span>`);
    if (e.sticky) flags.push(`<span title="Sticky">${icon('fa-thumbtack')} ${e.sticky}</span>`);
    if ((e.keysecondary ?? []).length) flags.push(`<span title="มีคีย์รอง">${icon('fa-filter')} ${e.keysecondary.length}</span>`);
    const sel = L.selected.has(e.uid);
    return `
    <div class="lm_entry lm_st_${st} ${sel ? 'lm_sel' : ''}" data-act="${L.selecting ? 'entry-pick' : 'openentry'}" data-uid="${e.uid}" role="button" tabindex="0">
      ${L.selecting ? `<span class="lm_pickbox">${sel ? icon('fa-square-check') : icon('fa-square')}</span>` : ''}
      <div class="lm_grow lm_minw0">
        <div class="lm_entry_top">
          <span class="lm_stdot" title="${{ key: 'ติดเมื่อเจอคีย์', constant: 'ติดตลอด', off: 'ปิดอยู่', vector: 'Vector' }[st]}"></span>
          <span class="lm_entry_title">${esc(e.comment || '(ไม่มีชื่อ)')}</span>
          ${warns.length ? `<span class="lm_warnpill" title="${esc(warns.join('\n'))}">${icon('fa-triangle-exclamation')} ${warns.length}</span>` : ''}
        </div>
        ${st === 'constant' ? '<div class="lm_keys"><span class="lm_kchip lm_kconst">ติดตลอด</span></div>'
            : `<div class="lm_keys">${keys.length ? keys.slice(0, 6).map(k => `<span class="lm_kchip ${keyWarnings(k, wc).some(w => w.level !== 'info') ? 'lm_kwarn' : ''}">${esc(k)}</span>`).join('') + (keys.length > 6 ? `<span class="lm_kmore">+${keys.length - 6}</span>` : '') : '<span class="lm_kchip lm_kwarn">ไม่มีคีย์</span>'}</div>`}
        <div class="lm_entry_meta"><span>${esc(positionShort(e))}</span><span>#${e.order ?? 100}</span><span>≈${fmt(estTokens(e.content))} โทเคน</span>${flags.join('')}</div>
      </div>
      ${L.selecting ? '' : `<span data-stop>${switchHtml(`data-act="entry-toggle" data-uid="${e.uid}"`, !e.disable, e.disable ? 'เปิดใช้' : 'ปิดใช้')}</span>`}
    </div>`;
}

function selectBar(list) {
    const n = L.selected.size;
    const allOn = list.length && list.every(e => L.selected.has(e.uid));
    return `
    <div class="lm_selbar">
      <button class="lm_btn" data-act="sel-all">${icon(allOn ? 'fa-square-minus' : 'fa-square-check')} ${allOn ? 'ไม่เลือก' : 'เลือกทั้งหมด'}</button>
      <span class="lm_grow lm_center">${n} รายการ</span>
      <button class="lm_btn lm_primary" data-act="sel-actions" ${n ? '' : 'disabled'}>${icon('fa-wand-magic-sparkles')} ทำกับที่เลือก</button>
    </div>`;
}

async function bulkActions() {
    const uids = [...L.selected];
    const v = await sheet({
        title: `${uids.length} เอนทรีที่เลือก`,
        items: [
            { value: 'on', label: 'เปิดใช้', icon: 'fa-toggle-on' },
            { value: 'off', label: 'ปิดใช้', icon: 'fa-toggle-off' },
            { value: 'key', label: 'ให้ติดเมื่อเจอคีย์', icon: 'fa-key' },
            { value: 'constant', label: 'ให้ติดตลอด', icon: 'fa-circle' },
            { value: 'pos', label: 'ตั้งตำแหน่งใน prompt…', icon: 'fa-location-dot' },
            { value: 'order', label: 'ตั้ง order…', icon: 'fa-arrow-up-9-1' },
            { value: 'prevent', label: 'กันลูกโซ่ (ไม่ลากตัวอื่นต่อ)', icon: 'fa-link-slash' },
            { value: 'allow', label: 'เลิกกันลูกโซ่', icon: 'fa-link' },
            '-',
            { value: 'copy', label: 'คัดลอกไปเล่มอื่น…', icon: 'fa-copy' },
            { value: 'move', label: 'ย้ายไปเล่มอื่น…', icon: 'fa-arrow-right-arrow-left' },
            { value: 'delete', label: 'ลบ', icon: 'fa-trash', danger: true },
        ],
    });
    if (!v) return;
    const each = fn => { for (const uid of uids) { const e = St.getEntry(uid); if (e) fn(e); } St.touch(true); };
    if (v === 'on') each(e => { e.disable = false; });
    if (v === 'off') each(e => { e.disable = true; });
    if (v === 'key') each(e => { e.constant = false; e.disable = false; });
    if (v === 'constant') each(e => { e.constant = true; e.disable = false; });
    if (v === 'prevent') each(e => { e.preventRecursion = true; });
    if (v === 'allow') each(e => { e.preventRecursion = false; });
    if (v === 'pos') {
        const p = await sheet({ title: 'ใส่ตรงไหนใน prompt', items: POSITION_INFO.map(x => ({ value: x.value, label: x.label, hint: x.help })) });
        if (p === null) return;
        let depth = null;
        if (p === 4) { const d = await promptBox({ title: 'ความลึก (0 = ล่างสุดของแชท)', value: '4', ok: 'ตั้ง' }); if (d === null) return; depth = Math.max(0, Number(d) || 0); }
        each(e => { e.position = p; if (depth !== null) e.depth = depth; });
    }
    if (v === 'order') {
        const o = await promptBox({ title: 'ตั้ง order (เลขมาก = สำคัญกว่า)', value: '100', ok: 'ตั้ง' });
        if (o === null) return;
        each(e => { e.order = Number(o) || 0; });
    }
    if (v === 'copy' || v === 'move') {
        const target = await pickBook(St.bookNames().sort(collator.compare), { title: v === 'copy' ? 'คัดลอกไปเล่ม' : 'ย้ายไปเล่ม', exclude: [St.cur.name] });
        if (!target) return;
        const n = await St.copyEntriesTo(target, uids, { move: v === 'move' });
        toast.success(`${v === 'copy' ? 'คัดลอก' : 'ย้าย'} ${n} เอนทรีไป “${target}” แล้ว`);
        if (v === 'move') L.selected.clear();
    }
    if (v === 'delete') {
        if (!await confirmBox({ title: `ลบ ${uids.length} เอนทรี?`, text: 'ลบแล้วกู้คืนไม่ได้', danger: true, ok: 'ลบ' })) return;
        St.deleteEntries(uids);
        L.selected.clear();
    }
    shell.render();
}

// ================================================================ one entry

const tri = v => (v === true ? 'yes' : v === false ? 'no' : 'global');

export function viewEntry(v) {
    const e = St.cur?.name === v.name ? St.getEntry(v.uid) : null;
    if (!e) return { title: 'ไม่เจอเอนทรี', body: '<div class="lm_empty">เอนทรีนี้ถูกลบไปแล้ว</div>' };
    const st = entryStatus(e);
    const list = St.entryList();
    const i = list.findIndex(x => x.uid === e.uid);
    const pos = positionInfo(e.position);
    const adv = advancedSummary(e);
    return {
        title: e.comment || '(ไม่มีชื่อ)',
        titleId: 'lm_entry_title',
        sub: `<span>${esc(v.name)}</span> ${saveBadge()}`,
        actions: `
          <button class="lm_icon" data-act="entry-step" data-d="-1" ${i <= 0 ? 'disabled' : ''} aria-label="เอนทรีก่อนหน้า">${icon('fa-chevron-up')}</button>
          <button class="lm_icon" data-act="entry-step" data-d="1" ${i >= list.length - 1 ? 'disabled' : ''} aria-label="เอนทรีถัดไป">${icon('fa-chevron-down')}</button>
          <button class="lm_icon" data-act="entry-menu" aria-label="เมนูของเอนทรี">${icon('fa-ellipsis-vertical')}</button>`,
        body: `
        <section class="lm_card lm_sec">
          <label class="lm_label" for="lm_f_comment">ชื่อเอนทรี</label>
          <input id="lm_f_comment" class="lm_input" data-f="comment" value="${esc(e.comment ?? '')}" placeholder="เช่น ชื่อตัวละคร สถานที่ หรือหัวข้อ" enterkeyhint="next">
          <div class="lm_hint">ไว้ให้เราหาเจอ ไม่ได้ส่งให้โมเดล</div>
        </section>

        <section class="lm_card lm_sec">
          <div class="lm_label">ติดเมื่อไหร่</div>
          <div class="lm_seg lm_seg3" role="radiogroup">
            ${[['key', 'fa-key', 'เจอคีย์'], ['constant', 'fa-circle', 'ติดตลอด'], ['off', 'fa-power-off', 'ปิด']].map(([k, ic, lab]) =>
                `<button class="lm_segbtn lm_seg_${k} ${(st === k || (k === 'key' && st === 'vector')) ? 'lm_on' : ''}" data-act="e-status" data-v="${k}" role="radio" aria-checked="${st === k}">${icon(ic)} ${lab}</button>`).join('')}
          </div>
          <div class="lm_hint">${{
                key: 'เข้า prompt เฉพาะเทิร์นที่ข้อความล่าสุดมีคีย์ข้อใดข้อหนึ่ง',
                vector: 'เข้า prompt เมื่อเจอคีย์ หรือเมื่อ Vector Storage หาเจอว่าเนื้อหาเกี่ยว',
                constant: 'เข้า prompt ทุกเทิร์นโดยไม่ต้องเจอคีย์ กินโทเคนทุกเทิร์น ใช้กับเรื่องที่โมเดลต้องรู้ตลอด',
                off: 'ปิดอยู่ ไม่ถูกใส่เข้า prompt',
            }[st]}</div>
          <div class="lm_label lm_mt">คีย์ <small class="lm_dim">— ${st === 'constant' ? 'ตอนติดตลอดไม่ได้ใช้ เก็บไว้เผื่อเปลี่ยนกลับ' : 'คำที่ทำให้เอนทรีนี้ติด'}</small></div>
          <div class="lm_chipzone" data-zone="key">${chipBox(e, 'key')}</div>
          <div class="lm_hint">พิมพ์แล้วกด Enter หรือใส่ , คั่น · ใส่ทั้งชื่ออังกฤษและไทย เช่น <code>Cody</code> <code>โคดี้</code> · ใช้ regex ได้ เช่น <code>/โค(ดี้|ดี)/</code></div>
          <div data-zone="thaisug">${thaiSugBox(e)}</div>
          <details class="lm_more" ${(e.keysecondary ?? []).length ? 'open' : ''}>
            <summary>${icon('fa-filter')} เงื่อนไขเพิ่ม (คีย์รอง)${(e.keysecondary ?? []).length ? ` · ${e.keysecondary.length}` : ''}</summary>
            <select class="lm_input" data-f="selectiveLogic" data-type="num">${LOGIC_INFO.map(o => `<option value="${o.value}" ${Number(e.selectiveLogic ?? 0) === o.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>
            <div class="lm_chipzone" data-zone="keysecondary">${chipBox(e, 'keysecondary')}</div>
            <div class="lm_hint">เช่น คีย์ “Cody” + คีย์รอง “บาส, สนาม” แบบ “ต้องเจอคำใดคำหนึ่ง” = ติดเฉพาะตอนพูดถึง Cody เรื่องบาส</div>
          </details>
          <div class="lm_livetest" data-zone="live">${liveTest(e)}</div>
        </section>

        <section class="lm_card lm_sec">
          <div class="lm_label lm_row_between"><span>เนื้อหา</span><small class="lm_dim" data-zone="count">${countLine(e)}</small></div>
          <textarea class="lm_input lm_content" data-f="content" rows="8" placeholder="ข้อมูลที่จะส่งให้โมเดลเมื่อเอนทรีนี้ติด ใช้ {{char}} {{user}} ได้">${esc(e.content ?? '')}</textarea>
          <div class="lm_row lm_wrap" data-zone="condense">${condenseBar(e)}</div>
        </section>

        <section class="lm_card lm_sec">
          <div class="lm_label">ใส่ตรงไหนใน prompt</div>
          <div class="lm_poslist">${POSITION_INFO.map(p => `
            <button class="lm_pos ${pos.value === p.value ? 'lm_on' : ''}" data-act="e-pos" data-v="${p.value}">
              <span class="lm_pos_tag">${esc(p.short)}</span><span class="lm_grow"><b>${esc(p.label)}</b><small>${esc(p.help)}</small></span>
            </button>`).join('')}</div>
          ${pos.value === 4 ? `
            <div class="lm_two">
              <label><span class="lm_label">ความลึก</span><input class="lm_input" type="number" min="0" inputmode="numeric" data-f="depth" data-type="num" value="${e.depth ?? 4}"></label>
              <label><span class="lm_label">ส่งในนามของ</span><select class="lm_input" data-f="role" data-type="num">${ROLE_INFO.map(r => `<option value="${r.value}" ${Number(e.role ?? 0) === r.value ? 'selected' : ''}>${r.label}</option>`).join('')}</select></label>
            </div>` : ''}
          ${pos.value === 7 ? `<label><span class="lm_label">ชื่อ Outlet</span><input class="lm_input" data-f="outletName" value="${esc(e.outletName ?? '')}" placeholder="เช่น villains"></label><div class="lm_hint">แล้วใส่ <code>{{outlet::${esc(e.outletName || 'ชื่อ')}}}</code> ไว้ใน prompt</div>` : ''}
          <label class="lm_inline_field"><span class="lm_label">Order</span><input class="lm_input lm_num" type="number" inputmode="numeric" data-f="order" data-type="num" value="${e.order ?? 100}"></label>
          <div class="lm_hint">เลขมาก = สำคัญกว่า: ได้งบโทเคนก่อน และอยู่ล่างกว่า (ใกล้ข้อความล่าสุด) ในตำแหน่งเดียวกัน</div>
        </section>

        <section class="lm_card lm_sec">
          <div class="lm_label">ขั้นสูง</div>
          ${advGroup('prob', 'fa-dice', 'ความน่าจะเป็น', adv.prob, `
            <label class="lm_checkrow"><input type="checkbox" data-f="useProbability" data-type="check" ${e.useProbability !== false ? 'checked' : ''}><span>ใช้ความน่าจะเป็น</span></label>
            <div class="lm_rangeRow">${rangeHtml('data-f="probability" data-type="num"', e.probability ?? 100, 0, 100)}<output class="lm_valpill">${e.probability ?? 100}%</output></div>
            <div class="lm_hint">ติดแล้วยังต้องสุ่มผ่านก่อนถึงจะเข้า prompt เช่น 30% = ติด 3 ใน 10 ครั้ง ใช้ทำเหตุการณ์สุ่ม</div>`)}
          ${advGroup('group', 'fa-layer-group', 'กลุ่ม (Inclusion Group)', adv.group, `
            <label><span class="lm_label">ชื่อกลุ่ม</span><input class="lm_input" data-f="group" value="${esc(e.group ?? '')}" placeholder="เช่น อารมณ์ของ Cody (คั่นหลายกลุ่มด้วย ,)"></label>
            <div class="lm_hint">เอนทรีกลุ่มเดียวกันจะติดได้ทีละ 1 ตัวต่อเทิร์น ที่เหลือถูกตัด ใช้กับเรื่องที่ขัดกันเอง หรือกันติดพร้อมกันหลายตัว</div>
            <div class="lm_two">
              <label><span class="lm_label">น้ำหนัก</span><input class="lm_input" type="number" inputmode="numeric" data-f="groupWeight" data-type="num" value="${e.groupWeight ?? 100}"></label>
              <label><span class="lm_label">ให้คะแนน</span>${triSelect('useGroupScoring', e.useGroupScoring)}</label>
            </div>
            <label class="lm_checkrow"><input type="checkbox" data-f="groupOverride" data-type="check" ${e.groupOverride ? 'checked' : ''}><span>ให้ตัวนี้ชนะในกลุ่ม (Prioritize, ใช้ order ตัดสิน)</span></label>`)}
          ${advGroup('timed', 'fa-hourglass-half', 'เวลา (Sticky / Cooldown / Delay)', adv.timed, `
            <div class="lm_three">
              <label><span class="lm_label">Sticky</span><input class="lm_input" type="number" min="0" inputmode="numeric" data-f="sticky" data-type="numnull" value="${e.sticky ?? ''}" placeholder="—"></label>
              <label><span class="lm_label">Cooldown</span><input class="lm_input" type="number" min="0" inputmode="numeric" data-f="cooldown" data-type="numnull" value="${e.cooldown ?? ''}" placeholder="—"></label>
              <label><span class="lm_label">Delay</span><input class="lm_input" type="number" min="0" inputmode="numeric" data-f="delay" data-type="numnull" value="${e.delay ?? ''}" placeholder="—"></label>
            </div>
            <div class="lm_hint"><b>Sticky</b>: ติดแล้วอยู่ต่ออีกกี่ข้อความ · <b>Cooldown</b>: หลังจบแล้วห้ามติดอีกกี่ข้อความ · <b>Delay</b>: แชทต้องยาวอย่างน้อยกี่ข้อความถึงจะติดได้ · เว้นว่าง = ไม่ใช้</div>`)}
          ${advGroup('rec', 'fa-link', 'ลูกโซ่ (Recursion)', adv.rec, `
            <label class="lm_checkrow"><input type="checkbox" data-f="preventRecursion" data-type="check" ${e.preventRecursion ? 'checked' : ''}><span>ไม่ลากตัวอื่นต่อ <small>(Prevent further recursion) — เนื้อหาของตัวนี้จะไม่ถูกเอาไปสแกนหาคีย์อื่น</small></span></label>
            <label class="lm_checkrow"><input type="checkbox" data-f="excludeRecursion" data-type="check" ${e.excludeRecursion ? 'checked' : ''}><span>ห้ามติดจากลูกโซ่ <small>(Non-recursable) — ติดได้จากแชทเท่านั้น</small></span></label>
            <label><span class="lm_label">รอลูกโซ่รอบที่ <small class="lm_dim">(Delay until recursion, เว้นว่าง = ไม่ใช้)</small></span><input class="lm_input lm_num" type="number" min="0" inputmode="numeric" data-f="delayUntilRecursion" data-type="numnull" value="${e.delayUntilRecursion ? Number(e.delayUntilRecursion) : ''}" placeholder="—"></label>`)}
          ${advGroup('scan', 'fa-magnifying-glass', 'การสแกน', adv.scan, `
            <label><span class="lm_label">สแกนย้อนหลังกี่ข้อความ <small class="lm_dim">(เว้นว่าง = ตามค่ารวม)</small></span><input class="lm_input lm_num" type="number" min="0" inputmode="numeric" data-f="scanDepth" data-type="numnull" value="${e.scanDepth ?? ''}" placeholder="—"></label>
            <div class="lm_two">
              <label><span class="lm_label">แยกตัวพิมพ์เล็ก/ใหญ่</span>${triSelect('caseSensitive', e.caseSensitive)}</label>
              <label><span class="lm_label">จับทั้งคำ</span>${triSelect('matchWholeWords', e.matchWholeWords)}</label>
            </div>
            <div class="lm_label lm_mt">หาคีย์ในส่วนเหล่านี้ด้วย</div>
            ${[['matchPersonaDescription', 'คำอธิบาย Persona'], ['matchCharacterDescription', 'คำอธิบายตัวละคร'], ['matchCharacterPersonality', 'บุคลิกตัวละคร'], ['matchCharacterDepthPrompt', "Character's Note"], ['matchScenario', 'Scenario'], ['matchCreatorNotes', 'Creator Notes']]
                .map(([f, lab]) => `<label class="lm_checkrow"><input type="checkbox" data-f="${f}" data-type="check" ${e[f] ? 'checked' : ''}><span>${lab}</span></label>`).join('')}`)}
          ${advGroup('filter', 'fa-user-check', 'ใช้เฉพาะบางตัวละคร', adv.filter, `
            <div class="lm_chipzone" data-zone="charfilter">${charFilterBox(e)}</div>
            <label class="lm_checkrow"><input type="checkbox" data-act="e-cfx" ${e.characterFilter?.isExclude ? 'checked' : ''}><span>กลับด้าน: ใช้กับทุกตัว <b>ยกเว้น</b> ตัวที่เลือก</span></label>
            <div class="lm_hint">ว่างไว้ = ใช้กับทุกตัวละคร มีประโยชน์ในแชทกลุ่มหรือเล่ม Global</div>`)}
          ${advGroup('trig', 'fa-bolt', 'ทำงานเฉพาะตอน', adv.trig, `
            ${TRIGGER_INFO.map(t => `<label class="lm_checkrow"><input type="checkbox" data-act="e-trig" data-v="${t.value}" ${(e.triggers ?? []).includes(t.value) ? 'checked' : ''}><span>${esc(t.label)}</span></label>`).join('')}
            <div class="lm_hint">ไม่เลือกเลย = ทำงานทุกแบบ</div>`)}
          ${advGroup('other', 'fa-sliders', 'อื่น ๆ', adv.other, `
            <label class="lm_checkrow"><input type="checkbox" data-f="ignoreBudget" data-type="check" ${e.ignoreBudget ? 'checked' : ''}><span>ไม่นับงบโทเคน <small>— ใส่เสมอแม้งบเต็ม</small></span></label>
            <label class="lm_checkrow"><input type="checkbox" data-f="vectorized" data-type="check" ${e.vectorized ? 'checked' : ''}><span>ให้ Vector Storage หาได้ด้วย <small>— ต้องเปิด Vector Storage ไว้</small></span></label>
            <label><span class="lm_label">Automation ID <small class="lm_dim">(สำหรับ Quick Reply)</small></span><input class="lm_input" data-f="automationId" value="${esc(e.automationId ?? '')}"></label>`)}
        </section>

        <div class="lm_row lm_wrap lm_entry_foot">
          <button class="lm_btn" data-act="entry-dup">${icon('fa-clone')} ทำสำเนา</button>
          <button class="lm_btn lm_btn_danger" data-act="entry-del">${icon('fa-trash')} ลบ</button>
        </div>
        <div class="lm_bottom_pad"></div>`,
    };
}

function advGroup(id, ic, label, summary, inner) {
    const open = advOpen.has(id);
    return `<details class="lm_adv" data-adv="${id}" ${open ? 'open' : ''}><summary>${icon(ic)} <span class="lm_grow">${label}</span>${summary ? `<span class="lm_advsum">${esc(summary)}</span>` : ''}</summary><div class="lm_advbody">${inner}</div></details>`;
}
const advOpen = new Set();

function advancedSummary(e) {
    return {
        prob: e.useProbability !== false && Number(e.probability ?? 100) < 100 ? `${e.probability}%` : '',
        group: e.group ? e.group : '',
        timed: [e.sticky && `sticky ${e.sticky}`, e.cooldown && `cd ${e.cooldown}`, e.delay && `delay ${e.delay}`].filter(Boolean).join(' · '),
        rec: [e.preventRecursion && 'ไม่ลากต่อ', e.excludeRecursion && 'ห้ามติดจากลูกโซ่', e.delayUntilRecursion && `รอรอบ ${Number(e.delayUntilRecursion)}`].filter(Boolean).join(' · '),
        scan: [e.scanDepth !== null && e.scanDepth !== undefined && `ลึก ${e.scanDepth}`, e.caseSensitive !== null && e.caseSensitive !== undefined && 'ตัวพิมพ์', e.matchWholeWords !== null && e.matchWholeWords !== undefined && 'ทั้งคำ'].filter(Boolean).join(' · '),
        filter: (e.characterFilter?.names ?? []).length ? `${e.characterFilter.isExclude ? 'ยกเว้น ' : ''}${e.characterFilter.names.length} ตัว` : '',
        trig: (e.triggers ?? []).length ? `${e.triggers.length} แบบ` : '',
        other: [e.ignoreBudget && 'ไม่นับงบ', e.vectorized && 'vector'].filter(Boolean).join(' · '),
    };
}

function triSelect(field, v) {
    const t = tri(v);
    return `<select class="lm_input" data-f="${field}" data-type="tri">
      <option value="global" ${t === 'global' ? 'selected' : ''}>ตามค่ารวม</option>
      <option value="yes" ${t === 'yes' ? 'selected' : ''}>ใช่</option>
      <option value="no" ${t === 'no' ? 'selected' : ''}>ไม่</option></select>`;
}

function chipBox(e, field) {
    const keys = e[field] ?? [];
    const wc = warnCtx();
    const warns = [];
    const chips = keys.map((k, i) => {
        const w = field === 'key' ? keyWarnings(k, wc) : [];
        const lvl = w.some(x => x.level === 'bad') ? 'bad' : w.some(x => x.level === 'warn') ? 'warn' : w.length ? 'info' : '';
        for (const x of w) warns.push(`<li class="lm_w_${x.level}"><b>${esc(k)}</b> — ${esc(x.text)}</li>`);
        const isThai = field === 'key' && THAI.test(k);
        const first = isThai && keys.find(x => THAI.test(x)) === k;
        const star = isThai ? `<button class="lm_chipstar ${first ? 'lm_on' : ''}" data-act="chip-star" data-i="${i}" title="${first ? 'ตัวสะกดที่ใช้ในอภิธาน' : 'ใช้เป็นตัวสะกดในอภิธาน'}" aria-label="ใช้ ${esc(k)} เป็นตัวสะกดในอภิธาน" ${first ? 'disabled' : ''}>${icon('fa-star')}</button>` : '';
        return `<span class="lm_chip ${lvl ? `lm_chip_${lvl}` : ''} ${isThai ? 'lm_chip_th' : THAI.test(k) ? 'lm_chip_th' : ''}">${star}${esc(k)}<button data-act="chip-x" data-field="${field}" data-i="${i}" aria-label="ลบคีย์ ${esc(k)}">${icon('fa-xmark')}</button></span>`;
    }).join('');
    return `<div class="lm_chipbox" data-field="${field}">${chips}<input class="lm_chipin" data-act="chip-in" data-field="${field}" placeholder="${keys.length ? 'เพิ่ม…' : field === 'key' ? 'พิมพ์คีย์…' : 'พิมพ์คีย์รอง…'}" enterkeyhint="enter" autocapitalize="off" autocomplete="off"></div>
      ${warns.length ? `<ul class="lm_keywarn">${warns.join('')}</ul>` : ''}`;
}

function charFilterBox(e) {
    const list = e.characterFilter?.names ?? [];
    const all = (St.ctx().characters ?? []).map(c => c.name).filter(Boolean);
    return `<div class="lm_chipbox">${list.map((n, i) => `<span class="lm_chip">${esc(n)}<button data-act="cf-x" data-i="${i}" aria-label="เอาออก">${icon('fa-xmark')}</button></span>`).join('')}
      <input class="lm_chipin" data-act="cf-in" list="lm_charlist" placeholder="ชื่อตัวละคร…" autocomplete="off"></div>
      <datalist id="lm_charlist">${[...new Set(all)].sort(collator.compare).map(n => `<option value="${esc(n)}">`).join('')}</datalist>`;
}

function liveTest(e) {
    const text = St.chatSample();
    if (!text) return '';
    const st = entryStatus(e);
    if (st === 'off') return `${icon('fa-comment-slash')} ปิดอยู่`;
    if (st === 'constant') return `<span class="lm_ok">${icon('fa-circle-check')}</span> ข้อความล่าสุดในแชท: ติด (ติดตลอด)`;
    const W = St.WIref;
    const k = firingKey(e, text, { names: names(), caseSensitive: !!W.world_info_case_sensitive, wholeWords: !!W.world_info_match_whole_words });
    return k !== null ? `<span class="lm_ok">${icon('fa-circle-check')}</span> ข้อความล่าสุดในแชท: ติดด้วยคีย์ “${esc(k)}”`
        : `<span class="lm_no">${icon('fa-circle-xmark')}</span> ข้อความล่าสุดในแชท: ไม่ติด`;
}

const tokenCache = new Map(); // content -> real token count
function countLine(e) {
    const c = String(e.content ?? '');
    const real = tokenCache.get(c);
    return `${fmt([...c].length)} ตัวอักษร · ${real !== undefined && real !== null ? `${fmt(real)}` : `≈${fmt(estTokens(c))}`} โทเคน`;
}
let countTimer = null;
function scheduleCount(e) {
    clearTimeout(countTimer);
    countTimer = setTimeout(async () => {
        const c = String(e.content ?? '');
        if (!tokenCache.has(c)) {
            const n = await St.countTokens(c);
            if (tokenCache.size > 200) tokenCache.clear();
            tokenCache.set(c, n);
        }
        zone('count', countLine(e));
    }, 500);
}

function zone(name, html) {
    const el = shell.root?.querySelector(`[data-zone="${name}"]`);
    if (el) el.innerHTML = html;
}

export function saveBadge() {
    const c = St.cur;
    if (!c) return '';
    const [cls, ic, text] = c.error ? ['lm_sv_err', 'fa-triangle-exclamation', 'บันทึกไม่สำเร็จ'] : c.saving ? ['lm_sv_busy', 'fa-rotate', 'กำลังบันทึก…'] : c.dirty ? ['lm_sv_dirty', 'fa-pen', 'กำลังแก้'] : c.savedAt ? ['lm_sv_ok', 'fa-check', 'บันทึกแล้ว'] : ['', '', ''];
    return `<span class="lm_savestate ${cls}" title="${esc(c.error || '')}">${ic ? `${icon(ic)} ${text}` : ''}</span>`;
}
St.onSaveState(() => { shell.root?.querySelectorAll('.lm_savestate').forEach(el => { el.outerHTML = saveBadge(); }); });

/** Focus a field after the next render (new entry → title). */
export function focusAfterRender() {
    if (!L.focus) return;
    const el = shell.root?.querySelector(L.focus);
    L.focus = null;
    if (el) { el.focus(); if (el.select) el.select(); }
}
/** Grow textareas to their content. */
export function autosize(root) {
    root?.querySelectorAll('textarea.lm_content').forEach(t => { t.style.height = 'auto'; t.style.height = `${Math.min(window.innerHeight * 0.7, t.scrollHeight + 4)}px`; });
}

// ================================================================ AI helpers in the entry editor

const sug = new Map();       // "book#uid" -> { busy, label, error, rec: entrySuggestions(), fromCache }
const aiBusy = new Map();    // "book#uid" -> what is running ("condense")
const hasBackup = new Map(); // "book#uid" -> true/false once known
const ekey = e => `${St.cur?.name}#${e.uid}`;

function thaiSugBox(e) {
    const s = sug.get(ekey(e));
    const btn = `<button class="lm_btn lm_ai" data-act="e-thai" ${s?.busy ? 'disabled' : ''}>${s?.busy ? `<span class="lm_spin lm_spin_sm"></span> กำลังถาม ${esc(s.label || 'AI')}…` : `${icon('fa-wand-magic-sparkles')} ให้ AI เสนอคีย์ไทย`}</button>`;
    if (!s || s.busy) return `<div class="lm_row">${btn}</div>`;
    if (s.error) return `<div class="lm_row lm_wrap">${btn}</div><div class="lm_warn">${icon('fa-triangle-exclamation')} ${esc(s.error)}</div>`;
    const all = St.entryList();
    const wc = warnCtx();
    const r = s.rec;
    const group = (title, list, hint = '') => list.length ? `
      <div class="lm_suggroup"><div class="lm_sugtitle">${title}${hint ? ` <small>${hint}</small>` : ''}</div>
        <div class="lm_sugchips">${list.map(k => {
            const w = vetThaiKey(k, e, all, wc);
            const added = (e.key ?? []).includes(k);
            return `<button class="lm_sugchip ${added ? 'lm_added' : ''} ${w.length ? 'lm_sugwarn' : ''}" data-act="e-sugadd" data-k="${esc(k)}" ${added ? 'disabled' : ''} title="${esc(w.map(x => x.text).join('\n'))}">${icon(added ? 'fa-check' : 'fa-plus')} ${esc(k)}${w.length ? ` ${icon('fa-triangle-exclamation')}` : ''}</button>`;
        }).join('')}</div></div>` : '';
    const every = [...r.origin, ...r.english, ...r.nick, ...r.translated];
    const warned = every.map(k => [k, vetThaiKey(k, e, all, wc)]).filter(([, w]) => w.length);
    const easy = [...r.origin, ...r.english, ...r.nick].filter(k => !(e.key ?? []).includes(k) && !vetThaiKey(k, e, all, wc).length);
    return `
    <div class="lm_sugbox">
      ${group(r.langs.length ? `ตามภาษาต้นทาง (${r.langs.map(l => esc(LANG_LABEL[l] ?? l)).join('/')})` : 'ถอดเสียง', r.origin)}${group('อ่านแบบอังกฤษ', r.english)}${group('ชื่อเล่น / คำเรียก', r.nick)}${group('แปล', r.translated, 'เลือกเพิ่มเอง')}
      ${!every.length ? '<div class="lm_dim">AI ไม่มีคีย์ใหม่ให้</div>' : ''}
      ${warned.length ? `<ul class="lm_keywarn">${warned.map(([k, w]) => `<li class="lm_w_warn"><b>${esc(k)}</b> — ${esc(w.map(x => x.text).join(' · '))}</li>`).join('')}</ul>` : ''}
      <div class="lm_hint">แตะ ${icon('fa-star')} บนชิปคีย์ไทยด้านบน เพื่อเลือกตัวสะกดที่ใช้ในอภิธาน${s.fromCache ? ' · ชื่อนี้เคยถามแล้ว ใช้คำตอบเดิม ไม่เสียโควต้า' : ''}</div>
      <div class="lm_row lm_wrap">
        ${easy.length ? `<button class="lm_btn lm_primary" data-act="e-sugall">${icon('fa-plus')} เพิ่มที่แนะนำ (${easy.length})</button>` : ''}
        ${btn.replace('ให้ AI เสนอคีย์ไทย', 'ถามใหม่')}
      </div>
    </div>`;
}

async function suggestThai(e, { fresh = false } = {}) {
    const k = ekey(e);
    const cur = { busy: true, label: '' };
    sug.set(k, cur);
    zone('thaisug', thaiSugBox(e));
    const own = properNames(e);
    // one-word names that are part of a full name are read off the full name's answer
    const { names, derived } = own.length ? collectNames([e]) : { names: [], derived: new Map() };
    const list = (names.length ? names : [String(e.comment || e.key?.[0] || '').trim()].filter(Boolean).map(n => ({ name: n, lower: n.toLowerCase() })))
        .map((n, id) => ({ id, name: n.name, lower: n.lower, ctx: '' }));
    const wanted = own.length ? own.map(n => n.toLowerCase()) : list.map(n => n.lower);
    try {
        if (!list.length) throw new Error('เอนทรีนี้ไม่มีชื่อให้ถอดเสียง');
        const cache = await nameCache();
        let results = new Map([...cache].filter(([k]) => wanted.includes(k)));
        const fromCache = !fresh && list.every(n => results.has(n.lower));
        if (!fromCache) {
            // the editor sends the content too, so nicknames can be found
            results = await ask({
                task: 'keys', system: NAME_SYSTEM, user: nameRequest(list, { context: e.content }), maxTokens: 200 * list.length + 400,
                accept: text => parseNameReply(text, list),
                onTry: label => { cur.label = label; if (ekey(curEntry() ?? {}) === k) zone('thaisug', thaiSugBox(e)); },
            });
            await rememberNames(results);
        }
        deriveNames(results, derived);
        sug.set(k, { rec: entrySuggestions(e, wanted, results), fromCache });
    } catch (err) {
        sug.set(k, { error: `AI ตอบไม่ได้: ${String(err?.message ?? err).split('\n')[0]}` });
    }
    if (curEntry()?.uid === e.uid) zone('thaisug', thaiSugBox(e));
}

function condenseBar(e) {
    const k = ekey(e);
    const busy = aiBusy.get(k);
    const long = estTokens(e.content) > LONG_TOKENS;
    if (!hasBackup.has(k)) backupList(`entry:${k}`).then(l => { hasBackup.set(k, l.length > 0); if (curEntry()?.uid === e.uid && l.length) zone('condense', condenseBar(e)); }).catch(() => hasBackup.set(k, false));
    return `
      <button class="lm_btn lm_ai ${long ? 'lm_ai_hot' : ''}" data-act="e-condense" ${busy || !String(e.content ?? '').trim() ? 'disabled' : ''}>${busy ? `<span class="lm_spin lm_spin_sm"></span> ${esc(busy)}` : `${icon('fa-compress')} ให้ AI ย่อเนื้อหา`}</button>
      ${hasBackup.get(k) ? `<button class="lm_btn" data-act="e-restore">${icon('fa-clock-rotate-left')} เนื้อหาก่อนย่อ</button>` : ''}
      ${long && !busy ? `<span class="lm_dim">ยาว ≈${fmt(estTokens(e.content))} โทเคน</span>` : ''}`;
}

async function condenseEntry(e) {
    const k = ekey(e);
    const ratio = Number(settings().condenseRatio) || 0.5;
    aiBusy.set(k, 'กำลังถาม AI…');
    zone('condense', condenseBar(e));
    let text = null;
    try {
        text = await ask({
            task: 'condense', system: CONDENSE_SYSTEM, user: condenseRequest(e, ratio), maxTokens: Math.max(600, Math.round(estTokens(e.content) * 1.2)),
            accept: out => { const t = cleanCondensed(out, e.content); if (!t) throw new Error('ได้เนื้อหาที่ใช้ไม่ได้ (ยาวเท่าเดิม สั้นเกินไป หรือ {{char}}/{{user}} หาย)'); return t; },
            onTry: label => { aiBusy.set(k, `กำลังถาม ${label}…`); if (curEntry()?.uid === e.uid) zone('condense', condenseBar(e)); },
        });
    } catch (err) {
        toast.error(String(err?.message ?? err).split('\n')[0], 'ย่อไม่สำเร็จ');
    }
    aiBusy.delete(k);
    if (curEntry()?.uid === e.uid) zone('condense', condenseBar(e));
    if (!text) return;
    const before = estTokens(e.content), after = estTokens(text);
    const edited = await previewBox({
        title: 'เนื้อหาที่ย่อแล้ว',
        text: `≈${fmt(before)} → <b>≈${fmt(after)}</b> โทเคน (เหลือ ${Math.round(after / Math.max(1, before) * 100)}%) · แก้ต่อในกล่องนี้ได้ เนื้อหาเดิมจะเก็บสำรองไว้ในเบราว์เซอร์`,
        value: text, ok: 'ใช้เนื้อหานี้',
    });
    if (edited === null) return;
    try { await backupPut(`entry:${k}`, { comment: e.comment, content: e.content }); hasBackup.set(k, true); } catch { /* no IndexedDB */ }
    e.content = edited;
    St.touch(true);
    shell.render();
    toast.success('ย่อแล้ว');
}

async function restoreContent(e) {
    const list = await backupList(`entry:${ekey(e)}`).catch(() => []);
    if (!list.length) return;
    const items = list.map((b, i) => ({ value: i, label: new Date(b.at).toLocaleString(), hint: `≈${fmt(estTokens(b.data.content))} โทเคน · ${String(b.data.content).slice(0, 60)}…`, icon: 'fa-clock-rotate-left' }));
    const i = await sheet({ title: 'กู้เนื้อหาก่อนย่อ', sub: 'เลือกฉบับที่จะใช้แทนเนื้อหาตอนนี้', items });
    if (i === null) return;
    await backupPut(`entry:${ekey(e)}`, { comment: e.comment, content: e.content }).catch(() => {});
    e.content = list[i].data.content;
    St.touch(true);
    shell.render();
    toast.success('กู้เนื้อหาเดิมแล้ว');
}

// ================================================================ actions

function curEntry() {
    const v = top();
    return v?.v === 'entry' ? St.getEntry(v.uid) : null;
}

function addChips(field, raw) {
    const e = curEntry();
    if (!e) return;
    const add = cleanKeys([raw]);
    if (!add.length) return;
    if (field === 'charfilter') {
        e.characterFilter = { isExclude: false, names: [], tags: [], ...(e.characterFilter ?? {}) };
        e.characterFilter.names = [...new Set([...e.characterFilter.names, ...add])];
        St.touch();
        zone('charfilter', charFilterBox(e));
        shell.root?.querySelector('[data-zone="charfilter"] .lm_chipin')?.focus();
        return;
    }
    e[field] = cleanKeys([...(e[field] ?? []), ...add]);
    if (field === 'keysecondary') e.selective = true;
    St.touch();
    zone(field, chipBox(e, field));
    zone('live', liveTest(e));
    shell.root?.querySelector(`[data-zone="${field}"] .lm_chipin`)?.focus();
}

act('click', {
    'lib-new': () => newMenu(),
    openbook: async el => { push({ v: 'book', name: el.dataset.name }); },
    bookmenu: el => bookMenu(el.dataset.name),
    'book-select': () => { L.selecting = !L.selecting; L.selected.clear(); shell.render(); },
    'book-filter': el => { L.filter = el.dataset.k; L.limit = PAGE; shell.render(); },
    'book-more': () => { L.limit += PAGE * 2; shell.render(); },
    'book-sort': async () => {
        const v = await sheet({ title: 'เรียงตาม', items: Object.entries(SORTS).map(([k, s]) => ({ value: k, label: s.label, on: L.sort === k })) });
        if (v) { L.sort = v; shell.render(); }
    },
    'book-link': async el => {
        const name = St.cur?.name;
        const use = St.usage().get(name) ?? new Set();
        const k = el.dataset.k;
        try {
            if (k === 'global') St.setGlobal(name, !use.has('global'));
            if (k === 'primary') await St.setPrimary(use.has('primary') ? '' : name);
            if (k === 'extra') St.setExtra(name, !use.has('extra'));
            if (k === 'chat') await St.setChatBook(use.has('chat') ? '' : name);
        } catch (e) { toast.error(String(e?.message ?? e)); }
        shell.render();
    },
    'entry-new': () => {
        const e = St.addEntry({ comment: '', key: [], content: '' });
        L.focus = '#lm_f_comment';
        push({ v: 'entry', name: St.cur.name, uid: e.uid });
    },
    openentry: el => push({ v: 'entry', name: St.cur.name, uid: Number(el.dataset.uid) }),
    'entry-pick': el => {
        const uid = Number(el.dataset.uid);
        L.selected.has(uid) ? L.selected.delete(uid) : L.selected.add(uid);
        shell.render();
    },
    'sel-all': () => {
        const list = St.entryList().filter(FILTERS[L.filter].fn).filter(e => entryMatches(e, L.bookQ));
        const allOn = list.every(e => L.selected.has(e.uid));
        if (allOn) L.selected.clear(); else list.forEach(e => L.selected.add(e.uid));
        shell.render();
    },
    'sel-actions': () => bulkActions(),
    'entry-step': el => {
        const v = top();
        const list = St.entryList();
        const i = list.findIndex(x => x.uid === v.uid) + Number(el.dataset.d);
        if (list[i]) { St.flush(); UI.stack[UI.stack.length - 1] = { v: 'entry', name: v.name, uid: list[i].uid }; shell.render(); }
    },
    'entry-menu': async () => {
        const v = top();
        const e = St.getEntry(v.uid);
        if (!e) return;
        const r = await sheet({
            title: e.comment || '(ไม่มีชื่อ)',
            items: [
                { value: 'dup', label: 'ทำสำเนา', icon: 'fa-clone' },
                { value: 'up', label: 'เลื่อนขึ้นในเล่ม', icon: 'fa-arrow-up' },
                { value: 'down', label: 'เลื่อนลงในเล่ม', icon: 'fa-arrow-down' },
                { value: 'copy', label: 'คัดลอกไปเล่มอื่น…', icon: 'fa-copy' },
                { value: 'move', label: 'ย้ายไปเล่มอื่น…', icon: 'fa-arrow-right-arrow-left' },
                '-',
                { value: 'del', label: 'ลบ', icon: 'fa-trash', danger: true },
            ],
        });
        if (r === 'dup') return dupEntry();
        if (r === 'up' || r === 'down') { St.moveEntry(e.uid, r === 'up' ? -1 : 1); toast.success(r === 'up' ? 'เลื่อนขึ้นแล้ว' : 'เลื่อนลงแล้ว'); return shell.render(); }
        if (r === 'copy' || r === 'move') {
            const target = await pickBook(St.bookNames().sort(collator.compare), { exclude: [St.cur.name], title: r === 'copy' ? 'คัดลอกไปเล่ม' : 'ย้ายไปเล่ม' });
            if (!target) return;
            await St.copyEntriesTo(target, [e.uid], { move: r === 'move' });
            toast.success(`${r === 'copy' ? 'คัดลอก' : 'ย้าย'}ไป “${target}” แล้ว`);
            if (r === 'move') back();
            return;
        }
        if (r === 'del') return delEntry();
    },
    'entry-dup': () => dupEntry(),
    'e-thai': el => { const e = curEntry(); if (e) suggestThai(e, { fresh: /ถามใหม่/.test(el.textContent) }); },
    'chip-star': el => {
        const e = curEntry();
        if (!e) return;
        const k = (e.key ?? [])[Number(el.dataset.i)];
        if (!k) return;
        e.key = preferThaiKey(e.key, k);
        St.touch();
        zone('key', chipBox(e, 'key'));
        toast.info(`ใช้ “${k}” เป็นตัวสะกดในอภิธาน (อัปเดตอภิธานจากเมนู ⋯ ของเล่ม)`, '', { timeOut: 3500 });
    },
    'e-sugadd': el => {
        const e = curEntry();
        if (!e) return;
        e.key = cleanKeys([...(e.key ?? []), el.dataset.k]);
        St.touch();
        zone('key', chipBox(e, 'key')); zone('thaisug', thaiSugBox(e)); zone('live', liveTest(e));
    },
    'e-sugall': () => {
        const e = curEntry();
        const s = e && sug.get(ekey(e));
        if (!s?.rec) return;
        const all = St.entryList();
        const add = [...s.rec.origin, ...s.rec.english, ...s.rec.nick].filter(k => !vetThaiKey(k, e, all, warnCtx()).length);
        const hadThai = (e.key ?? []).some(k => THAI.test(k));
        e.key = cleanKeys([...(e.key ?? []), ...add]);
        // no Thai key before: the first origin-language spelling becomes the glossary spelling
        if (!hadThai && add.length) e.key = preferThaiKey(e.key, add[0]);
        St.touch();
        zone('key', chipBox(e, 'key')); zone('thaisug', thaiSugBox(e)); zone('live', liveTest(e));
    },
    'e-condense': () => { const e = curEntry(); if (e) condenseEntry(e); },
    'e-restore': () => { const e = curEntry(); if (e) restoreContent(e); },
    'entry-del': () => delEntry(),
    'e-status': el => {
        const e = curEntry();
        if (!e) return;
        const v = el.dataset.v;
        e.disable = v === 'off';
        if (v !== 'off') e.constant = v === 'constant';
        St.touch(true);
        shell.render();
    },
    'e-pos': el => {
        const e = curEntry();
        if (!e) return;
        e.position = Number(el.dataset.v);
        St.touch(true);
        shell.render();
    },
    'chip-x': el => {
        const e = curEntry();
        const f = el.dataset.field;
        if (!e) return;
        e[f] = (e[f] ?? []).filter((_, i) => i !== Number(el.dataset.i));
        if (f === 'keysecondary' && !e[f].length) e.selective = false;
        St.touch();
        zone(f, chipBox(e, f));
        zone('live', liveTest(e));
    },
    'cf-x': el => {
        const e = curEntry();
        if (!e?.characterFilter) return;
        e.characterFilter.names = e.characterFilter.names.filter((_, i) => i !== Number(el.dataset.i));
        St.touch();
        zone('charfilter', charFilterBox(e));
    },
});

async function dupEntry() {
    const e = curEntry();
    if (!e) return;
    const c = St.duplicateEntry(e.uid);
    UI.stack[UI.stack.length - 1] = { v: 'entry', name: St.cur.name, uid: c.uid };
    toast.success('ทำสำเนาแล้ว กำลังแก้ตัวสำเนา');
    shell.render();
}
async function delEntry() {
    const e = curEntry();
    if (!e) return;
    if (!await confirmBox({ title: `ลบ “${e.comment || '(ไม่มีชื่อ)'}”?`, text: 'ลบแล้วกู้คืนไม่ได้', danger: true, ok: 'ลบ' })) return;
    St.deleteEntries([e.uid]);
    back();
}

function readField(el) {
    const t = el.dataset.type;
    if (t === 'check') return el.checked;
    if (t === 'num') return Number(el.value) || 0;
    if (t === 'numnull') return el.value === '' ? null : Math.max(0, Number(el.value) || 0);
    if (t === 'tri') return el.value === 'yes' ? true : el.value === 'no' ? false : null;
    return el.value;
}

function onField(el) {
    const e = curEntry();
    if (!e) return;
    const f = el.dataset.f;
    let v = readField(el);
    if (f === 'delayUntilRecursion') v = v || 0;
    e[f] = v;
    St.touch();
    if (f === 'comment') { const h = shell.root?.querySelector('#lm_entry_title'); if (h) h.textContent = v || '(ไม่มีชื่อ)'; }
    if (f === 'content') { zone('count', countLine(e)); scheduleCount(e); autosize(shell.root); }
    if (f === 'probability') { const o = el.parentElement.querySelector('output'); if (o) o.textContent = `${v}%`; }
}

act('input', {
    'lib-q': el => { L.q = el.value; const box = shell.root?.querySelector('.lm_liblist'); if (box) { const all = St.bookNames().sort(collator.compare); const use = St.usage(); const q = L.q.trim().toLowerCase(); const match = n => !q || n.toLowerCase().includes(q); box.innerHTML = libraryList([...use.keys()].filter(n => all.includes(n) && match(n)), all.filter(n => match(n) && !use.has(n)), use, St.currentChar(), St.chatBook() !== null); } },
    'book-q': el => {
        L.bookQ = el.value;
        clearTimeout(bookQTimer);
        bookQTimer = setTimeout(() => {
            const wc = warnCtx();
            const list = St.entryList().filter(FILTERS[L.filter].fn).filter(e => entryMatches(e, L.bookQ));
            if (L.sort !== 'book') list.sort(SORTS[L.sort].fn);
            const box = shell.root?.querySelector('.lm_entries');
            if (box) box.innerHTML = list.length ? list.slice(0, L.limit).map(e => entryCard(e, wc)).join('') : `<div class="lm_empty">${icon('fa-feather')}<div>ไม่เจอเอนทรีที่ตรง</div></div>`;
        }, 150);
    },
    'chip-in': el => { if (/[,，、\n]/.test(el.value)) { const v = el.value; el.value = ''; addChips(el.dataset.field, v); } },
    'cf-in': el => {
        const all = (St.ctx().characters ?? []).map(c => c.name);
        if (all.includes(el.value)) { const v = el.value; el.value = ''; addChips('charfilter', v); }
    },
});
let bookQTimer = null;

act('keydown', {
    'chip-in': (el, ev) => {
        if ((ev.key === 'Enter' || ev.key === 'Tab') && el.value.trim()) { ev.preventDefault(); const v = el.value; el.value = ''; addChips(el.dataset.field, v); }
        else if (ev.key === 'Backspace' && !el.value) {
            const e = curEntry(); const f = el.dataset.field;
            if (e && (e[f] ?? []).length) { el.value = e[f][e[f].length - 1]; e[f] = e[f].slice(0, -1); St.touch(); zone(f, chipBox(e, f)); shell.root?.querySelector(`[data-zone="${f}"] .lm_chipin`)?.focus(); }
        }
    },
    'cf-in': (el, ev) => { if (ev.key === 'Enter' && el.value.trim()) { ev.preventDefault(); const v = el.value; el.value = ''; addChips('charfilter', v); } },
});

act('change', {
    'entry-toggle': el => {
        const e = St.getEntry(Number(el.dataset.uid));
        if (!e) return;
        e.disable = !el.checked;
        St.touch(true);
        const card = el.closest('.lm_entry');
        if (card) card.outerHTML = entryCard(e, warnCtx());
    },
    'e-trig': el => {
        const e = curEntry();
        if (!e) return;
        const set = new Set(e.triggers ?? []);
        el.checked ? set.add(el.dataset.v) : set.delete(el.dataset.v);
        e.triggers = [...set];
        St.touch();
    },
    'e-cfx': el => {
        const e = curEntry();
        if (!e) return;
        e.characterFilter = { names: [], tags: [], ...(e.characterFilter ?? {}), isExclude: el.checked };
        St.touch();
    },
});

/** Field bindings (data-f) and chip inputs losing focus. Called by the shell. */
export function onFieldEvent(ev) {
    const el = ev.target;
    if (el?.dataset?.f) { onField(el); return true; }
    return false;
}
export function onFocusOut(ev) {
    const el = ev.target;
    if (el?.dataset?.act === 'chip-in' && el.value.trim()) { const v = el.value; el.value = ''; addChips(el.dataset.field, v); }
    if (el?.dataset?.f === 'content' || el?.dataset?.f === 'comment') St.touch();
}
export function onToggleDetails(ev) {
    const d = ev.target;
    if (d?.dataset?.adv) d.open ? advOpen.add(d.dataset.adv) : advOpen.delete(d.dataset.adv);
}

export { L as editorState, entriesOf };
