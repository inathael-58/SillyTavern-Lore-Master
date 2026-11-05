/*
 * Lore Master — settings screen: SillyTavern's global World Info settings (in plain Thai)
 * and Lore Master's own options.
 */

import * as St from './store.js';
import { settings, save, DEFAULTS } from './prefs.js';
import { esc, icon, act, shell, sheet, toast, switchHtml, rangeHtml, paintRange, valboxInput } from './ui.js';
import { aiSettings, profiles, memoryHubSources, copyFromMemoryHub, ask, lastCall, TASKS, usedToday, sourceLabel } from './ai.js';
import { nameCache, clearNameCache } from './cache.js';

const collator = new Intl.Collator(['th', 'en'], { sensitivity: 'base', numeric: true });

export function viewSettings() {
    const s = settings();
    const globals = St.globalBooks();
    const haveST = !!document.getElementById('world_info_depth');
    const caps = Object.entries(s.caps);
    return {
        title: 'ตั้งค่า',
        sub: 'World Info ของ ST และ Lore Master',
        body: `
        <h3 class="lm_h">${icon('fa-globe')} เล่ม Global <small>· ใช้กับทุกแชท</small></h3>
        <div class="lm_card">
          <div class="lm_chipbox lm_chipbox_static">${globals.map(n => `<span class="lm_chip">${esc(n)}<button data-act="s-gx" data-name="${esc(n)}" aria-label="เอาออกจาก Global">${icon('fa-xmark')}</button></span>`).join('') || '<span class="lm_dim">ยังไม่มี</span>'}
            <button class="lm_chip lm_chip_add" data-act="s-gadd">${icon('fa-plus')} เพิ่ม</button></div>
          <div class="lm_hint">เล่ม Global ถูกสแกนในทุกแชทของทุกตัวละคร ใส่เฉพาะเล่มที่ใช้ร่วมกันจริง ๆ</div>
        </div>

        <h3 class="lm_h">${icon('fa-sliders')} การสแกน World Info <small>· ค่ารวมของ ST</small></h3>
        <div class="lm_card lm_settings">${haveST ? St.GLOBAL_SETTINGS.map(globalRow).join('') : '<div class="lm_dim">ไม่เจอหน้าตั้งค่า World Info ของ ST</div>'}</div>

        <h3 class="lm_h">${icon('fa-heart-pulse')} สถานะ</h3>
        <div class="lm_card lm_status">${statusBlock()}</div>

        <h3 class="lm_h">${icon('fa-hand')} เบรกฉุกเฉิน <small>· กัน lorebook ระเบิดจน ST ค้าง</small></h3>
        <div class="lm_card lm_settings">${guardBlock()}</div>

        <h3 class="lm_h">${icon('fa-robot')} AI <small>· คิดคีย์ไทย ย่อเนื้อหา</small></h3>
        <div class="lm_card">${aiBlock()}</div>

        <h3 class="lm_h">${icon('fa-spell-check')} อภิธานชื่อ</h3>
        <div class="lm_card lm_settings">
          ${prefRow('glossarySmart', 'โหมดประหยัด', 'แทนที่จะส่งอภิธานทั้งรายการทุกเทิร์น ส่งเฉพาะชื่อที่โผล่ในแชทล่าสุดหรือเป็นของเอนทรีที่ติด ทำงานเฉพาะเครื่องที่ลง Lore Master คนอื่นที่ได้เล่มไปยังได้ทั้งรายการตามปกติ')}
          <div class="lm_hint">สร้างอภิธานได้จากเมนู ⋯ ของเล่ม หรือในหน้า ตรวจ & รวม</div>
        </div>

        <h3 class="lm_h">${icon('fa-right-left')} หน้า World Info เดิมของ ST <small>· ใช้คู่กันหรือใช้แทน</small></h3>
        <div class="lm_card lm_settings">${worldInfoBlock()}</div>

        <h3 class="lm_h">${icon('fa-door-open')} ทางเข้า Lore Master</h3>
        <div class="lm_card lm_settings">
          ${prefRow('launcher', 'ปุ่มลอย', 'ลากไปวางตรงไหนก็ได้ ดูดติดขอบ เก็บเข้า Quick Dock ได้ (เลือกปุ่มบนจอ)')}
          ${prefRow('topbar', 'ไอคอนบนแถบด้านบน', s.replaceWorldInfo ? 'ตอนนี้ปุ่ม World Info ของ ST เปิด Lore Master อยู่แล้ว ไม่ต้องเปิดอันนี้ก็ได้' : 'ไอคอนแยกของ Lore Master ข้างปุ่ม World Info ของ ST')}
          ${prefRow('wand', 'เมนูไม้กายสิทธิ์ (Extensions)', '')}
          <div class="lm_hint">พิมพ์ <code>/lore</code> หรือ <code>/lore ชื่อเล่ม</code> ได้เสมอ ใช้ทำปุ่มใน Quick Reply / Quick Dock ได้ · ปุ่ม “เปิดใน lorebook” ของ Lore Lens เปิดเอนทรีที่นี่ (ปิดได้ในการตั้งค่าของ Lore Lens)</div>
          <div class="lm_row lm_wrap">
            <button class="lm_btn" data-act="s-resetpos">${icon('fa-arrows-to-dot')} รีเซ็ตตำแหน่งปุ่มลอย</button>
          </div>
        </div>

        <h3 class="lm_h">${icon('fa-palette')} หน้าตา</h3>
        <div class="lm_card">
          <div class="lm_seg lm_seg3">${[['theme', 'fa-palette', 'ตามธีม'], ['light', 'fa-sun', 'สว่าง'], ['dark', 'fa-moon', 'มืด']].map(([k, ic, lab]) =>
                `<button class="lm_segbtn ${s.scheme === k ? 'lm_on' : ''}" data-act="s-scheme" data-v="${k}">${icon(ic)} ${lab}</button>`).join('')}</div>
        </div>

        <h3 class="lm_h">${icon('fa-shield-halved')} จำกัดเอนทรีต่อเทิร์น</h3>
        <div class="lm_card">
          ${caps.length ? caps.map(([n, c]) => `
            <div class="lm_caprow"><span class="lm_grow lm_minw0">${esc(n)}</span>
              <input type="number" min="1" max="99" class="lm_input lm_num" data-act="s-cap" data-name="${esc(n)}" value="${c}">
              <button class="lm_icon" data-act="s-capx" data-name="${esc(n)}" aria-label="เลิกจำกัด">${icon('fa-xmark')}</button></div>`).join('')
            : '<div class="lm_dim">ยังไม่มีเล่มที่จำกัด</div>'}
          <button class="lm_btn lm_mt" data-act="s-capadd">${icon('fa-plus')} จำกัดเล่ม…</button>
          <div class="lm_hint">ถ้าเล่มนั้นติดเกินจำนวนนี้ในเทิร์นเดียว จะตัดตัวที่ติดทีหลังสุด (order ต่ำ / ติดจากลูกโซ่) ทิ้งก่อน เอนทรีติดตลอดไม่ถูกตัด ทำงานเฉพาะเครื่องที่ลง Lore Master</div>
        </div>
        <div class="lm_bottom_pad"></div>`,
    };
}

