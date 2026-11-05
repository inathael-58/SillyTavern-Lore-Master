/*
 * Lore Master — AI organiser: sort a book's entries into categories and give them short, tidy titles.
 *
 *   1. plan    one request with every title: the AI picks 4–12 categories for this book
 *   2. sort    requests of 60 entries (title, keys, start of text): a category and a title for each
 *   3. review  the person unticks, renames, moves entries, renames or merges categories
 *   4. apply   back up the whole book, then write the category to the entry's extensions
 *              (titles stay clean; Lore Master groups by it) and, if chosen, the new title
 */

import {
    entriesOf, isGlossary, splitCategory, entryCategory, CATEGORY_KEY,
    organizePlanSystem, organizePlanRequest, parseOrganizePlan, organizeSystem, organizeRequest, parseOrganizeReply,
} from './lib.js';
import { ask } from './ai.js';
import { backupPut } from './backup.js';
import { settings, save } from './prefs.js';
import * as St from './store.js';
import { esc, icon, act, shell, UI, back, sheet, promptBox, confirmBox, toast, switchHtml } from './ui.js';

const BATCH = 60;
const collator = new Intl.Collator(['th', 'en'], { sensitivity: 'base', numeric: true });

/** One run, for one book. */
const O = {
    book: '',
    phase: 'idle',          // idle | running | review
    lang: 'th',             // category names: th | en
    rename: true,           // use the AI's titles
    prefix: false,          // also write "[category] " in front of the title
    cats: [],               // [{ name, about }] from the plan
    rows: new Map(),        // String(uid) → { cat, name, take, custom? }  custom = a title the person typed
    pending: [],            // batches of uids still to sort
    total: 0,               // batches in this run
    label: '', error: '',
    open: new Set(),        // categories unfolded in the review
    abort: null,
};

function reset(book) {
    Object.assign(O, { book, phase: 'idle', cats: [], rows: new Map(), pending: [], total: 0, label: '', error: '', open: new Set(), abort: null });
}

/** The entries the organiser works on (not the glossary). */
const workEntries = () => entriesOf(St.cur?.data).filter(e => !isGlossary(e));

