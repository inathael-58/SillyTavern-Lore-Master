/*
 * Lore Master — settings screen: SillyTavern's global World Info settings (in plain Thai)
 * and Lore Master's own options.
 */

import * as St from './store.js';
import { settings, save, DEFAULTS } from './prefs.js';
import { esc, icon, act, shell, sheet, toast, switchHtml } from './ui.js';

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

        <h3 class="lm_h">${icon('fa-door-open')} ทางเข้า Lore Master</h3>
        <div class="lm_card lm_settings">
          ${prefRow('replaceWorldInfo', 'ใช้แทนหน้า World Info ของ ST', 'ปุ่มหนังสือบนแถบด้านบน ปุ่มลูกโลกในการ์ด และ Chat Lore จะเปิด Lore Master แทน')}
          ${prefRow('launcher', 'ปุ่มลอย', 'ลากไปวางตรงไหนก็ได้ ดูดติดขอบ เก็บเข้า Quick Dock ได้ (เลือกปุ่มบนจอ)')}
          ${prefRow('topbar', 'ไอคอนบนแถบด้านบน', 'ถ้าเปิด “ใช้แทนหน้า World Info” อยู่ ไม่ต้องเปิดอันนี้ก็ได้')}
          ${prefRow('wand', 'เมนูไม้กายสิทธิ์ (Extensions)', '')}
          ${prefRow('interceptImport', 'ปุ่ม Import ของ ST: ไฟล์ JanitorAI ให้เปิดที่นี่', 'ST import ไฟล์ของ JanitorAI เองไม่ได้')}
          <div class="lm_hint">พิมพ์ <code>/lore</code> หรือ <code>/lore ชื่อเล่ม</code> ได้เสมอ ใช้ทำปุ่มใน Quick Reply / Quick Dock ได้</div>
          <div class="lm_row lm_wrap">
            <button class="lm_btn" data-act="s-resetpos">${icon('fa-arrows-to-dot')} รีเซ็ตตำแหน่งปุ่มลอย</button>
            <button class="lm_btn" data-act="s-stwi">${icon('fa-book-atlas')} เปิดหน้า World Info เดิมของ ST</button>
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
    return `<div class="lm_setrow lm_setcol"><div><b>${esc(def.label)}</b><small>${esc(def.help)}</small></div>
      <div class="lm_rangeRow"><input type="range" min="${def.min}" max="${Math.min(def.max, def.id === 'world_info_budget_cap' ? 8192 : def.id === 'world_info_depth' ? 50 : def.max)}" value="${v}" data-act="s-global" data-id="${def.id}">
      <input type="number" class="lm_input lm_num" min="${def.min}" max="${def.max}" value="${v}" data-act="s-global" data-id="${def.id}" inputmode="numeric">${def.unit ? `<span>${def.unit}</span>` : ''}</div></div>`;
}

function prefRow(key, label, help) {
    return `<div class="lm_setrow"><div class="lm_grow"><b>${esc(label)}</b>${help ? `<small>${esc(help)}</small>` : ''}</div>${switchHtml(`data-act="s-pref" data-k="${key}"`, !!settings()[key])}</div>`;
}

act('click', {
    's-gx': el => { St.setGlobal(el.dataset.name, false); shell.render(); },
    's-gadd': async () => {
        const g = new Set(St.globalBooks());
        const name = await sheet({ title: 'เพิ่มเล่ม Global', items: St.bookNames().filter(n => !g.has(n)).sort(collator.compare).map(n => ({ value: n, label: n, icon: 'fa-book' })) });
        if (name) { St.setGlobal(name, true); shell.render(); }
    },
    's-scheme': el => { settings().scheme = el.dataset.v; save(); shell.applyScheme?.(); shell.render(); },
    's-resetpos': () => { settings().launcherPos = { ...DEFAULTS.launcherPos }; settings().launcher = true; save(); shell.refreshEntryPoints?.(); shell.render(); },
    's-stwi': () => shell.openStWorldInfo?.(),
    's-capx': el => { delete settings().caps[el.dataset.name]; save(); shell.render(); },
    's-capadd': async () => {
        const s = settings();
        const name = await sheet({ title: 'จำกัดเล่มไหน', items: St.bookNames().filter(n => !s.caps[n]).sort(collator.compare).map(n => ({ value: n, label: n, icon: 'fa-book' })) });
        if (name) { s.caps[name] = s.defaultCap || 10; save(); shell.render(); }
    },
});

act('change', {
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
        const row = el.closest('.lm_rangeRow');
        row?.querySelectorAll('input').forEach(x => { if (x !== el) x.value = el.value; });
    },
});

void toast;