function globalRow(def) {
    const v = St.readGlobal(def);
    if (v === null) return '';
    if (def.type === 'check') {
        return `<div class="lm_setrow"><div class="lm_grow"><b>${esc(def.label)}</b><small>${esc(def.help)}</small></div>${switchHtml(`data-act="s-global" data-id="${def.id}"`, v)}</div>`;
    }
    if (def.type === 'select') {
        return `<div class="lm_setrow lm_setcol"><div><b>${esc(def.label)}</b><small>${esc(def.help)}</small></div>
          <select class="lm_input" data-act="s-global" data-id="${def.id}">${def.options.map(([val, lab]) => `<option value="${val}" ${Number(v) === val ? 'selected' : ''}>${esc(lab)}</option>`).join('')}</select></div>`;
    }
    const max = Math.min(def.max, def.id === 'world_info_budget_cap' ? 8192 : def.id === 'world_info_depth' ? 50 : def.max);
    return `<div class="lm_setrow lm_setcol lm_rangeset">
      <div class="lm_rangehead"><b>${esc(def.label)}</b>
        <label class="lm_valbox">${valboxInput(`data-act="s-global" data-id="${def.id}" aria-label="${esc(def.label)}"`, v, def.min, def.max)}${def.unit ? `<span>${def.unit}</span>` : ''}</label></div>
      ${rangeHtml(`data-act="s-global" data-id="${def.id}" aria-label="${esc(def.label)}"`, v, def.min, max)}
      <small>${esc(def.help)}</small></div>`;
}