/** The title without a category prefix in front ("[Long Book Name] X" → "X"). */
function bareTitle(e) {
    const t = String(e.comment ?? '').trim();
    const sp = splitCategory(t);
    return sp && /^[[【〔(（]/.test(t) ? sp.rest : t;
}
/** What the entry's title becomes. */
function finalTitle(e, row) {
    const name = finalName(e, row);
    return O.prefix ? `[${row.cat}] ${name}` : name;
}
function finalName(e, row) { return row.custom ?? ((O.rename && row.name) ? row.name : bareTitle(e)); }
const changes = (e, row) => finalTitle(e, row) !== String(e.comment ?? '').trim() || entryCategory(e) !== row.cat;

// ================================================================ view

export function viewOrganize(v) {
    const book = St.cur;
    if (!book || book.name !== v.name) return { title: 'จัดหมวดด้วย AI', sub: 'กำลังโหลด…', body: '<div class="lm_empty"><span class="lm_spin"></span></div>' };
    if (O.book !== v.name) reset(v.name);
    const all = workEntries();
    const body = O.phase === 'running' ? running() : O.phase === 'review' ? review(all) : start(all);
    return { title: 'จัดหมวดด้วย AI', sub: `<span>${esc(v.name)} · ${all.length} เอนทรี</span>`, body };
}

function start(all) {
    const nBatches = Math.ceil(all.length / BATCH);
    return `
      <div class="lm_card lm_tool">
        <div class="lm_tool_head"><span class="lm_tool_icon">${icon('fa-folder-tree')}</span>
          <div><b>ให้ AI จัดหมวดและเก็บชื่อให้เป็นระเบียบ</b><small>ดูผลและแก้ได้ก่อนบันทึก</small></div></div>
        <div class="lm_plan">
          <div>${icon('fa-list-ol')} อ่านชื่อทุกเอนทรีแล้วตั้งหมวด 4–12 หมวดที่เข้ากับเล่มนี้</div>
          <div>${icon('fa-folder-open')} จัดทีละ ${BATCH} เอนทรี (${nBatches} รอบ) ดูชื่อ คีย์ และต้นเนื้อหา</div>
          <div>${icon('fa-i-cursor')} เสนอชื่อใหม่ที่สั้นและชัด เช่น <code>[Cody Basketball…_SillyTavern] Northpoint Bears</code> → <code>Northpoint Bears</code></div>
          <div>${icon('fa-shield-halved')} ไม่แตะคีย์และเนื้อหา สำรองเล่มทั้งเล่มไว้ในเบราว์เซอร์ก่อนบันทึก</div>
        </div>
        ${O.error ? `<div class="lm_warn">${icon('fa-triangle-exclamation')} ${esc(O.error)}</div>` : ''}
      </div>
      <div class="lm_card lm_settings">
        <div class="lm_setrow lm_setcol"><div><b>ชื่อหมวดเป็นภาษา</b></div>
          <div class="lm_seg" style="grid-template-columns:1fr 1fr">${[['th', 'ไทย'], ['en', 'English']].map(([k, l]) =>
              `<button class="lm_segbtn ${O.lang === k ? 'lm_on' : ''}" data-act="o-lang" data-v="${k}">${l}</button>`).join('')}</div></div>
        <div class="lm_setrow"><div class="lm_grow"><b>เสนอชื่อเอนทรีใหม่</b><small>ปิดไว้ = จัดหมวดอย่างเดียว ชื่อเดิมไม่เปลี่ยน (ยกเว้นตัดชื่อเล่มในวงเล็บข้างหน้าออก)</small></div>${switchHtml('data-act="o-opt" data-k="rename"', O.rename)}</div>
      </div>
      <button class="lm_btn lm_primary lm_big" data-act="o-run" ${all.length ? '' : 'disabled'}>${icon('fa-wand-magic-sparkles')} เริ่มจัด ${all.length} เอนทรี</button>
      <div class="lm_hint lm_center">ใช้ API ของงาน “จัดหมวด” ในหน้าตั้งค่า → AI (ถ้าไม่ได้ตั้งแยก ใช้ชุดหลัก) · ประมาณ ${nBatches + 1} ครั้ง</div>
      <div class="lm_bottom_pad"></div>`;
}

function running() {
    const done = O.total - O.pending.length;
    const steps = O.total + 1;
    const step = O.cats.length ? done + 1 : 0;
    const pct = Math.round((step / steps) * 100);
    return `
      <div class="lm_card lm_job">
        <div class="lm_row_between"><b>${O.cats.length ? `จัดเอนทรี รอบ ${Math.min(done + 1, O.total)} / ${O.total}` : 'อ่านชื่อทั้งเล่มเพื่อตั้งหมวด…'}</b><span class="lm_dim">${pct}%</span></div>
        <div class="lm_bar"><span style="width:${pct}%"></span></div>
        <div class="lm_dim">${O.label ? `กำลังถาม ${esc(O.label)}` : ''}</div>
        ${O.cats.length ? `<div class="lm_hint">หมวด: ${O.cats.map(c => esc(c.name)).join(' · ')}</div>` : ''}
        <div class="lm_row lm_centerrow"><button class="lm_btn" data-act="o-stop">${icon('fa-stop')} หยุด</button></div>
      </div>`;
}

function review(all) {
    const byUid = new Map(all.map(e => [String(e.uid), e]));
    const groups = new Map();
    for (const [uid, row] of O.rows) {
        const e = byUid.get(uid);
        if (!e) continue;
        if (!groups.has(row.cat)) groups.set(row.cat, []);
        groups.get(row.cat).push([e, row]);
    }
    let nChange = 0, nTake = 0, nRename = 0;
    for (const [uid, row] of O.rows) {
        const e = byUid.get(uid);
        if (!e || !changes(e, row)) continue;
        nChange++;
        if (row.take) nTake++;
        if (row.take && finalTitle(e, row) !== String(e.comment ?? '').trim()) nRename++;
    }
    const left = all.length - O.rows.size;
    const names = [...groups.keys()].sort(collator.compare);
    return `
      <div class="lm_card">
        <div class="lm_stats">
          <div><b>${names.length}</b><span>หมวด</span></div>
          <div><b>${nTake}</b><span>จะบันทึก</span></div>
          <div><b>${nRename}</b><span>เปลี่ยนชื่อ</span></div>
        </div>
        ${left ? `<div class="lm_warn">${icon('fa-triangle-exclamation')} ยังไม่ได้จัด ${left} เอนทรี${O.error ? ` (${esc(O.error)})` : ''}</div>` : ''}
        ${O.pending.length ? `<div class="lm_row lm_centerrow"><button class="lm_btn" data-act="o-resume">${icon('fa-rotate-right')} จัดต่อที่เหลือ (${O.pending.length} รอบ)</button></div>` : ''}
        <div class="lm_setrow"><div class="lm_grow"><b>ใช้ชื่อใหม่ที่ AI เสนอ</b><small>ปิด = ใช้ชื่อเดิม (ตัดชื่อเล่มในวงเล็บข้างหน้าออก)</small></div>${switchHtml('data-act="o-opt" data-k="rename"', O.rename)}</div>
        <div class="lm_setrow"><div class="lm_grow"><b>ใส่หมวดไว้หน้าชื่อด้วย</b><small>เช่น <code>[ทีม] Northpoint Bears</code> เห็นหมวดในหน้า World Info ของ ST ด้วย · ปิด = ชื่อสะอาด หมวดเก็บไว้ในเอนทรี Lore Master จัดกลุ่มให้เหมือนเดิม</small></div>${switchHtml('data-act="o-opt" data-k="prefix"', O.prefix)}</div>
        <div class="lm_hint">แตะชื่อเพื่อแก้ · แตะ ${icon('fa-folder')} เพื่อย้ายหมวด · แตะ ${icon('fa-pen')} ที่หัวหมวดเพื่อเปลี่ยนชื่อหรือรวมหมวด</div>
        <div class="lm_row"><button class="lm_link" data-act="o-all" data-v="1">เลือกทั้งหมด</button><button class="lm_link" data-act="o-all" data-v="0">ไม่เลือกเลย</button><button class="lm_link" data-act="o-fold">${O.open.size ? 'พับทุกหมวด' : 'กางทุกหมวด'}</button></div>
      </div>
      ${names.map(n => catSection(n, groups.get(n))).join('')}
      <div class="lm_bottom_pad"></div>
      <div class="lm_selbar">
        <button class="lm_btn" data-act="o-cancel">${icon('fa-xmark')} ยกเลิก</button>
        <span class="lm_grow"></span>
        <button class="lm_btn lm_primary" data-act="o-apply" ${nTake ? '' : 'disabled'}>${icon('fa-check')} บันทึก ${nTake} เอนทรี</button>
      </div>`;
}

function catSection(name, items) {
    items.sort((a, b) => collator.compare(finalName(a[0], a[1]), finalName(b[0], b[1])));
    const open = O.open.has(name);
    const on = items.filter(([e, r]) => r.take && changes(e, r)).length;
    return `
    <details class="lm_group" data-ocat="${esc(name)}" ${open ? 'open' : ''}>
      <summary><span class="lm_gname">${icon('fa-folder')} ${esc(name)}</span><span class="lm_gcount">${items.length}</span>
        <span class="lm_gnote">${on ? `บันทึก ${on}` : ''}</span>
        <button class="lm_icon lm_osmall" data-act="o-catname" data-cat="${esc(name)}" aria-label="เปลี่ยนชื่อหมวด">${icon('fa-pen')}</button></summary>
      ${open ? `<div class="lm_entries lm_rows">${items.map(([e, r]) => orgRow(e, r)).join('')}</div>` : ''}
    </details>`;
}

function orgRow(e, row) {
    const uid = String(e.uid);
    const now = String(e.comment ?? '').trim();
    const next = finalTitle(e, row);
    const ch = changes(e, row);
    return `
    <div class="lm_orow ${row.take && ch ? '' : 'lm_oskip'}">
      <input type="checkbox" class="lm_ocheck" data-act="o-take" data-uid="${esc(uid)}" ${row.take ? 'checked' : ''} ${ch ? '' : 'disabled'} aria-label="บันทึกเอนทรีนี้">
      <button class="lm_otitle" data-act="o-name" data-uid="${esc(uid)}">
        <span class="lm_onew">${esc(finalName(e, row) || '(ไม่มีชื่อ)')}</span>
        ${next !== now ? `<span class="lm_oold">${esc(now || '(ไม่มีชื่อ)')}</span>` : `<span class="lm_oold lm_osame">${ch ? 'ชื่อเดิม · ย้ายหมวด' : 'ไม่เปลี่ยน'}</span>`}
      </button>
      <button class="lm_icon lm_osmall" data-act="o-move" data-uid="${esc(uid)}" aria-label="ย้ายหมวด">${icon('fa-folder')}</button>
    </div>`;
}

// ================================================================ running

async function run() {
    const all = workEntries();
    if (!all.length) return;
    O.phase = 'running'; O.error = ''; O.abort = new AbortController();
    const signal = O.abort.signal;
    try {
        if (!O.cats.length) {
            O.total = Math.ceil(all.length / BATCH); O.pending = []; shell.render();
            O.cats = await ask({
                task: 'organize', signal, maxTokens: 1500,
                system: organizePlanSystem(O.lang), user: organizePlanRequest(all),
                accept: parseOrganizePlan, onTry: l => { O.label = l; shell.render(); },
            });
            for (let i = 0; i < all.length; i += BATCH) O.pending.push(all.slice(i, i + BATCH).map(e => String(e.uid)));
        }
        shell.render();
        while (O.pending.length) {
            const ids = O.pending[0];
            const byUid = new Map(all.map(e => [String(e.uid), e]));
            const batch = ids.map(id => byUid.get(id)).filter(Boolean);
            const got = await ask({
                task: 'organize', signal, maxTokens: 4000,
                system: organizeSystem(O.lang, O.cats), user: organizeRequest(batch),
                accept: out => parseOrganizeReply(out, ids), onTry: l => { O.label = l; shell.render(); },
            });
            for (const [uid, r] of got) {
                const known = O.cats.find(c => c.name.toLowerCase() === r.cat.toLowerCase());
                if (!known) O.cats.push({ name: r.cat, about: '' });
                O.rows.set(uid, { cat: known ? known.name : r.cat, name: r.name, take: true });
            }
            O.pending.shift();
            if (UI.open) shell.render();
        }
    } catch (e) {
        O.error = String(e?.message ?? e);
        if (!O.rows.size) { O.phase = 'idle'; O.cats = []; O.pending = []; O.abort = null; shell.render(); return; }
    }
    O.phase = 'review'; O.abort = null;
    shell.render();
}

async function apply() {
    const book = St.cur;
    if (!book || book.name !== O.book) return;
    const take = [...O.rows].filter(([uid, r]) => { const e = St.getEntry(uid); return r.take && e && changes(e, r); });
    if (!take.length) return;
    const ok = await confirmBox({
        title: `บันทึก ${take.length} เอนทรี?`, ok: 'บันทึก',
        text: `เปลี่ยนแค่ชื่อและหมวด ไม่แตะคีย์และเนื้อหา<br>สำรองเล่มเดิมทั้งเล่มไว้ในเบราว์เซอร์ก่อน กู้คืนได้จากเมนู ⋯ ของเล่ม → กู้คืนจากสำรอง`,
    });
    if (!ok) return;
    try { await backupPut(book.name, book.data); } catch (e) {
        if (!await confirmBox({ title: 'สำรองไม่สำเร็จ', text: `${esc(e?.message ?? e)}<br>บันทึกต่อโดยไม่มีสำรองไหม`, ok: 'บันทึกต่อ', danger: true })) return;
    }
    for (const [uid, r] of take) {
        const e = St.getEntry(uid);
        e.comment = finalTitle(e, r);
        e.extensions = { ...(e.extensions ?? {}), [CATEGORY_KEY]: r.cat };
    }
    St.touch(true);
    settings().groupBy = 'title'; save();
    toast.success(`จัดหมวดแล้ว ${take.length} เอนทรี`);
    reset(O.book);
    back();
}

// ================================================================ actions

act('click', {
    'o-lang': el => { O.lang = el.dataset.v; shell.render(); },
    'o-run': () => run(),
    'o-resume': () => run(),
    'o-stop': () => O.abort?.abort(),
    'o-cancel': async () => {
        if (!await confirmBox({ title: 'ทิ้งผลที่จัดไว้?', text: 'ยังไม่ได้บันทึกอะไรลงเล่ม', ok: 'ทิ้ง', danger: true })) return;
        reset(O.book); back();
    },
    'o-apply': () => apply(),
    'o-all': el => { for (const r of O.rows.values()) r.take = el.dataset.v === '1'; shell.render(); },
    'o-fold': () => {
        if (O.open.size) O.open.clear();
        else for (const r of O.rows.values()) O.open.add(r.cat);
        shell.render();
    },
    'o-name': async el => {
        const row = O.rows.get(el.dataset.uid);
        const e = St.getEntry(el.dataset.uid);
        if (!row || !e) return;
        const v = await promptBox({ title: 'ชื่อเอนทรี', value: finalName(e, row), ok: 'ใช้ชื่อนี้', text: `เดิม: ${esc(e.comment || '(ไม่มีชื่อ)')}` });
        if (v === null) return;
        row.custom = v.trim(); row.take = true;
        shell.render();
    },
    'o-move': async el => {
        const row = O.rows.get(el.dataset.uid);
        if (!row) return;
        const cats = [...new Set([...O.rows.values()].map(r => r.cat))].sort(collator.compare);
        const v = await sheet({ title: 'ย้ายไปหมวด', items: [...cats.map(c => ({ value: c, label: c, icon: 'fa-folder', on: c === row.cat })), '-', { value: '__new', label: 'หมวดใหม่…', icon: 'fa-folder-plus' }] });
        if (!v) return;
        const cat = v === '__new' ? await promptBox({ title: 'ชื่อหมวดใหม่', ok: 'สร้าง' }) : v;
        if (!cat) return;
        row.cat = cat.trim(); row.take = true; O.open.add(row.cat);
        shell.render();
    },
    'o-catname': async (el, ev) => {
        ev?.preventDefault();
        const from = el.dataset.cat;
        const v = await promptBox({ title: 'เปลี่ยนชื่อหมวด', value: from, ok: 'เปลี่ยน', text: 'ใส่ชื่อหมวดที่มีอยู่แล้ว = รวมสองหมวดเข้าด้วยกัน' });
        if (!v || v.trim() === from) return;
        const to = [...new Set([...O.rows.values()].map(r => r.cat))].find(c => c.toLowerCase() === v.trim().toLowerCase()) ?? v.trim();
        for (const r of O.rows.values()) if (r.cat === from) r.cat = to;
        if (O.open.delete(from)) O.open.add(to);
        shell.render();
    },
});

act('change', {
    'o-opt': el => { O[el.dataset.k] = el.checked; shell.render(); },
    'o-take': el => { const r = O.rows.get(el.dataset.uid); if (r) { r.take = el.checked; shell.render(); } },
});

/** Remember which categories are unfolded; fill one the first time it opens. */
export function onOrganizeToggle(ev) {
    const d = ev.target;
    if (!d?.dataset?.ocat) return;
    const k = d.dataset.ocat;
    if (d.open) { if (!O.open.has(k)) { O.open.add(k); shell.render(); } } else O.open.delete(k);
}

export const organizeBusy = () => O.phase === 'running';
