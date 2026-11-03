/*
 * Lore Master — "ตรวจ & รวม": import books from other sites, merge several books,
 * find what makes them misfire, fix, test, save.
 */

import {
    readLorebook, mergeBooks, diagnose, applyChanges, simulate, summarize, toWorld,
    estTokens, FORMAT_LABEL, POSITION, cardFromPng, LONG_TOKENS, THAI, cleanKeys, isGlossary, upsertGlossaryList, glossaryLines,
    keyPlan, THAI_KEY_SYSTEM, thaiKeyRequest, parseThaiKeys, vetThaiKey, CONDENSE_SYSTEM, condenseRequest, cleanCondensed,
} from './lib.js';
import * as St from './store.js';
import { settings, save } from './prefs.js';
import { esc, icon, act, shell, goTab, goTo, toast, download, fmt } from './ui.js';
import { isThaiDictWord } from './editor.js';
import { ask } from './ai.js';
import { backupPut, backupList } from './backup.js';

const LOG = '[LoreMaster]';
const W = St.WIref;

// ---------------------------------------------------------------- state

const S = {
    step: 'src',
    /** @type {{id:number, name:string, format:string, raw:any, book?:string, entries:any[]}[]} */
    sources: [],
    base: [], work: [], history: [], applied: [], issues: [],
    expanded: new Set(),
    picker: false, pickerQuery: '',
    simText: '', simRecursive: null,
    saveName: '', saveMode: 'new', prefixSource: true, linkChar: true, unlinkOld: true,
    capOn: true, capN: 10,
    saved: null, busy: false,
    // AI tools
    job: null,              // { kind, done, total, label, abort: AbortController, errors: [] }
    thai: null,             // Map uid -> { translit, nick, translated, on:Set }
    glossary: true,
    cpick: null,            // Set of uids picked for condensing (picker open when not null)
    cratio: null,
    condensed: null,        // Map uid -> { text, on }
    cexpand: new Set(),
};
let nextSourceId = 1;

function scanOpts() {
    const c = St.ctx();
    return {
        names: { char: c.name2 ?? '', user: c.name1 ?? '' },
        recursive: S.simRecursive ?? !!W.world_info_recursive,
        wholeWords: !!W.world_info_match_whole_words,
        caseSensitive: !!W.world_info_case_sensitive,
        isThaiDictWord,
    };
}
function rebuild() {
    S.base = mergeBooks(S.sources.map(s => ({ name: s.name, entries: s.entries })));
    S.work = structuredClone(S.base);
    S.history = []; S.applied = []; S.saved = null;
    if (!S.job) resetAi();
    rediagnose();
    suggestName();
}
function rediagnose() { S.issues = S.work.length ? diagnose(S.work, scanOpts()) : []; }
function resetAi() { S.thai = null; S.cpick = null; S.condensed = null; S.cexpand.clear(); }
function suggestName() {
    const cc = St.currentChar();
    const stBooks = S.sources.filter(s => s.book);
    if (S.sources.length === 1 && stBooks.length === 1) { S.saveName = stBooks[0].book; S.saveMode = 'overwrite'; return; }
    S.saveMode = 'new';
    const base = S.sources.length > 1 && cc ? cc.ch.name : (S.sources[0]?.name ?? 'Lorebook');
    S.saveName = St.freeName(`${base} (Lore Master)`);
}
function addSource({ name, raw, book = undefined }) {
    const read = readLorebook(raw, { name, defaultPosition: Number(settings().position), template: St.template() });
    S.sources.push({ id: nextSourceId++, name: read.name || name, format: read.format, raw, book, entries: read.entries });
}
function rereadSources() {
    for (const s of S.sources) if (!s.book) s.entries = readLorebook(s.raw, { name: s.name, defaultPosition: Number(settings().position), template: St.template() }).entries;
}
async function addBook(name) {
    if (S.sources.some(s => s.book === name)) return;
    try {
        if (St.cur?.name === name) await St.flush();
        const raw = await W.loadWorldInfo(name);
        if (!raw) throw new Error('โหลดไม่ได้');
        addSource({ name, raw: structuredClone(raw), book: name });
    } catch (e) { toast.error(`${name}: ${e?.message ?? e}`); }
}
async function readFiles(files) {
    let n = 0;
    for (const f of files) {
        try {
            let raw;
            if (/\.png$/i.test(f.name) || f.type === 'image/png') {
                raw = cardFromPng(await f.arrayBuffer());
                if (!raw) throw new Error('รูปนี้ไม่มีข้อมูลการ์ดตัวละคร');
                if (!(raw.data?.character_book?.entries ?? raw.character_book?.entries)?.length) throw new Error('การ์ดนี้ไม่มี lorebook ในตัว');
            } else raw = JSON.parse(await f.text());
            addSource({ name: f.name.replace(/\.(json|png)$/i, ''), raw });
            n++;
        } catch (e) { toast.error(`${f.name}: ${e?.message ?? e}`, 'อ่านไฟล์ไม่ได้'); }
    }
    return n;
}

// ---------------------------------------------------------------- entry points used by other modules

export async function checkBook(name) {
    S.sources = []; await addBook(name); rebuild();
    S.step = 'fix';
    goTab('doctor');
}
export async function thaiBook(name) {
    await checkBook(name);
    startThai();
}
export async function condenseBook(name) {
    await checkBook(name);
    openCondensePicker();
    shell.render();
}
export async function importFiles(files) {
    S.sources = [];
    if (await readFiles(files)) { rebuild(); S.step = 'fix'; } else S.step = 'src';
    goTab('doctor');
}
export async function startMerge(names) {
    S.sources = [];
    for (const n of names) await addBook(n);
    rebuild();
    S.step = 'src'; S.picker = true;
    goTab('doctor');
}
export function importJson(name, raw) {
    S.sources = [];
    addSource({ name, raw });
    rebuild();
    S.step = 'fix';
    goTab('doctor');
}

// ---------------------------------------------------------------- views

const STEPS = [['src', 'fa-folder-open', 'เลือกเล่ม'], ['fix', 'fa-stethoscope', 'ตรวจ'], ['test', 'fa-flask', 'ทดสอบ'], ['save', 'fa-floppy-disk', 'บันทึก']];

export function viewDoctor() {
    const high = S.issues.filter(i => i.severity === 'high').length;
    const body = S.step === 'src' ? viewSources() : S.step === 'fix' ? viewFix() : S.step === 'test' ? viewTest() : viewSave();
    return {
        title: 'ตรวจ & รวม',
        sub: S.sources.length ? `${S.sources.length} เล่ม · ${S.work.length} เอนทรี` : 'นำเข้า ตรวจ ซ่อม รวมเล่ม',
        body: `
        <div class="lm_steps">${STEPS.map(([id, ic, label], i) => `
          <button class="lm_step ${S.step === id ? 'lm_on' : ''}" data-act="d-step" data-step="${id}" ${id !== 'src' && !S.work.length ? 'disabled' : ''}>
            <span class="lm_stepnum">${i + 1}</span><span>${label}</span>${id === 'fix' && high ? `<b class="lm_badge">${high}</b>` : ''}
          </button>`).join('')}</div>
        <div class="lm_doctor">${body}</div>
        <div class="lm_bottom_pad"></div>`,
    };
}