/** What Lore Master sees: is it hooked into the scan, what did the last scan put in, how big is the context. */
function statusBlock() {
    const lm = globalThis.LoreMaster;
    const st = lm?.status?.() ?? { events: {} };
    const c = St.ctx();
    const f = n => Number(n).toLocaleString();
    const ok = (v, yes, no) => `<div class="lm_statrow ${v ? 'lm_ok' : 'lm_bad'}">${icon(v ? 'fa-circle-check' : 'fa-circle-xmark')} ${v ? yes : no}</div>`;
    // context the prompt can use (Chat Completion keeps its own numbers)
    const cc = c.mainApi === 'openai' ? c.chatCompletionSettings : null;
    const ctxSize = Number(cc ? cc.openai_max_context : c.maxContext) || 0;
    const resp = Number(cc ? cc.openai_max_tokens : c.amount_gen ?? 0) || 0;
    const prompt = Math.max(0, ctxSize - resp);
    const pct = Number(St.readGlobal(St.GLOBAL_SETTINGS.find(d => d.id === 'world_info_budget'))) || 0;
    const cap = Number(St.readGlobal(St.GLOBAL_SETTINGS.find(d => d.id === 'world_info_budget_cap'))) || 0;
    let budget = Math.round(prompt * pct / 100);
    if (cap > 0) budget = Math.min(budget, cap);
    const s = st.scan;
    return `
      <div class="lm_statrow">${icon('fa-book-atlas')} Lore Master ที่รันอยู่: <b>v${esc(lm?.version ?? '?')}</b> <span data-lm-remote>${!lm?.remote?.() ? '' : lm.isStale() ? `· ติดตั้งไว้ <b>v${esc(lm.remote())}</b> <span class="lm_stale">ยังไม่ได้โหลด กด “โหลดเวอร์ชันล่าสุด”</span>` : '· เป็นเวอร์ชันล่าสุดที่ติดตั้งไว้แล้ว'}</span>
        <div class="lm_row lm_wrap lm_mini"><button class="lm_btn" data-act="s-vcheck">${icon('fa-magnifying-glass')} เช็คเวอร์ชัน</button><button class="lm_btn" data-act="s-reload">${icon('fa-rotate')} โหลดเวอร์ชันล่าสุด</button></div></div>
      ${ok(st.events.before && st.events.after, 'เชื่อมกับการสแกน World Info ของ ST ได้ (เบรกฉุกเฉินและโหมดประหยัดทำงานได้)', `ST รุ่นนี้ไม่มี event ${[!st.events.before && 'WORLDINFO_ENTRIES_LOADED', !st.events.after && 'WORLDINFO_SCAN_DONE'].filter(Boolean).join(', ')} เบรกฉุกเฉินทำงานไม่ได้ ต้องอัปเดต ST`)}
      ${s ? `<div class="lm_statrow">${icon('fa-magnifying-glass')} สแกนล่าสุด ${new Date(s.at).toLocaleTimeString()}: ติด <b>${f(s.count)}</b> เอนทรี ≈<b>${f(s.tokens)}</b> โทเคน (จาก ${f(s.loaded)} เอนทรีที่โหลด)${s.braked ? ' · <b>เบรกทำงาน</b>' : ''}</div>
        ${Object.keys(s.books).length ? `<div class="lm_dim lm_statbooks">${Object.entries(s.books).map(([b, n]) => `${esc(b)}: ${n}`).join(' · ')}</div>` : ''}`
        : `<div class="lm_statrow lm_dim">${icon('fa-hourglass')} ยังไม่เห็นการสแกนตั้งแต่เปิด ST (ส่งข้อความหรือเปิดแชทก่อน)</div>`}
      ${ctxSize ? `<div class="lm_statrow">${icon('fa-ruler-horizontal')} Context ${f(ctxSize)} − ตอบได้ ${f(resp)} = เหลือให้ prompt <b>${f(prompt)}</b> โทเคน</div>
        <div class="lm_statrow">${icon('fa-coins')} งบ lorebook ของ ST: ${pct}%${cap ? ` (เพดาน ${f(cap)})` : ''} = <b>${f(budget)}</b> โทเคน${settings().guard ? ` · เบรกของ Lore Master ${f(settings().guardMaxTokens)}` : ''}</div>
        ${prompt <= 0 ? `<div class="lm_warn">${icon('fa-triangle-exclamation')} ความยาวคำตอบ (Max Response Length) เท่ากับหรือมากกว่า Context จะไม่เหลือที่ให้ prompt เลย จะขึ้น "Mandatory prompts exceed the context size"</div>` : ''}` : ''}`;
}

function guardBlock() {
    const s = settings();
    const t = globalThis.LoreMaster?.lastTrip?.();
    const f = n => Number(n).toLocaleString();
    return `
      ${prefRow('guard', 'เปิดเบรกฉุกเฉิน', 'ทุกเทิร์น ก่อน ST สแกน จะดูว่าแชทจะทำให้ติดกี่เอนทรี และหลังแต่ละรอบจะดูว่าลูกโซ่รอบถัดไปจะดึงมาอีกเท่าไหร่ ถ้าเกินที่ตั้ง จะตัดตัวที่สำคัญน้อยสุดและหยุดลูกโซ่ ใช้กับทุกเล่ม ไม่แก้ไฟล์เล่ม')}
      <div class="lm_two">
        <label><span class="lm_label">เอนทรีต่อเทิร์นไม่เกิน</span><input type="number" class="lm_input" min="5" max="500" value="${s.guardMaxEntries}" data-act="s-gnum" data-k="guardMaxEntries" inputmode="numeric"></label>
        <label><span class="lm_label">โทเคน lore ต่อเทิร์นไม่เกิน</span><input type="number" class="lm_input" min="2000" max="500000" step="1000" value="${s.guardMaxTokens}" data-act="s-gnum" data-k="guardMaxTokens" inputmode="numeric"></label>
      </div>
      <div class="lm_hint">ค่าเริ่มต้น 40 เอนทรี / 25,000 โทเคน เกินนี้แทบไม่มีบอทไหนตั้งใจให้ติดจริง นับโทเคนแบบประมาณ</div>
      ${prefRow('warnBigBooks', 'เตือนเมื่อเปิดแชทที่ใช้ lorebook ใหญ่มาก', 'เกิน 300 เอนทรี หรือ 100,000 โทเคน แตะการแจ้งเตือนเพื่อตรวจเล่มได้เลย')}
      ${t ? `<div class="lm_warn">${icon('fa-hand')} เบรกล่าสุด ${new Date(t.at).toLocaleTimeString()}: ${t.book ? `“${esc(t.book)}” ` : ''}${t.kind === 'chain' ? 'ลูกโซ่จะดึง' : 'จะติด'} ${f(t.would)} เอนทรี ≈${f(t.wouldTokens)} โทเคน → เหลือ ${f(t.kept)} เอนทรี ≈${f(t.keptTokens)} โทเคน</div>` : ''}`;
}