function viewSources() {
    const cc = St.currentChar();
    const hasForeign = S.sources.some(s => !s.book && s.format !== 'st');
    const total = S.sources.reduce((n, s) => n + s.entries.length, 0);
    const pos = Number(settings().position);
    return `
    <div class="lm_hero">
      <div class="lm_hero_icon">${icon('fa-wand-magic-sparkles')}</div>
      <div>เลือก lorebook ที่จะตรวจ ถ้าเลือกหลายเล่มจะรวมเป็นเล่มเดียวให้ ไฟล์ export ของ <b>JanitorAI</b> ที่ ST import เองไม่ได้ ใช้ที่นี่ได้เลย</div>
    </div>
    <div class="lm_bigchoices">
      <label class="lm_choice">${icon('fa-file-import')}<b>เลือกไฟล์</b><small>.json ของ ST · JanitorAI · การ์ด .png (ตรวจก่อน import ได้) · หลายไฟล์ได้</small>
        <input type="file" accept=".json,application/json,.png,image/png" multiple hidden data-act="d-files"></label>
      <button class="lm_choice ${S.picker ? 'lm_on' : ''}" data-act="d-picker">${icon('fa-book')}<b>เลือกจากเล่มใน ST</b><small>${(St.bookNames()).length} เล่ม</small></button>
      ${cc ? `<button class="lm_choice" data-act="d-charbooks">${icon('fa-user')}<b>เล่มของ ${esc(cc.ch.name)}</b><small>เล่มหลัก + เล่มเสริม</small></button>` : ''}
    </div>
    ${S.picker ? viewPicker() : ''}
    ${S.sources.length ? `
      <h3 class="lm_h">เล่มที่เลือก (${S.sources.length})</h3>
      <div class="lm_list">${S.sources.map(s => `
        <div class="lm_card lm_src">
          <div class="lm_srcicon">${icon(s.book ? 'fa-book' : 'fa-file-lines')}</div>
          <div class="lm_grow lm_minw0">
            <div class="lm_name">${esc(s.name)}</div>
            <div class="lm_dim">${FORMAT_LABEL[s.format] ?? s.format}${s.book ? ' · ใน ST' : ' · ไฟล์'} · ${s.entries.length} เอนทรี · ≈${fmt(s.entries.reduce((n, e) => n + estTokens(e.content), 0))} โทเคน</div>
          </div>
          <button class="lm_icon" data-act="d-rmsrc" data-id="${s.id}" aria-label="เอาออก">${icon('fa-xmark')}</button>
        </div>`).join('')}
      </div>
      ${hasForeign ? `
      <div class="lm_card">
        <label class="lm_label" for="lm_pos">ไฟล์จากเว็บอื่นไม่ได้บอกตำแหน่งใน prompt จะให้ใส่ตรงไหน</label>
        <select id="lm_pos" class="lm_input" data-act="d-pos">
          <option value="${POSITION.before}" ${pos === POSITION.before ? 'selected' : ''}>ก่อนข้อมูลตัวละคร (แนะนำ)</option>
          <option value="${POSITION.after}" ${pos === POSITION.after ? 'selected' : ''}>หลังข้อมูลตัวละคร</option>
          <option value="${POSITION.atDepth}" ${pos === POSITION.atDepth ? 'selected' : ''}>ในแชท ลึก 4 ข้อความ (@D4)</option>
        </select>
        <div class="lm_hint">ก่อน/หลังข้อมูลตัวละคร: อยู่ในส่วนข้อมูลตั้งต้น เหมาะกับข้อมูลโลก ตัวละคร สถานที่ · ในแชท @D4: แทรกใกล้ข้อความล่าสุด โมเดลให้น้ำหนักมากกว่า แต่ถ้าติดหลายตัวจะรกบทสนทนา</div>
      </div>` : ''}
      <button class="lm_btn lm_primary lm_big" data-act="d-step" data-step="fix">ตรวจ ${total} เอนทรี ${icon('fa-arrow-right')}</button>
    ` : ''}`;
}

function viewPicker() {
    const names = St.bookNames().filter(n => !S.pickerQuery || n.toLowerCase().includes(S.pickerQuery.toLowerCase()));
    const chosen = new Set(S.sources.filter(s => s.book).map(s => s.book));
    return `
    <div class="lm_card lm_picker">
      <div class="lm_search">${icon('fa-magnifying-glass')}<input type="search" class="lm_input" placeholder="ค้นหาชื่อเล่ม…" value="${esc(S.pickerQuery)}" data-act="d-pickq"></div>
      <div class="lm_pick_list">${names.length ? names.map(n => `
        <label class="lm_checkrow"><input type="checkbox" data-act="d-pickbook" data-book="${esc(n)}" ${chosen.has(n) ? 'checked' : ''}><span>${esc(n)}</span></label>`).join('')
        : '<div class="lm_dim">ไม่เจอเล่ม</div>'}</div>
      <button class="lm_btn" data-act="d-picker">${icon('fa-check')} เสร็จ</button>
    </div>`;
}

const SEV = { high: ['lm_high', 'ด่วน'], mid: ['lm_mid', 'ควรแก้'], low: ['lm_low', 'เล็กน้อย'] };

function vs(before, now) {
    return `<div class="lm_vs"><span><b>${before.hits.length}</b> เอนทรี<br><small>≈${fmt(before.tokens)} โทเคน · ก่อนซ่อม</small></span>
      ${icon('fa-arrow-right')}
      <span class="${now.hits.length < before.hits.length ? 'lm_good' : ''}"><b>${now.hits.length}</b> เอนทรี<br><small>≈${fmt(now.tokens)} โทเคน · ตอนนี้</small></span></div>`;
}

function viewFix() {
    const sum = summarize(S.work);
    const sample = St.chatSample();
    let live = '';
    if (sample) {
        const o = scanOpts();
        live = `<div class="lm_card lm_live"><div class="lm_dim">ลองกับข้อความล่าสุดในแชทที่เปิดอยู่ (recursion ${o.recursive ? 'เปิด' : 'ปิด'})</div>${vs(simMemo(S.base, sample, o), simMemo(S.work, sample, o))}</div>`;
    }
    const checkedTotal = S.issues.reduce((n, i) => n + i.changes.filter(c => c.checked).length, 0);
    const safeTotal = S.issues.filter(i => i.kind === 'safe').reduce((n, i) => n + i.changes.filter(c => c.checked).length, 0);
    plan = keyPlan(S.work, S.issues.flatMap(i => i.changes));
    return `
    <div class="lm_stats">
      <div><b>${sum.count}</b><span>เอนทรี</span></div><div><b>≈${fmt(sum.tokens)}</b><span>โทเคนทั้งเล่ม</span></div>
      <div><b>${sum.constant}</b><span>ติดตลอด</span></div><div><b>${sum.thaiKeys}</b><span>มีคีย์ไทย</span></div>
    </div>
    ${live}
    ${guideCard()}
    <div class="lm_fixbar lm_sticky">
      <button class="lm_btn" data-act="d-fixsafe" ${safeTotal ? '' : 'disabled'} title="ซ่อมเฉพาะข้อที่ไม่แตะคีย์: ลูกโซ่ ติดตลอด เรื่องซ้ำ รูปแบบคีย์">${icon('fa-shield-halved')} ไม่แตะคีย์ (${safeTotal})</button>
      <button class="lm_btn lm_primary" data-act="d-fixall" ${checkedTotal ? '' : 'disabled'} title="ซ่อมทุกข้อที่ติ๊กไว้ รวมข้อที่แก้คีย์">${icon('fa-wand-magic-sparkles')} ทุกข้อที่ติ๊ก (${checkedTotal})</button>
      <button class="lm_icon lm_undo" data-act="d-undo" ${S.history.length ? '' : 'disabled'} title="ย้อน" aria-label="ย้อน">${icon('fa-rotate-left')}</button>
    </div>
    ${S.applied.length ? `<div class="lm_card lm_done"><b>${icon('fa-check')} ซ่อมแล้ว</b><ul>${S.applied.map(t => `<li>${esc(t)}</li>`).join('')}</ul>
      <button class="lm_btn lm_primary" data-act="d-step" data-step="save">ไปบันทึก ${icon('fa-arrow-right')}</button></div>` : ''}
    ${aiTools()}
    ${S.issues.filter(i => i.id !== 'thai' && i.id !== 'big').map(viewIssue).join('') || `<div class="lm_empty">${icon('fa-circle-check')}<div>ไม่เจอปัญหาแล้ว</div></div>`}
    <p class="lm_hint">ทุกอย่างยังอยู่ในหน้านี้ ยังไม่ได้แก้ไฟล์จริงจนกว่าจะกดบันทึก</p>`;
}