let testing = false;
let aiTab = 'main';     // which list is being edited: main | keys | condense
let cachedNames = null; // count of remembered names, loaded once
/** The list being edited, creating a task's own list (a copy of the main one) when needed. */
function editList() {
    const a = aiSettings();
    if (aiTab === 'main') return a.sources;
    if (!a.tasks[aiTab]) a.tasks[aiTab] = [...a.sources];
    return a.tasks[aiTab];
}
function aiBlock() {
    const a = aiSettings();
    const profs = profiles();
    const mh = memoryHubSources();
    if (cachedNames === null) nameCache().then(m => { cachedNames = m.size; shell.render(); });
    const options = sel => [['main', 'API หลักของ ST (ที่เลือกอยู่ตอนนี้)'], ...profs.map(p => [p.id, `Profile: ${p.name}`])]
        .map(([v, l]) => `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(l)}</option>`).join('');
    const own = aiTab !== 'main' && !!a.tasks[aiTab];
    const list = aiTab === 'main' ? a.sources : (a.tasks[aiTab] ?? a.sources);
    const editable = aiTab === 'main' || own;
    const tabs = [['main', 'ชุดหลัก'], ...Object.entries(TASKS)].map(([k, l]) => {
        const custom = k !== 'main' && a.tasks[k];
        return `<button class="lm_segbtn ${aiTab === k ? 'lm_on' : ''}" data-act="s-aitab" data-v="${k}">${esc(l)}${custom ? ' ●' : ''}</button>`;
    }).join('');
    return `
      <div class="lm_dim">เรียงลำดับ API ที่จะใช้ ตัวแรกล่ม ไม่ตอบ หรือตอบมั่ว จะลองตัวถัดไปเอง ตั้งแยกตามงานได้ เช่น คิดคีย์ไทยใช้โมเดลเล็ก (flash-lite) ส่วนย่อเนื้อหาใช้โมเดลที่เก่งกว่า (flash)</div>
      <div class="lm_seg lm_seg3 lm_mt">${tabs}</div>
      ${aiTab !== 'main' ? `<div class="lm_setrow"><div class="lm_grow"><b>ใช้ชุดหลัก</b><small>${own ? `งาน “${esc(TASKS[aiTab])}” ใช้รายการของตัวเองด้านล่าง` : `งาน “${esc(TASKS[aiTab])}” ใช้ชุดหลัก ปิดเพื่อตั้งแยก`}</small></div>${switchHtml('data-act="s-taskmain"', !own)}</div>` : ''}
      <div class="lm_srclist">${list.map((id, i) => `
        <div class="lm_srcrow">
          <span class="lm_srcnum">${i + 1}</span>
          ${editable ? `<select class="lm_input" data-act="s-src" data-i="${i}">${options(id)}${id !== 'main' && !profs.some(p => p.id === id) ? `<option value="${esc(id)}" selected>(profile ที่ถูกลบไปแล้ว)</option>` : ''}</select>` : `<span class="lm_grow lm_srcname">${esc(sourceLabel(id))}</span>`}
          <small class="lm_used" title="ครั้งที่ส่งไปวันนี้จากเครื่องนี้ (นับทุกครั้งที่ลอง รวมที่ล้มเหลว)">วันนี้ ${usedToday(id)}</small>
          ${editable ? `<button class="lm_icon" data-act="s-srcup" data-i="${i}" ${i ? '' : 'disabled'} aria-label="เลื่อนขึ้น">${icon('fa-arrow-up')}</button>
          <button class="lm_icon" data-act="s-srcx" data-i="${i}" ${list.length > 1 ? '' : 'disabled'} aria-label="ลบ">${icon('fa-xmark')}</button>` : ''}
        </div>`).join('')}</div>
      ${profs.length ? '' : '<div class="lm_warn">ยังไม่มี Connection Profile (ตั้งได้ในแผง API Connections ของ ST → Connection Profiles) ตอนนี้จะใช้ API หลัก</div>'}
      <div class="lm_row lm_wrap">
        ${editable ? `<button class="lm_btn" data-act="s-srcadd">${icon('fa-plus')} เพิ่ม API สำรอง</button>` : ''}
        ${mh && aiTab === 'main' ? `<button class="lm_btn" data-act="s-srcmh">${icon('fa-copy')} ใช้ชุดเดียวกับ Memory Hub</button>` : ''}
        <button class="lm_btn" data-act="s-aitest" ${testing ? 'disabled' : ''}>${testing ? '<span class="lm_spin lm_spin_sm"></span> กำลังทดสอบ…' : `${icon('fa-plug-circle-check')} ทดสอบ${aiTab === 'main' ? '' : ` (${esc(TASKS[aiTab])})`}`}</button>
      </div>
      ${lastCall ? `<div class="${lastCall.ok ? 'lm_okline' : 'lm_warn'}">${lastCall.ok ? `${icon('fa-circle-check')} ล่าสุด: ${esc(lastCall.label)} ตอบใน ${(lastCall.ms / 1000).toFixed(1)} วินาที` : `${icon('fa-triangle-exclamation')} ${esc(lastCall.error)}`}</div>` : ''}
      <div class="lm_setrow"><div class="lm_grow"><b>รอคำตอบนานสุด</b><small>เกินนี้ถือว่าไม่ตอบ แล้วลองตัวถัดไป</small></div>
        <input type="number" class="lm_input lm_num" min="15" max="600" value="${a.timeoutSec}" data-act="s-timeout"> <span>วินาที</span></div>
      <div class="lm_setrow lm_setcol"><div><b>ย่อเนื้อหาให้เหลือประมาณ</b><small>ค่าเริ่มต้นของปุ่ม ✨ ย่อเนื้อหา</small></div>
        <div class="lm_seg lm_seg3">${[[0.65, 'สองในสาม'], [0.5, 'ครึ่งหนึ่ง'], [0.35, 'หนึ่งในสาม']].map(([v, l]) => `<button class="lm_segbtn ${Number(settings().condenseRatio) === v ? 'lm_on' : ''}" data-act="s-ratio" data-v="${v}">${l}</button>`).join('')}</div></div>
      <div class="lm_setrow"><div class="lm_grow"><b>ชื่อที่จำคำตอบไว้</b><small>${cachedNames === null ? '…' : `${cachedNames.toLocaleString()} ชื่อ`} · ชื่อพวกนี้ไม่ต้องถาม AI ซ้ำ (เก็บในเบราว์เซอร์นี้) ล้างถ้าอยากให้ถามใหม่ทั้งหมด</small></div>
        <button class="lm_btn" data-act="s-namesclear" ${cachedNames ? '' : 'disabled'}>${icon('fa-eraser')} ล้าง</button></div>`;
}

/** Side by side (default) or in place of ST's own World Info panel. */
function worldInfoBlock() {
    const on = !!settings().replaceWorldInfo;
    const opt = (v, ic, label) => `<button class="lm_segbtn ${on === v ? 'lm_on' : ''}" data-act="s-wimode" data-v="${v ? 1 : 0}" aria-pressed="${on === v}">${icon(ic)} ${label}</button>`;
    return `
      <div class="lm_seg lm_seg2" role="group" aria-label="ใช้คู่กันหรือใช้แทน">
        ${opt(false, 'fa-clone', 'ใช้คู่กัน')}
        ${opt(true, 'fa-right-left', 'ใช้แทน')}
      </div>
      <div class="lm_hint">${on
        ? '<b>ใช้แทน:</b> ปุ่มหนังสือ (World Info) บนแถบด้านบน ปุ่มลูกโลกในหน้าการ์ด และปุ่ม Chat Lore จะเปิด Lore Master แทนหน้าเดิมของ ST · ถ้าต้องการหน้าเดิมสักครั้ง กดปุ่มพร้อม Shift หรือ Alt หรือกดปุ่มด้านล่าง'
        : '<b>ใช้คู่กัน (ค่าเริ่มต้น):</b> ปุ่มของ ST ทุกปุ่มเปิดหน้า World Info เดิมของ ST ตามปกติ ไม่มีอะไรเปลี่ยน · Lore Master เปิดจากทางของมันเองเท่านั้น (ปุ่มลอย เมนูไม้กายสิทธิ์ <code>/lore</code> ลิงก์จาก Lore Lens) · แก้เล่มเดียวกันได้ทั้งสองที่ บันทึกแล้วอีกฝั่งเห็นตาม'}</div>
      ${prefRow('stPanelButton', 'ปุ่ม “เปิดใน Lore Master” ในหน้า World Info ของ ST', 'ปุ่มเล็กข้างปุ่ม Import เปิดเล่มที่เลือกอยู่ใน Lore Master')}
      ${prefRow('interceptImport', 'ปุ่ม Import ของ ST: ไฟล์ JanitorAI ให้เปิดที่นี่', 'เฉพาะไฟล์ที่ ST import เองไม่ได้ (เช่นของ JanitorAI) ไฟล์ lorebook ปกติ ST import เองเหมือนเดิม')}
      <div class="lm_row lm_wrap">
        <button class="lm_btn" data-act="s-stwi">${icon('fa-book-atlas')} เปิดหน้า World Info เดิมของ ST</button>
      </div>`;
}