let plan = new Map(); // uid -> combined effect of all ticked key changes

function guideCard() {
    const open = S.guideOpen ?? !S.applied.length;
    return `
    <details class="lm_card lm_guide" ${open ? 'open' : ''} data-guide>
      <summary>${icon('fa-circle-question')} <b>อ่านก่อนซ่อม</b> <small>ลำดับที่แนะนำ และข้อไหนขัดกันได้</small></summary>
      <ol class="lm_guide_list">
        <li><b>ซ่อมแบบไม่แตะคีย์ก่อน</b> (ปุ่ม ${icon('fa-shield-halved')} <b>ไม่แตะคีย์</b>) คือข้อที่มีป้าย <span class="lm_kind lm_kind_safe">ไม่แตะคีย์</span> เช่น ลูกโซ่ ติดตลอด เรื่องซ้ำ แค่นี้ก็แก้การติดทีละหลายสิบเอนทรีได้เกือบหมด และไม่มีข้อเสียต่อการติดของเอนทรี</li>
        <li><b>ดูผล</b> ที่การ์ด “ลองกับข้อความล่าสุด” ด้านบน หรือแท็บ <b>ทดสอบ</b> ถ้าจำนวนเอนทรีที่ติดพอดีแล้ว จะหยุดตรงนี้ก็ได้</li>
        <li><b>ค่อยดูข้อที่มีป้าย <span class="lm_kind lm_kind_keys">แก้คีย์</span></b> การลบคีย์มีข้อเสียเสมอ คือแชทพูดคำนั้นแล้วเอนทรีจะไม่ติด แต่ละข้อบอกไว้ว่าเสียอะไร ติ๊กไว้ให้เฉพาะที่ค่อนข้างปลอดภัย ที่เหลือเลือกเอง</li>
      </ol>
      <div class="lm_hint">${icon('fa-link')} <b>ข้อที่เกี่ยวกัน:</b> “คีย์ที่อยู่ในเนื้อหาของเอนทรีอื่นจำนวนมาก” เป็นผลของลูกโซ่ ซ่อมลูกโซ่แล้วข้อนี้หายเอง ไม่ต้องลบคีย์ · หลายข้ออาจลบคีย์ของเอนทรีเดียวกัน แต่ละบรรทัดจึงบอกว่า <b>รวมทุกข้อที่ติ๊กแล้วจะเหลือคีย์อะไร</b> ถ้าจะไม่เหลือเลย Lore Master เก็บคีย์สุดท้ายไว้ให้</div>
      <div class="lm_hint">${icon('fa-floppy-disk')} ยังไม่แก้ไฟล์จริงจนกว่าจะกดบันทึก กด <b>ย้อน</b> ได้ทุกขั้น</div>
    </details>`;
}

function changeExtra(c) {
    if (c.op !== 'removeKey') return '';
    const p = plan.get(c.uid);
    if (!p) return '';
    if (!c.checked) return `<small class="lm_keyleft">ถ้าติ๊ก: ลบ “${esc(c.key)}”</small>`;
    if (p.kept === c.key) return `<small class="lm_keyleft lm_keyleft_warn">${icon('fa-triangle-exclamation')} ติ๊กทุกข้อรวมกันแล้วจะไม่เหลือคีย์ จะเก็บ “${esc(c.key)}” ไว้ให้</small>`;
    return `<small class="lm_keyleft">เหลือคีย์: ${p.after.length ? p.after.map(k => `<span>${esc(k)}</span>`).join(' ') : '—'}</small>`;
}