function prefRow(key, label, help) {
    return `<div class="lm_setrow"><div class="lm_grow"><b>${esc(label)}</b>${help ? `<small>${esc(help)}</small>` : ''}</div>${switchHtml(`data-act="s-pref" data-k="${key}"`, !!settings()[key])}</div>`;
}

act('click', {
    's-aitab': el => { aiTab = el.dataset.v; shell.render(); },
    's-srcup': el => { const l = editList(); const i = Number(el.dataset.i); if (i > 0) { [l[i - 1], l[i]] = [l[i], l[i - 1]]; save(); shell.render(); } },
    's-srcx': el => { const l = editList(); if (l.length > 1) { l.splice(Number(el.dataset.i), 1); save(); shell.render(); } },
    's-srcadd': () => {
        const l = editList();
        const used = new Set(l);
        const next = profiles().map(p => p.id).find(id => !used.has(id)) ?? (used.has('main') ? null : 'main');
        if (!next) { toast.info('ใส่ทุก API ที่มีแล้ว'); return; }
        l.push(next); save(); shell.render();
    },
    's-namesclear': async () => { await clearNameCache(); cachedNames = 0; toast.success('ล้างชื่อที่จำไว้แล้ว'); shell.render(); },
    's-srcmh': () => { if (copyFromMemoryHub()) { toast.success('ใช้ลำดับ API เดียวกับ Memory Hub แล้ว (แก้แยกได้ภายหลัง)'); shell.render(); } },
    's-aitest': async () => {
        testing = true; shell.render();
        try {
            await ask({ task: aiTab === 'main' ? null : aiTab, system: 'Reply with exactly one word: OK', user: 'ping', maxTokens: 50, accept: out => out });
            toast.success(`${lastCall.label} ตอบใน ${(lastCall.ms / 1000).toFixed(1)} วินาที`, 'เชื่อมต่อได้');
        } catch (e) { toast.error(String(e?.message ?? e), 'เชื่อมต่อไม่ได้'); }
        testing = false; shell.render();
    },
    's-vcheck': async () => {
        const remote = await shell.checkVersion?.();
        const cur = globalThis.LoreMaster?.version;
        if (!remote) toast.warning('อ่านเวอร์ชันบนเซิร์ฟเวอร์ไม่ได้');
        else if (remote === cur) toast.success(`รัน v${cur} อยู่ ตรงกับที่ติดตั้งไว้แล้ว`);
        else toast.info(`ติดตั้งไว้ v${remote} แต่หน้านี้รัน v${cur} กด “โหลดเวอร์ชันล่าสุด”`);
        shell.render();
    },
    's-reload': () => shell.reload?.(),
    's-ratio': el => { settings().condenseRatio = Number(el.dataset.v); save(); shell.render(); },
    's-gx': el => { St.setGlobal(el.dataset.name, false); shell.render(); },
    's-gadd': async () => {
        const g = new Set(St.globalBooks());
        const name = await sheet({ title: 'เพิ่มเล่ม Global', items: St.bookNames().filter(n => !g.has(n)).sort(collator.compare).map(n => ({ value: n, label: n, icon: 'fa-book' })) });
        if (name) { St.setGlobal(name, true); shell.render(); }
    },
    's-scheme': el => { settings().scheme = el.dataset.v; save(); shell.applyScheme?.(); shell.render(); },
    's-resetpos': () => { settings().launcherPos = { ...DEFAULTS.launcherPos }; settings().launcher = true; save(); shell.refreshEntryPoints?.(); shell.render(); },
    's-stwi': () => shell.openStWorldInfo?.(),
    's-wimode': el => {
        const on = el.dataset.v === '1';
        if (!!settings().replaceWorldInfo === on) return;
        settings().replaceWorldInfo = on;
        save();
        shell.refreshEntryPoints?.();
        shell.render();
        toast.success(on ? 'ปุ่ม World Info ของ ST จะเปิด Lore Master แทน' : 'ปุ่ม World Info ของ ST กลับไปเปิดหน้าเดิมแล้ว', 'Lore Master');
    },
    's-capx': el => { delete settings().caps[el.dataset.name]; save(); shell.render(); },
    's-capadd': async () => {
        const s = settings();
        const name = await sheet({ title: 'จำกัดเล่มไหน', items: St.bookNames().filter(n => !s.caps[n]).sort(collator.compare).map(n => ({ value: n, label: n, icon: 'fa-book' })) });
        if (name) { s.caps[name] = s.defaultCap || 10; save(); shell.render(); }
    },
});

act('change', {
    's-src': el => { editList()[Number(el.dataset.i)] = el.value; save(); shell.render(); },
    's-taskmain': el => {
        const a = aiSettings();
        a.tasks[aiTab] = el.checked ? null : [...a.sources];
        save(); shell.render();
    },
    's-gnum': el => { const k = el.dataset.k; settings()[k] = Math.max(k === 'guardMaxEntries' ? 5 : 2000, Number(el.value) || 0); save(); },
    's-timeout': el => { aiSettings().timeoutSec = Math.max(15, Math.min(600, Number(el.value) || 90)); save(); },
    's-pref': el => { settings()[el.dataset.k] = el.checked; save(); shell.refreshEntryPoints?.(); },
    's-global': el => {
        const def = St.GLOBAL_SETTINGS.find(d => d.id === el.dataset.id);
        if (!def) return;
        St.writeGlobal(def, def.type === 'check' ? el.checked : Number(el.value));
        shell.render();
    },
    's-cap': el => { settings().caps[el.dataset.name] = Math.max(1, Number(el.value) || 1); save(); },
});

act('input', {
    's-global': el => {
        // keep the slider and the number box in step while dragging
        const row = el.closest('.lm_rangeset');
        row?.querySelectorAll('input').forEach(x => { if (x !== el) { x.value = el.value; paintRange(x); } });
    },
});

void toast;