function viewIssue(i) {
    const [cls, label] = SEV[i.severity];
    const open = S.expanded.has(i.id);
    const shown = open ? i.changes : i.changes.slice(0, 6);
    const on = i.changes.filter(c => c.checked).length;
    return `
    <section class="lm_card lm_issue ${cls}">
      <div class="lm_issue_head"><span class="lm_sev">${label}</span><h4>${esc(i.title)}</h4></div>
      ${i.kind ? `<span class="lm_kind lm_kind_${i.kind}">${i.kind === 'safe' ? `${icon('fa-shield-halved')} ไม่แตะคีย์` : `${icon('fa-key')} แก้คีย์ — มีข้อเสีย อ่านก่อน`}</span>` : ''}
      <p class="lm_why"><b>ทำไม:</b> ${esc(i.why)}</p>
      ${i.fix ? `<p class="lm_why"><b>ถ้าซ่อม:</b> ${esc(i.fix)}</p>` : ''}
      ${i.tradeoff ? `<p class="lm_why lm_tradeoff"><b>ข้อควรรู้:</b> ${esc(i.tradeoff)}</p>` : ''}
      ${i.examples?.length ? `<ul class="lm_ex">${i.examples.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${i.changes.length ? `
        ${i.changes.length > 1 ? `<div class="lm_row lm_mini"><button class="lm_link" data-act="d-checkall" data-issue="${i.id}" data-v="1">เลือกทั้งหมด</button><button class="lm_link" data-act="d-checkall" data-issue="${i.id}" data-v="0">ไม่เลือกเลย</button></div>` : ''}
        <div class="lm_changes">${shown.map(c => `
          <label class="lm_checkrow"><input type="checkbox" data-act="d-check" data-id="${c.id}" ${c.checked ? 'checked' : ''}><span>${esc(c.label)}${changeExtra(c)}</span></label>`).join('')}
        </div>
        ${i.changes.length > 6 ? `<button class="lm_link" data-act="d-expand" data-issue="${i.id}">${open ? 'ย่อ' : `ดูทั้งหมด (${i.changes.length})`}</button>` : ''}
        <button class="lm_btn" data-act="d-fixone" data-issue="${i.id}" ${on ? '' : 'disabled'}>${icon('fa-wrench')} ซ่อมข้อนี้ (${on})</button>` : ''}
    </section>`;
}

// ---------------------------------------------------------------- AI tools (Thai keys, condense)

const live = () => S.work.filter(e => !e.disable && !isGlossary(e));
const needThai = () => live().filter(e => !e.constant && !(e.key ?? []).some(k => THAI.test(k)));
const nameOf = e => e.comment || `#${e.uid}`;
const BATCH = 15;

function aiTools() {
    const thaiN = needThai().length;
    const longN = live().filter(e => estTokens(e.content) > LONG_TOKENS).length;
    const hasGloss = S.work.some(isGlossary);
    const glossN = glossaryLines(S.work).length;
    return `
    <h3 class="lm_h">${icon('fa-wand-magic-sparkles')} เครื่องมือ AI</h3>
    ${S.job ? jobCard() : ''}
    <section class="lm_card lm_tool">
      <div class="lm_tool_head"><span class="lm_tool_icon">${icon('fa-language')}</span><div class="lm_grow"><b>คีย์ภาษาไทย</b><small>${thaiN ? `${thaiN} เอนทรียังไม่มีคีย์ไทย` : 'ทุกเอนทรีมีคีย์ไทยแล้ว'}</small></div></div>
      ${S.thai ? thaiReview() : `
        <p class="lm_why">แชทภาษาไทยจะไม่เจอคีย์ภาษาอังกฤษ ให้ AI เสนอคำทับศัพท์ ชื่อเล่น และคำแปล แล้วเลือกเองว่าจะเพิ่มคีย์ไหน ส่งทีละ ${BATCH} เอนทรี (≈${Math.ceil(thaiN / BATCH)} ครั้ง)</p>
        <button class="lm_btn lm_primary" data-act="d-thai" ${thaiN && !S.job ? '' : 'disabled'}>${icon('fa-wand-magic-sparkles')} ให้ AI คิดคีย์ไทย (${thaiN} เอนทรี)</button>`}
      <div class="lm_glossrow">
        ${icon('fa-spell-check')} <span class="lm_grow">อภิธานชื่อ: ${hasGloss ? `มีแล้ว ${glossN} ชื่อ` : glossN ? `ทำได้ ${glossN} ชื่อ` : 'ต้องมีคีย์ไทยก่อน'}</span>
        <button class="lm_btn" data-act="d-gloss" ${glossN ? '' : 'disabled'}>${hasGloss ? 'อัปเดต' : 'สร้าง'}</button>
      </div>
      <div class="lm_hint">อภิธานคือเอนทรีที่บอกโมเดลว่าชื่อไหนสะกดไทยยังไง เช่น <code>Cody Dawson = โคดี้ ดอว์สัน</code> ทำให้สะกดเหมือนเดิมทุกเทิร์นและตรงกับคีย์ ${settings().glossarySmart ? 'เครื่องนี้เปิดโหมดประหยัดไว้: ส่งเฉพาะชื่อที่เกี่ยวกับเทิร์นนั้น' : ''} คนที่ไม่มี Lore Master จะได้ทั้งรายการ</div>
    </section>
    <section class="lm_card lm_tool">
      <div class="lm_tool_head"><span class="lm_tool_icon">${icon('fa-compress')}</span><div class="lm_grow"><b>ย่อเนื้อหาที่ยาว</b><small>${longN ? `${longN} เอนทรียาวเกิน ${LONG_TOKENS} โทเคน` : 'ไม่มีเอนทรีที่ยาวมาก'}</small></div></div>
      ${S.condensed ? condenseReview() : S.cpick ? condensePicker() : `
        <p class="lm_why">สำหรับเอนทรีที่เขียนแบบบรรยายยาว ๆ AI จะตัดคำฟุ่มเฟือย มุก และเรื่องซ้ำออก เหลือเป็นข้อ ๆ แต่เก็บข้อเท็จจริงไว้ครบ ภาษาเดิม ดูและแก้ก่อนใช้ได้ทุกตัว</p>
        <button class="lm_btn lm_primary" data-act="d-cpick" ${S.job ? 'disabled' : ''}>${icon('fa-list-check')} เลือกเอนทรีที่จะย่อ…</button>`}
    </section>`;
}

function jobCard() {
    const j = S.job;
    const pct = j.total ? Math.round(j.done / j.total * 100) : 0;
    return `<div class="lm_card lm_job">
      <div class="lm_row_between"><b><span class="lm_spin lm_spin_sm"></span> ${esc(j.kind === 'thai' ? 'กำลังคิดคีย์ไทย' : 'กำลังย่อเนื้อหา')} ${j.done}/${j.total}</b><button class="lm_btn" data-act="d-stop">${icon('fa-stop')} หยุด</button></div>
      <div class="lm_bar"><span style="width:${pct}%"></span></div>
      <div class="lm_dim">${esc(j.label || '')}</div>
      ${j.errors.length ? `<div class="lm_warn">${esc(j.errors.slice(-2).join(' · '))}</div>` : ''}
    </div>`;
}
function jobUpdate() { const el = shell.root?.querySelector('.lm_job'); if (el) el.outerHTML = jobCard(); else shell.render(); }

function startThai() {
    const list = needThai();
    if (!list.length || S.job) return;
    S.thai = new Map();
    S.job = { kind: 'thai', done: 0, total: list.length, label: '', abort: new AbortController(), errors: [] };
    S.step = 'fix';
    shell.render();
    (async () => {
        const wc = { names: scanOpts().names, isThaiDictWord };
        for (let i = 0; i < list.length && !S.job.abort.signal.aborted; i += BATCH) {
            const chunk = list.slice(i, i + BATCH);
            try {
                const res = await ask({
                    system: THAI_KEY_SYSTEM, user: thaiKeyRequest(chunk), maxTokens: 300 * chunk.length + 400, signal: S.job.abort.signal,
                    accept: text => { const m = parseThaiKeys(text, chunk); if (!m.size) throw new Error('ไม่ได้คีย์ใหม่เลย'); return m; },
                    onTry: label => { S.job.label = `${label} · ${nameOf(chunk[0])} …`; jobUpdate(); },
                });
                for (const [uid, rec] of res) {
                    const e = S.work.find(x => x.uid === uid);
                    const on = new Set([...rec.translit, ...rec.nick].filter(k => !vetThaiKey(k, e, S.work, wc).length));
                    S.thai.set(uid, { ...rec, on });
                }
            } catch (err) {
                if (S.job.abort.signal.aborted) break;
                S.job.errors.push(String(err?.message ?? err).split('\n')[0]);
            }
            S.job.done = Math.min(list.length, i + BATCH);
            jobUpdate();
        }
        const errs = S.job.errors;
        S.job = null;
        if (!S.thai.size) { S.thai = null; toast.error(errs.join('\n') || 'AI ไม่ได้เสนอคีย์ใหม่', 'คิดคีย์ไทยไม่สำเร็จ'); }
        shell.render();
    })();
}

function thaiReview() {
    const wc = { names: scanOpts().names, isThaiDictWord };
    const rows = [...S.thai.entries()].map(([uid, r]) => [S.work.find(e => e.uid === uid), r]).filter(([e]) => e);
    const total = rows.reduce((n, [, r]) => n + r.on.size, 0);
    const chip = (uid, e, k, r) => {
        const w = vetThaiKey(k, e, S.work, wc);
        return `<button class="lm_sugchip ${r.on.has(k) ? 'lm_on' : ''} ${w.length ? 'lm_sugwarn' : ''}" data-act="d-sug" data-uid="${uid}" data-k="${esc(k)}" title="${esc(w.map(x => x.text).join('\n'))}">${icon(r.on.has(k) ? 'fa-square-check' : 'fa-square')} ${esc(k)}${w.length ? ` ${icon('fa-triangle-exclamation')}` : ''}</button>`;
    };
    return `
      <div class="lm_dim">ติ๊กไว้ให้แล้วเฉพาะคำทับศัพท์และชื่อเล่นที่ไม่มีคำเตือน คำแปล <b>เลือกเพิ่มเอง</b> · ⚠ = อาจไปติดกลางคำอื่นหรือชนกับเอนทรีอื่น (แตะค้างดูเหตุผล)</div>
      <div class="lm_row lm_mini"><button class="lm_link" data-act="d-sugall" data-v="safe">เลือกตามที่แนะนำ</button><button class="lm_link" data-act="d-sugall" data-v="all">เลือกทั้งหมด</button><button class="lm_link" data-act="d-sugall" data-v="none">ไม่เลือกเลย</button></div>
      <div class="lm_sugrows">${rows.map(([e, r]) => `
        <div class="lm_sugrow">
          <div class="lm_name">${esc(nameOf(e))}</div>
          <div class="lm_sugchips">${r.translit.map(k => chip(e.uid, e, k, r)).join('')}${r.nick.map(k => chip(e.uid, e, k, r)).join('')}${r.translated.length ? `<span class="lm_sugsep">แปล:</span>${r.translated.map(k => chip(e.uid, e, k, r)).join('')}` : ''}</div>
        </div>`).join('')}</div>
      <label class="lm_checkrow"><input type="checkbox" data-act="d-glosson" ${S.glossary ? 'checked' : ''}><span>สร้าง/อัปเดตอภิธานชื่อไปด้วย</span></label>
      <div class="lm_row lm_wrap">
        <button class="lm_btn lm_primary" data-act="d-thaiapply" ${total ? '' : 'disabled'}>${icon('fa-plus')} เพิ่มคีย์ที่เลือก (${total})</button>
        <button class="lm_btn" data-act="d-thaicancel">ทิ้งทั้งหมด</button>
      </div>`;
}

function openCondensePicker() {
    S.cratio = S.cratio ?? (Number(settings().condenseRatio) || 0.5);
    S.cpick = new Set(live().filter(e => estTokens(e.content) > LONG_TOKENS).map(e => e.uid));
}
function condensePicker() {
    const list = live().filter(e => estTokens(e.content) > 200).sort((a, b) => estTokens(b.content) - estTokens(a.content));
    return `
      <div class="lm_dim">ติ๊กไว้ให้แล้วเฉพาะที่ยาวเกิน ${LONG_TOKENS} โทเคน · ย่อทีละเอนทรี (1 เอนทรี = 1 ครั้ง)</div>
      <div class="lm_row lm_mini"><button class="lm_link" data-act="d-cpickall" data-v="1">เลือกทั้งหมด</button><button class="lm_link" data-act="d-cpickall" data-v="0">ไม่เลือกเลย</button></div>
      <div class="lm_pick_list">${list.map(e => `<label class="lm_checkrow"><input type="checkbox" data-act="d-cpickone" data-uid="${e.uid}" ${S.cpick.has(e.uid) ? 'checked' : ''}><span class="lm_grow">${esc(nameOf(e))}</span><small>≈${fmt(estTokens(e.content))}</small></label>`).join('') || '<div class="lm_dim">ไม่มีเอนทรียาว</div>'}</div>
      <label class="lm_label">ย่อให้เหลือประมาณ</label>
      <div class="lm_seg lm_seg3">${[[0.65, 'สองในสาม'], [0.5, 'ครึ่งหนึ่ง'], [0.35, 'หนึ่งในสาม']].map(([v, l]) => `<button class="lm_segbtn ${S.cratio === v ? 'lm_on' : ''}" data-act="d-cratio" data-v="${v}">${l}</button>`).join('')}</div>
      <div class="lm_row lm_wrap lm_mt">
        <button class="lm_btn lm_primary" data-act="d-condense" ${S.cpick.size ? '' : 'disabled'}>${icon('fa-compress')} ย่อ ${S.cpick.size} เอนทรี</button>
        <button class="lm_btn" data-act="d-ccancel">ยกเลิก</button>
      </div>`;
}

function startCondense() {
    const list = S.work.filter(e => S.cpick?.has(e.uid));
    if (!list.length || S.job) return;
    const ratio = S.cratio ?? 0.5;
    S.condensed = new Map();
    S.cpick = null;
    S.job = { kind: 'condense', done: 0, total: list.length, label: '', abort: new AbortController(), errors: [] };
    shell.render();
    (async () => {
        for (const e of list) {
            if (S.job.abort.signal.aborted) break;
            try {
                const text = await ask({
                    system: CONDENSE_SYSTEM, user: condenseRequest(e, ratio), maxTokens: Math.max(600, Math.round(estTokens(e.content) * 1.2)), signal: S.job.abort.signal,
                    accept: out => { const t = cleanCondensed(out, e.content); if (!t) throw new Error('ได้เนื้อหาที่ใช้ไม่ได้'); return t; },
                    onTry: label => { S.job.label = `${label} · ${nameOf(e)}`; jobUpdate(); },
                });
                S.condensed.set(e.uid, { text, on: true });
            } catch (err) {
                if (S.job.abort.signal.aborted) break;
                S.job.errors.push(`${nameOf(e)}: ${String(err?.message ?? err).split('\n')[0]}`);
            }
            S.job.done++;
            jobUpdate();
        }
        const errs = S.job.errors;
        S.job = null;
        if (!S.condensed.size) { S.condensed = null; toast.error(errs.join('\n') || 'ไม่ได้ผลลัพธ์', 'ย่อไม่สำเร็จ'); }
        else if (errs.length) toast.warning(`ย่อไม่ได้ ${errs.length} เอนทรี`);
        shell.render();
    })();
}

function condenseReview() {
    const rows = [...S.condensed.entries()].map(([uid, r]) => [S.work.find(e => e.uid === uid), r]).filter(([e]) => e);
    const on = rows.filter(([, r]) => r.on);
    const saved = on.reduce((n, [e, r]) => n + estTokens(e.content) - estTokens(r.text), 0);
    return `
      <div class="lm_dim">แตะชื่อเพื่อดูเนื้อหาใหม่ แก้ได้ก่อนใช้ ของเดิมยังอยู่จนกว่าจะกดบันทึก (และกดย้อนได้)</div>
      <div class="lm_sugrows">${rows.map(([e, r]) => `
        <div class="lm_sugrow">
          <label class="lm_checkrow lm_inline"><input type="checkbox" data-act="d-con" data-uid="${e.uid}" ${r.on ? 'checked' : ''}>
            <span class="lm_grow"><b>${esc(nameOf(e))}</b><br><small>≈${fmt(estTokens(e.content))} → ≈${fmt(estTokens(r.text))} โทเคน (${Math.round(estTokens(r.text) / Math.max(1, estTokens(e.content)) * 100)}%)</small></span></label>
          <button class="lm_link" data-act="d-cexp" data-uid="${e.uid}">${S.cexpand.has(e.uid) ? 'ซ่อน' : 'ดู / แก้'}</button>
          ${S.cexpand.has(e.uid) ? `<textarea class="lm_input lm_preview" rows="10" data-act="d-cedit" data-uid="${e.uid}">${esc(r.text)}</textarea>` : ''}
        </div>`).join('')}</div>
      <div class="lm_row lm_wrap">
        <button class="lm_btn lm_primary" data-act="d-capply" ${on.length ? '' : 'disabled'}>${icon('fa-check')} ใช้ ${on.length} เอนทรี (ประหยัด ≈${fmt(saved)} โทเคน)</button>
        <button class="lm_btn" data-act="d-ccancel">ทิ้งทั้งหมด</button>
      </div>`;
}

function pushHistory() { S.history.push({ work: S.work, applied: [...S.applied] }); S.saved = null; }

function applyThai() {
    pushHistory();
    let n = 0;
    S.work = structuredClone(S.work);
    for (const e of S.work) {
        const r = S.thai.get(e.uid);
        if (!r?.on.size) continue;
        e.key = cleanKeys([...(e.key ?? []), ...r.on]);
        n += r.on.size;
    }
    if (S.glossary) S.work = upsertGlossaryList(S.work, St.template());
    S.applied.push(`เพิ่มคีย์ไทย — ${n} คีย์${S.glossary ? ' + อภิธานชื่อ' : ''}`);
    S.thai = null;
    rediagnose();
    shell.render();
}
function applyCondense() {
    pushHistory();
    S.work = structuredClone(S.work);
    let n = 0;
    for (const e of S.work) {
        const r = S.condensed.get(e.uid);
        if (r?.on) { e.content = r.text; n++; }
    }
    S.applied.push(`ย่อเนื้อหา — ${n} เอนทรี`);
    S.condensed = null;
    rediagnose();
    shell.render();
}

function applyFix(issueIds) {
    const picked = S.issues.filter(i => issueIds.includes(i.id));
    const changes = picked.flatMap(i => i.changes.filter(c => c.checked));
    if (!changes.length) return;
    S.history.push({ work: S.work, applied: [...S.applied] });
    S.work = applyChanges(S.work, changes);
    const kept = S.work.keptKeys ?? [];
    if (kept.length) toast.info(`${kept.length} เอนทรีจะไม่เหลือคีย์เลย จึงเก็บคีย์สุดท้ายไว้ให้: ${kept.slice(0, 5).map(k => `${k.name} (“${k.key}”)`).join(', ')}${kept.length > 5 ? ' …' : ''}`, 'Lore Master', { timeOut: 9000 });
    for (const i of picked) {
        const n = i.changes.filter(c => c.checked).length;
        if (n) S.applied.push(`${i.short ?? i.title} — ${n} รายการ`);
    }
    S.saved = null;
    rediagnose();
    shell.render();
}

function viewTest() {
    const o = scanOpts();
    const text = S.simText;
    return `
    <p class="lm_lead">พิมพ์หรือวางข้อความ ดูว่าจะมีเอนทรีไหนติดบ้าง เทียบก่อนและหลังซ่อม ไม่เสียโควต้า API</p>
    <textarea class="lm_input lm_text" rows="6" placeholder="เช่น Cody เดินไปห้องสมุดกับ Jonah…" data-act="d-simtext">${esc(text)}</textarea>
    <div class="lm_row lm_wrap">
      <button class="lm_btn" data-act="d-usechat" ${St.chatSample() ? '' : 'disabled'}>${icon('fa-comments')} ใช้ข้อความล่าสุดในแชท</button>
      <label class="lm_checkrow lm_inline"><input type="checkbox" data-act="d-simrec" ${o.recursive ? 'checked' : ''}><span>recursion${S.simRecursive === null ? ' (ตามที่ตั้งใน ST)' : ''}</span></label>
    </div>
    <p class="lm_hint">จำลองแบบติดมากที่สุด: ไม่นับ probability, inclusion group และงบโทเคน ของจริงอาจติดน้อยกว่านี้ ดูของจริงได้ใน Lore Lens</p>
    <div class="lm_result">${testResult(text, o)}</div>`;
}
/** Simulations are cached per (entries, text, options): re-rendering on every tap must not redo them. */
const simCache = new WeakMap();
function simMemo(entries, text, o) {
    const key = `${text}\u0000${o.recursive}|${o.wholeWords}|${o.caseSensitive}`;
    let m = simCache.get(entries);
    if (!m) { m = new Map(); simCache.set(entries, m); }
    if (!m.has(key)) { if (m.size > 6) m.clear(); m.set(key, simulate(entries, text, o)); }
    return m.get(key);
}

function testResult(text, o) {
    if (!text.trim()) return '';
    const before = simMemo(S.base, text, o);
    const now = simMemo(S.work, text, o);
    const nowSet = new Set(now.hits.map(h => h.entry.uid));
    const gone = before.hits.filter(h => S.work.some(e => e.uid === h.entry.uid) && !nowSet.has(h.entry.uid));
    return `
    <div class="lm_card">${vs(before, now)}</div>
    <h3 class="lm_h">ที่ติดตอนนี้</h3>
    <div class="lm_list">${now.hits.map(h => `
      <div class="lm_card lm_hit">
        <span class="lm_tag ${h.via === 'constant' ? 'lm_t_const' : h.via === 'recursion' ? 'lm_t_rec' : 'lm_t_key'}">${h.via === 'constant' ? 'ติดตลอด' : h.via === 'recursion' ? `ลูกโซ่ R${h.step}` : 'คีย์'}</span>
        <div class="lm_grow lm_minw0"><div class="lm_name">${esc(h.entry.comment || `#${h.entry.uid}`)}</div>
        <div class="lm_dim">${h.key ? `คีย์ “${esc(h.key)}” · ` : ''}≈${estTokens(h.entry.content)} โทเคน${h.entry._src && S.sources.length > 1 ? ` · ${esc(h.entry._src)}` : ''}</div></div>
      </div>`).join('') || '<div class="lm_dim">ไม่มีเอนทรีไหนติด</div>'}</div>
    ${gone.length ? `<h3 class="lm_h">ไม่ติดแล้วหลังซ่อม (${gone.length})</h3><div class="lm_dim lm_gone">${gone.map(h => esc(h.entry.comment || `#${h.entry.uid}`)).join(' · ')}</div>` : ''}`;
}

function viewSave() {
    const cc = St.currentChar();
    const books = St.charBooks(cc);
    const srcBooks = S.sources.filter(s => s.book).map(s => s.book);
    const single = S.sources.length === 1 && srcBooks.length === 1 ? srcBooks[0] : null;
    const name = S.saveMode === 'overwrite' && single ? single : S.saveName;
    const exists = S.saveMode !== 'overwrite' && St.bookNames().includes(S.saveName.trim());
    const oldPrimaryLost = cc && S.linkChar && books.primary && books.primary !== name && !srcBooks.includes(books.primary);
    const linkedSources = cc ? srcBooks.filter(b => (b === books.primary || books.extra.includes(b)) && b !== name) : [];
    const sum = summarize(S.work);
    if (S.saved) {
        return `<div class="lm_card lm_done lm_center">
          <div class="lm_bigicon">${icon('fa-circle-check')}</div>
          <h3>บันทึก “${esc(S.saved.name)}” แล้ว</h3>
          <p>${S.saved.linked ? `ตั้งเป็น lorebook หลักของ ${esc(S.saved.linked)} แล้ว เวลา export การ์ด เล่มนี้จะติดไปกับการ์ด` : 'ไปผูกกับการ์ดหรือแชทได้จากเมนูของเล่ม'}</p>
          ${S.saved.cap ? `<p class="lm_dim">จำกัดไม่เกิน ${S.saved.cap} เอนทรีต่อเทิร์น (เฉพาะเครื่องที่ลง Lore Master)</p>` : ''}
          <div class="lm_row lm_wrap lm_centerrow">
            <button class="lm_btn lm_primary" data-act="d-openbook" data-book="${esc(S.saved.name)}">${icon('fa-pen')} เปิดแก้ต่อ</button>
            <button class="lm_btn" data-act="d-download">${icon('fa-download')} ดาวน์โหลด .json</button>
            ${S.saved.backup ? `<button class="lm_btn" data-act="d-restore" data-book="${esc(S.saved.name)}">${icon('fa-clock-rotate-left')} กู้เล่มเดิมคืน</button>` : ''}
          </div></div>`;
    }
    return `
    <div class="lm_stats"><div><b>${sum.count}</b><span>เอนทรี</span></div><div><b>≈${fmt(sum.tokens)}</b><span>โทเคน</span></div><div><b>${S.applied.length}</b><span>ข้อที่ซ่อม</span></div></div>
    <div class="lm_card lm_form">
      ${single ? `
        <label class="lm_checkrow"><input type="radio" name="lm_mode" data-act="d-mode" value="overwrite" ${S.saveMode === 'overwrite' ? 'checked' : ''}><span>เขียนทับเล่มเดิม “${esc(single)}” <small>(สำรองเล่มเดิมไว้ในเบราว์เซอร์ก่อน กู้คืนได้)</small></span></label>
        <label class="lm_checkrow"><input type="radio" name="lm_mode" data-act="d-mode" value="new" ${S.saveMode === 'new' ? 'checked' : ''}><span>บันทึกเป็นเล่มใหม่</span></label>` : ''}
      ${S.saveMode !== 'overwrite' || !single ? `
        <label class="lm_label" for="lm_name">ชื่อเล่ม</label>
        <input id="lm_name" class="lm_input" value="${esc(S.saveName)}" data-act="d-name">
        ${exists ? `<div class="lm_warn">${icon('fa-triangle-exclamation')} มีเล่มชื่อนี้อยู่แล้ว จะเขียนทับ (สำรองเล่มเดิมไว้ให้ก่อน)</div>` : ''}` : ''}
      ${S.sources.length > 1 ? `<label class="lm_checkrow"><input type="checkbox" data-act="d-prefix" ${S.prefixSource ? 'checked' : ''}><span>ใส่ชื่อเล่มเดิมหน้าชื่อเอนทรี เช่น <code>[${esc(S.sources[0].name)}] …</code> หาง่ายขึ้น</span></label>` : ''}
      ${cc ? `
        <label class="lm_checkrow"><input type="checkbox" data-act="d-link" ${S.linkChar ? 'checked' : ''}><span>ตั้งเป็น lorebook หลักของ <b>${esc(cc.ch.name)}</b><br><small>เวลา export การ์ด เล่มนี้จะฝังไปในการ์ด คนที่ได้การ์ดไปใช้ได้เลยโดยไม่ต้องลง Lore Master</small></span></label>
        ${oldPrimaryLost ? `<div class="lm_warn">${icon('fa-circle-info')} เล่มหลักเดิม “${esc(books.primary)}” จะย้ายไปเป็นเล่มเสริมของการ์ด ไม่หายไปไหน</div>` : ''}
        ${S.linkChar && linkedSources.length ? `<label class="lm_checkrow"><input type="checkbox" data-act="d-unlink" ${S.unlinkOld ? 'checked' : ''}><span>ถอดเล่มที่รวมแล้วออกจากการ์ด: ${linkedSources.map(esc).join(', ')}<br><small>ไม่งั้นเนื้อหาเดียวกันจะติดซ้ำ 2 ที่ (ตัวไฟล์เล่มไม่ถูกลบ)</small></span></label>` : ''}` : ''}
      <label class="lm_checkrow"><input type="checkbox" data-act="d-capon" ${S.capOn ? 'checked' : ''}><span>จำกัดไม่เกิน <input type="number" min="1" max="99" class="lm_input lm_num" value="${S.capN}" data-act="d-capn"> เอนทรีต่อเทิร์นจากเล่มนี้<br><small>กันระเบิด ถ้าติดเกินจะตัดตัวที่สำคัญน้อยสุด (order ต่ำ / ติดจากลูกโซ่) ทิ้งก่อน ทำงานเฉพาะเครื่องที่ลง Lore Master</small></span></label>
    </div>
    <button class="lm_btn lm_primary lm_big" data-act="d-save" ${S.busy ? 'disabled' : ''}>${icon('fa-floppy-disk')} ${S.busy ? 'กำลังบันทึก…' : 'บันทึก'}</button>
    <div class="lm_row lm_centerrow"><button class="lm_btn" data-act="d-download">${icon('fa-download')} ดาวน์โหลด .json แทน</button></div>`;
}

const worldData = () => toWorld(S.work, { prefixSource: S.sources.length > 1 && S.prefixSource, template: St.template() });

async function doSave() {
    const cc = St.currentChar();
    const srcBooks = S.sources.filter(s => s.book).map(s => s.book);
    const single = S.sources.length === 1 && srcBooks.length === 1 ? srcBooks[0] : null;
    const name = St.cleanName(S.saveMode === 'overwrite' && single ? single : S.saveName);
    if (!name) { toast.warning('ตั้งชื่อเล่มก่อน'); return; }
    S.busy = true; shell.render();
    try {
        let backup = false;
        if (St.bookNames().includes(name)) {
            try { await backupPut(name, await W.loadWorldInfo(name)); backup = true; } catch (e) { console.warn(LOG, 'backup failed', e); }
        }
        await W.saveWorldInfo(name, worldData(), true);
        await W.updateWorldInfoList?.();
        St.statCache.delete(name);
        if (St.cur?.name === name) await St.reloadIfOpen(name);
        try { W.reloadEditor?.(name); } catch { /* not shown */ }

        const s = settings();
        if (S.capOn && S.capN > 0) s.caps[name] = Number(S.capN); else delete s.caps[name];
        s.defaultCap = Number(S.capN) || s.defaultCap;
        save();

        let linked = '';
        if (cc && S.linkChar) {
            const books = St.charBooks(cc);
            const drop = new Set(S.unlinkOld ? srcBooks : []);
            drop.add(name);
            const extras = books.extra.filter(b => !drop.has(b));
            if (books.primary && !drop.has(books.primary)) extras.push(books.primary);
            St.setExtras(cc, extras);
            await W.charUpdatePrimaryWorld(name);
            linked = cc.ch.name;
        }
        S.saved = { name, linked, cap: S.capOn ? S.capN : 0, backup };
        toast.success(`บันทึก “${name}” แล้ว`, 'Lore Master');
    } catch (e) {
        console.error(LOG, e);
        toast.error(String(e?.message ?? e), 'บันทึกไม่สำเร็จ');
    } finally {
        S.busy = false;
        shell.render();
    }
}

async function restoreLatest(book) {
    const list = await backupList(book).catch(() => []);
    if (!list.length) { toast.warning('ไม่มีสำรองของเล่มนี้'); return; }
    await W.saveWorldInfo(book, list[0].data, true);
    St.statCache.delete(book);
    await St.reloadIfOpen(book);
    try { W.reloadEditor?.(book); } catch { /* ignore */ }
    toast.success(`กู้ “${book}” คืนเป็นฉบับ ${new Date(list[0].at).toLocaleString()} แล้ว`);
}

// ---------------------------------------------------------------- events

act('click', {
    'd-step': el => { if (el.disabled) return; S.step = el.dataset.step; if (S.step === 'test' && !S.simText) S.simText = St.chatSample(); shell.render(); },
    'd-picker': () => { if (S.picker) rebuild(); S.picker = !S.picker; shell.render(); },
    'd-charbooks': async () => {
        const b = St.charBooks();
        for (const n of [b.primary, ...b.extra].filter(Boolean)) await addBook(n);
        if (!b.primary && !b.extra.length) toast.info('การ์ดนี้ยังไม่มี lorebook');
        rebuild(); shell.render();
    },
    'd-rmsrc': el => { S.sources = S.sources.filter(s => s.id !== Number(el.dataset.id)); rebuild(); shell.render(); },
    'd-fixall': () => applyFix(S.issues.map(i => i.id)),
    'd-fixsafe': () => applyFix(S.issues.filter(i => i.kind === 'safe').map(i => i.id)),
    'd-thai': () => startThai(),
    'd-stop': () => { S.job?.abort.abort(); },
    'd-sug': el => {
        const r = S.thai?.get(Number(el.dataset.uid));
        if (!r) return;
        const k = el.dataset.k;
        r.on.has(k) ? r.on.delete(k) : r.on.add(k);
        shell.render();
    },
    'd-sugall': el => {
        const wc = { names: scanOpts().names, isThaiDictWord };
        for (const [uid, r] of S.thai ?? []) {
            const e = S.work.find(x => x.uid === uid);
            const all = [...r.translit, ...r.nick, ...r.translated];
            r.on = new Set(el.dataset.v === 'all' ? all : el.dataset.v === 'none' ? [] : [...r.translit, ...r.nick].filter(k => !vetThaiKey(k, e, S.work, wc).length));
        }
        shell.render();
    },
    'd-thaiapply': () => applyThai(),
    'd-thaicancel': () => { S.thai = null; shell.render(); },
    'd-gloss': () => {
        pushHistory();
        S.work = upsertGlossaryList(S.work, St.template());
        S.applied.push(`อภิธานชื่อ — ${glossaryLines(S.work).length} ชื่อ`);
        rediagnose();
        shell.render();
    },
    'd-cpick': () => { openCondensePicker(); shell.render(); },
    'd-cpickall': el => { S.cpick = new Set(el.dataset.v === '1' ? live().filter(e => estTokens(e.content) > 200).map(e => e.uid) : []); shell.render(); },
    'd-cratio': el => { S.cratio = Number(el.dataset.v); shell.render(); },
    'd-condense': () => startCondense(),
    'd-ccancel': () => { S.cpick = null; S.condensed = null; S.cexpand.clear(); shell.render(); },
    'd-cexp': el => { const u = Number(el.dataset.uid); S.cexpand.has(u) ? S.cexpand.delete(u) : S.cexpand.add(u); shell.render(); },
    'd-capply': () => applyCondense(),
    'd-fixone': el => applyFix([el.dataset.issue]),
    'd-undo': () => { const h = S.history.pop(); if (h) { S.work = h.work; S.applied = h.applied; S.saved = null; rediagnose(); shell.render(); } },
    'd-expand': el => { const id = el.dataset.issue; S.expanded.has(id) ? S.expanded.delete(id) : S.expanded.add(id); shell.render(); },
    'd-checkall': el => { S.issues.find(x => x.id === el.dataset.issue)?.changes.forEach(c => { c.checked = el.dataset.v === '1'; }); shell.render(); },
    'd-usechat': () => { S.simText = St.chatSample(); shell.render(); },
    'd-save': () => doSave(),
    'd-download': () => download(S.saved?.name || S.saveName || 'lorebook', worldData()),
    'd-restore': el => restoreLatest(el.dataset.book),
    'd-openbook': el => goTo([{ v: 'book', name: el.dataset.book }]),
});

let simTimer = null;
act('input', {
    'd-simtext': el => {
        S.simText = el.value;
        clearTimeout(simTimer);
        simTimer = setTimeout(() => { const box = shell.root?.querySelector('.lm_result'); if (box) box.innerHTML = testResult(S.simText, scanOpts()); }, 300);
    },
    'd-pickq': el => {
        S.pickerQuery = el.value;
        const list = shell.root?.querySelector('.lm_pick_list');
        const tmp = document.createElement('div');
        tmp.innerHTML = viewPicker();
        list?.replaceWith(tmp.querySelector('.lm_pick_list'));
    },
    'd-name': el => { S.saveName = el.value; },
    'd-capn': el => { S.capN = Math.max(1, Math.min(99, Number(el.value) || 1)); },
});

act('input', {
    'd-cedit': el => { const r = S.condensed?.get(Number(el.dataset.uid)); if (r) r.text = el.value; },
});

act('change', {
    'd-glosson': el => { S.glossary = el.checked; },
    'd-cpickone': el => { const u = Number(el.dataset.uid); el.checked ? S.cpick.add(u) : S.cpick.delete(u); shell.render(); },
    'd-con': el => { const r = S.condensed?.get(Number(el.dataset.uid)); if (r) { r.on = el.checked; shell.render(); } },
    'd-files': async el => { if (await readFiles([...el.files])) rebuild(); el.value = ''; shell.render(); },
    'd-pickbook': async el => { if (el.checked) await addBook(el.dataset.book); else S.sources = S.sources.filter(s => s.book !== el.dataset.book); rebuild(); shell.render(); },
    'd-pos': el => { settings().position = Number(el.value); save(); rereadSources(); rebuild(); shell.render(); },
    'd-check': el => { for (const i of S.issues) for (const c of i.changes) if (c.id === el.dataset.id) c.checked = el.checked; shell.render(); },
    'd-simrec': el => { S.simRecursive = el.checked; shell.render(); },
    'd-mode': el => { S.saveMode = el.value; shell.render(); },
    'd-name': () => shell.render(),
    'd-prefix': el => { S.prefixSource = el.checked; },
    'd-link': el => { S.linkChar = el.checked; shell.render(); },
    'd-unlink': el => { S.unlinkOld = el.checked; },
    'd-capon': el => { S.capOn = el.checked; },
});

/** Remember whether the guide was opened or closed, across re-renders. */
export function onDoctorToggle(ev) {
    if (ev.target?.matches?.('[data-guide]')) S.guideOpen = ev.target.open;
}

export function initDoctor() { S.capN = settings().defaultCap; }
