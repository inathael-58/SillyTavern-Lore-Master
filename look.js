/*
 * Lore Master — how the entry points look (idea from Chat Browser's launcher look):
 *   • the floating button: shape (or a mask such as a hexagon, shield or heart, or no shape at all
 *     for a sticker), icon / emoji / picture, theme or picked colours (a gradient too), size,
 *     see-through while idle, an idle motion, and a red dot when the emergency brake stepped in
 *   • the top-bar icon: icon / emoji / picture, size, colour
 *   • the wand menu item and the small button in ST's World Info panel: icon / emoji, label, colour
 *
 * The editor is a tall sheet inside Lore Master with a preview that stays on top while you scroll;
 * every change also shows on the real buttons at once. Values are cleaned by lib.js on every read.
 */

import { LAUNCH_DEFAULT, TOP_DEFAULT, MENU_DEFAULT, normLaunchLook, normTopLook, normMenuLook } from './lib.js';
import { settings, save } from './prefs.js';
import { esc, icon, shell, toast, rangeHtml, switchHtml, promptBox } from './ui.js';

// ---------------------------------------------------------------- catalogue

const svgMask = d => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>${d}</svg>`)}")`;
/** Masked shapes, and how far to move the face so it sits in the visual middle. */
const MASKS = {
    hexagon: { mask: svgMask("<path d='M50 4L90 27v46L50 96 10 73V27z' stroke='black' stroke-width='7' stroke-linejoin='round'/>"), nudge: '0' },
    shield: { mask: svgMask("<path d='M50 4l38 12c0 38-12 62-38 80C24 78 12 54 12 16z' stroke='black' stroke-width='6' stroke-linejoin='round'/>"), nudge: '-5%' },
    heart: { mask: svgMask("<path d='M50 90C22 70 3 53 3 31 3 15 15 4 29 4c9 0 17 5 21 13 4-8 12-13 21-13 14 0 26 11 26 27 0 22-19 39-47 59z'/>"), nudge: '-6%' },
    flower: { mask: svgMask(`${[0, 45, 90, 135, 180, 225, 270, 315].map(a => `<circle cx='${(50 + 30 * Math.cos(a * Math.PI / 180)).toFixed(1)}' cy='${(50 + 30 * Math.sin(a * Math.PI / 180)).toFixed(1)}' r='20'/>`).join('')}<circle cx='50' cy='50' r='34'/>`), nudge: '0' },
    star: { mask: svgMask("<path d='M50 3l13.6 30.2 32.9 3.6-24.6 22.2 7 32.4L50 75 21.1 91.4l7-32.4L3.5 36.8l32.9-3.6z' stroke='black' stroke-width='5' stroke-linejoin='round'/>"), nudge: '5%' },
    cloud: { mask: svgMask("<path d='M27 84C13 84 3 74 3 61c0-12 9-22 21-23 2-17 15-29 31-29 13 0 24 8 29 20 9 2 16 10 16 21 0 19-13 34-32 34z'/>"), nudge: '4%' },
};
const SHAPES = [
    ['rounded', 'มนเหลี่ยม'], ['circle', 'วงกลม'], ['bubble', 'บับเบิล'], ['pill', 'แคปซูล + ข้อความ'],
    ['hexagon', 'คริสตัลหกเหลี่ยม'], ['shield', 'โล่'], ['heart', 'หัวใจ'], ['flower', 'ดอกไม้'], ['star', 'ดาว'], ['cloud', 'ก้อนเมฆ'],
    ['sticker', 'สติกเกอร์ (ไม่มีพื้น)'],
];
const ICONS = ['fa-book-atlas', 'fa-book', 'fa-book-open', 'fa-book-bookmark', 'fa-book-journal-whills', 'fa-scroll', 'fa-feather-pointed',
    'fa-wand-magic-sparkles', 'fa-hat-wizard', 'fa-gem', 'fa-dragon', 'fa-crown', 'fa-map', 'fa-compass', 'fa-earth-asia', 'fa-landmark',
    'fa-key', 'fa-brain', 'fa-moon', 'fa-star', 'fa-heart', 'fa-cat', 'fa-ghost', 'fa-seedling'];
const ANIMS = [['none', 'นิ่ง'], ['float', 'ลอยขึ้นลง'], ['sway', 'โยกเบา ๆ'], ['pulse', 'เต้นตุบ ๆ'], ['spin', 'หมุนช้า ๆ'],
    ['glow', 'เรืองแสง'], ['shimmer', 'ประกายวิบวับ'], ['alert', 'สั่นเมื่อเบรกฉุกเฉินทำงาน']];
const BGS = [['gradient', 'ไล่สีตามธีม'], ['glass', 'กระจกตามธีม'], ['accent', 'สีธีม'], ['custom', 'เลือกสี'], ['custom2', 'ไล่สีเอง (2 สี)'], ['none', 'โปร่งใส']];
const FGS = [['auto', 'อัตโนมัติ'], ['theme', 'สีธีม (Quote)'], ['custom', 'เลือกสี']];
const PRESETS = [
    ['คลาสสิก', {}],
    ['คัมภีร์เวท', { shape: 'hexagon', icon: 'fa-wand-magic-sparkles', bg: 'custom2', bgColor: '#2a1b5e', bgColor2: '#7b4ce0', fg: 'custom', fgColor: '#ffe39a', anim: 'glow', size: 54, iconSize: 40 }],
    ['คริสตัล', { shape: 'hexagon', icon: 'fa-gem', bg: 'custom2', bgColor: '#5ad1f0', bgColor2: '#7a5cff', anim: 'shimmer', size: 52, iconSize: 40 }],
    ['ม้วนคัมภีร์', { shape: 'pill', icon: 'fa-scroll', label: 'Lore', bg: 'custom', bgColor: '#ecdcb6', fg: 'custom', fgColor: '#6b4423', border: false, size: 40, iconSize: 45 }],
    ['โล่ผู้พิทักษ์', { shape: 'shield', icon: 'fa-book-bookmark', bg: 'custom2', bgColor: '#1d2f6f', bgColor2: '#4b7be0', fg: 'custom', fgColor: '#ffffff', anim: 'alert', size: 54, iconSize: 38 }],
    ['ดาวนำทาง', { shape: 'star', icon: 'fa-compass', bg: 'custom', bgColor: '#f5c451', fg: 'custom', fgColor: '#4a3200', anim: 'glow', size: 58, iconSize: 32 }],
    ['กระจกฝ้า', { shape: 'circle', icon: 'fa-book-open', bg: 'glass', fg: 'theme', border: true, opacity: 100, size: 46 }],
    ['สติกเกอร์', { shape: 'sticker', emoji: '📖', anim: 'float', size: 52 }],
];

// ---------------------------------------------------------------- current looks

export const launchLook = () => normLaunchLook(settings().launcherLook);
export const topLook = () => normTopLook(settings().topbarLook);
export const menuLook = () => normMenuLook(settings().menuLook);
const STORE = { launch: 'launcherLook', top: 'topbarLook', menu: 'menuLook' };
const DEFAULT_OF = { launch: LAUNCH_DEFAULT, top: TOP_DEFAULT, menu: MENU_DEFAULT };
function setLook(kind, patch) {
    const s = settings();
    s[STORE[kind]] = { ...(s[STORE[kind]] && typeof s[STORE[kind]] === 'object' ? s[STORE[kind]] : {}), ...patch };
    save();
}

/** The red dot on the floating button and the top-bar icon: the emergency brake stepped in since Lore Master was last opened. */
let alertOn = false;
export function setAlert(on) {
    alertOn = !!on;
    for (const el of document.querySelectorAll('#lm_launcher, #lm_topbar')) el.dataset.alert = alertOn ? '1' : '';
}

// ---------------------------------------------------------------- drawing

/** Draw the floating button (the real one or a preview) from a look. */
export function applyLaunch(el, L = launchLook()) {
    if (!el) return;
    const mask = MASKS[L.shape];
    el.classList.add('lm_launch');
    el.dataset.shape = L.shape;
    el.dataset.masked = mask ? '1' : '';
    el.dataset.anim = L.anim;
    el.dataset.fit = L.fit;
    el.dataset.bg = L.bg;
    el.dataset.border = L.border && !mask && L.shape !== 'sticker' && L.bg !== 'none' ? '1' : '';
    el.dataset.shadow = L.shadow ? '1' : '';
    el.style.setProperty('--lm-lsize', `${L.size}px`);
    el.style.setProperty('--lm-licon', `${Math.round(L.size * L.iconSize / 100)}px`);
    el.style.setProperty('--lm-lop', String(L.opacity / 100));
    const bg = L.bg === 'custom' ? L.bgColor : L.bg === 'custom2' ? `linear-gradient(135deg, ${L.bgColor}, ${L.bgColor2})`
        : L.bg === 'none' ? 'transparent' : L.bg === 'accent' ? 'var(--lm-laccent)' : '';
    if (bg) el.style.setProperty('--lm-lbg', bg); else el.style.removeProperty('--lm-lbg');
    const fg = L.fg === 'custom' ? L.fgColor : L.fg === 'theme' ? 'var(--lm-laccent)' : '';
    if (fg) el.style.setProperty('--lm-lfg', fg); else el.style.removeProperty('--lm-lfg');
    if (mask) { el.style.setProperty('--lm-lmask', mask.mask); el.style.setProperty('--lm-lnudge', mask.nudge); }
    else { el.style.removeProperty('--lm-lmask'); el.style.removeProperty('--lm-lnudge'); }
    let inner = el.querySelector('.lm_lshape');
    if (!inner) {
        inner = document.createElement('div');
        inner.className = 'lm_lshape';
        el.prepend(inner);
    }
    const label = L.shape === 'pill' && L.label.trim() ? `<span class="lm_llabel">${esc(L.label.trim())}</span>` : '';
    const face = L.image ? `<img class="lm_limg" src="${esc(L.image)}" alt="" draggable="false">`
        : L.emoji ? `<span class="lm_lemoji">${esc(L.emoji)}</span>`
        : `<i class="fa-solid ${L.icon} lm_licon" aria-hidden="true"></i>`;
    inner.innerHTML = face + label;
    if (!el.querySelector('.lm_lalert')) el.insertAdjacentHTML('beforeend', '<span class="lm_lalert" aria-hidden="true">!</span>');
    el.classList.toggle('lm_nobadge', !L.badge);
}

/** The top-bar icon (the real one in #lm_topbar, or the preview). */
export function applyTop(el = document.getElementById('lm_topbar'), T = topLook()) {
    const ic = el?.querySelector('.lm_ticon');
    if (!ic) return;
    ic.className = `drawer-icon closedIcon interactable lm_ticon ${T.image || T.emoji ? 'lm_ticon_face' : `fa-solid fa-fw ${T.icon}`}`;
    ic.innerHTML = T.image ? `<img src="${esc(T.image)}" alt="" draggable="false">` : T.emoji ? `<span>${esc(T.emoji)}</span>` : '';
    if (T.size) ic.style.setProperty('--lm-tsize', `${T.size}px`); else ic.style.removeProperty('--lm-tsize');
    ic.dataset.sized = T.size ? '1' : '';
    if (T.color === 'custom') ic.style.color = T.colorHex; else ic.style.removeProperty('color');
    ic.style.opacity = String(T.opacity / 100);
    if (!el.querySelector('.lm_lalert')) ic.insertAdjacentHTML('afterend', '<span class="lm_lalert" aria-hidden="true">!</span>');
    el.classList.toggle('lm_nobadge', !T.badge);
}

/** The wand menu item and the World Info panel button (real or preview: pass the containers). */
export function applyMenu(wand = document.getElementById('lm_wand'), wi = document.getElementById('lm_wi_btn'), M = menuLook()) {
    const color = M.color === 'custom' ? ` style="color:${M.colorHex}"` : '';
    if (wand) {
        wand.innerHTML = `${M.emoji ? `<div class="extensionsMenuExtensionButton lm_memoji"${color}>${esc(M.emoji)}</div>`
            : `<div class="fa-solid ${M.icon} extensionsMenuExtensionButton"${color}></div>`}<span>${esc(M.label)}</span>`;
    }
    if (wi) {
        wi.className = `menu_button ${M.wiEmoji ? 'lm_wiemoji' : `fa-solid ${M.wiIcon}`}`;
        wi.textContent = M.wiEmoji;
        if (M.color === 'custom') wi.style.color = M.colorHex; else wi.style.removeProperty('color');
    }
}

/** Redraw every real entry point from the saved looks (index.js places the floating button). */
export function applyAll() {
    const real = document.getElementById('lm_launcher');
    if (real) { applyLaunch(real); real.dataset.alert = alertOn ? '1' : ''; shell.placeLauncher?.(real); }
    const tb = document.getElementById('lm_topbar');
    if (tb) { applyTop(tb); tb.dataset.alert = alertOn ? '1' : ''; }
    applyMenu();
}

/** A picture for a button: small images (and GIFs) as they are, bigger ones scaled down so settings stay small. */
async function imageToDataUrl(file) {
    const read = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(f); });
    if (!/^image\//.test(file.type)) throw new Error('ไม่ใช่ไฟล์รูป');
    if (file.size <= 160_000 || (file.type === 'image/gif' && file.size <= 500_000)) return await read(file);
    if (file.type === 'image/gif') throw new Error('GIF ใหญ่เกิน 500 KB');
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 320 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * k);
    canvas.height = Math.round(bmp.height * k);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const webp = canvas.toDataURL('image/webp', 0.9);
    return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png');
}

// ---------------------------------------------------------------- editor

/** Theme rules style every input with !important; a colour well keeps its own look only inline. */
const COLOR_STYLE = ['-webkit-appearance:none', 'appearance:none', 'flex:none', 'width:44px', 'height:34px', 'min-height:0', 'margin:0', 'padding:2px',
    'border:1px solid var(--lm-border)', 'border-radius:9px', 'background:var(--lm-surface2)', 'box-shadow:none', 'cursor:pointer'].map(d => `${d}!important`).join(';');
const colorInput = (k, v, hidden = false) => `<input type="color" data-k="${k}" value="${esc(v)}" style="${COLOR_STYLE}"${hidden ? ' hidden' : ''} aria-label="เลือกสี">`;
const opts = (list, cur) => list.map(([v, t]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${esc(t)}</option>`).join('');
const select = (k, list, cur) => `<select class="lm_input lm_lookselect" data-k="${k}">${opts(list, cur)}</select>`;
const slider = (k, label, v, min, max, unit = '') => `
    <div class="lm_lookslider"><span>${label}</span>${rangeHtml(`data-k="${k}" aria-label="${esc(label)}"`, v, min, max)}<b data-val="${k}">${v}${unit}</b></div>`;
const toggle = (k, label, v) => `<div class="lm_setrow"><div class="lm_grow"><b>${label}</b></div>${switchHtml(`data-k="${k}"`, v)}</div>`;
const iconGrid = (group, cur, active) => `<div class="lm_lookgrid">${ICONS.map(v =>
    `<button type="button" data-pick="${group}" data-v="${v}" class="${active && v === cur ? 'lm_on' : ''}" title="${v.slice(3)}" aria-label="${v.slice(3)}">${icon(v)}</button>`).join('')}</div>`;
const imageRow = (kind, L) => `
    <div class="lm_lookrow"><span class="lm_label">รูปภาพ</span>
      <div class="lm_row lm_wrap lm_lookimg">
        <label class="lm_btn">${icon('fa-image')} เลือกรูป<input type="file" accept="image/*" data-file="${kind}" hidden></label>
        <button type="button" class="lm_btn" data-img="url">${icon('fa-link')} ลิงก์รูป</button>
        ${L.image ? `<button type="button" class="lm_btn" data-img="clear">${icon('fa-xmark')} เอารูปออก</button>` : ''}
        ${kind === 'launch' && L.image ? select('fit', [['cover', 'เต็มกรอบ'], ['contain', 'ทั้งรูป']], L.fit) : ''}
      </div></div>`;
const emojiRow = (k, v) => `<div class="lm_lookrow"><span class="lm_label">อีโมจิ <small>(ใช้แทนไอคอน)</small></span>
    <input type="text" class="lm_input" data-k="${k}" maxlength="16" placeholder="เช่น 📖 🔮 ✨" value="${esc(v)}" autocomplete="off"></div>`;

function shapeSwatch(shape) {
    const m = MASKS[shape];
    if (m) return `<span class="lm_shapeswatch" style="${esc(`-webkit-mask:${m.mask} center/100% 100% no-repeat;mask:${m.mask} center/100% 100% no-repeat`)}"></span>`;
    const radius = { rounded: '33%', circle: '50%', bubble: '50% 50% 14% 50%', pill: '999px' }[shape];
    if (radius) return `<span class="lm_shapeswatch" style="border-radius:${radius};${shape === 'pill' ? 'width:28px;height:14px' : ''}"></span>`;
    return icon('fa-note-sticky');
}

function launchHtml() {
    const L = launchLook();
    const faceIsIcon = !L.emoji && !L.image;
    return `
    <div class="lm_lookstage"><div class="lm_lookprev" data-prev="launch"></div></div>
    <div class="lm_lookrow"><span class="lm_label">สไตล์สำเร็จรูป <small>· กดแล้วปรับต่อได้</small></span>
      <div class="lm_lookpresets">${PRESETS.map(([n], i) => `<button type="button" class="lm_btn" data-preset="${i}"><span class="lm_presetdot" data-preset-prev="${i}"></span>${esc(n)}</button>`).join('')}</div></div>
    <div class="lm_lookrow"><span class="lm_label">รูปทรง</span>
      <div class="lm_lookgrid">${SHAPES.map(([v, t]) => `<button type="button" data-pick="shape" data-v="${v}" class="${L.shape === v ? 'lm_on' : ''}" title="${esc(t)}" aria-label="${esc(t)}">${shapeSwatch(v)}</button>`).join('')}</div></div>
    ${L.shape === 'pill' ? `<div class="lm_lookrow"><span class="lm_label">ข้อความบนแคปซูล</span><input type="text" class="lm_input" data-k="label" maxlength="16" value="${esc(L.label)}" autocomplete="off"></div>` : ''}
    <div class="lm_lookrow"><span class="lm_label">ไอคอน</span>${iconGrid('launch', L.icon, faceIsIcon)}</div>
    ${emojiRow('emoji', L.emoji)}
    ${imageRow('launch', L)}
    <div class="lm_card lm_lookcard">
      ${slider('size', 'ขนาด', L.size, 28, 140, 'px')}
      ${slider('iconSize', 'ขนาดไอคอน', L.iconSize, 20, 100, '%')}
      ${slider('opacity', 'ความทึบ', L.opacity, 20, 100, '%')}
      <div class="lm_hint">ความทึบใช้ตอนไม่ได้แตะ แตะหรือชี้แล้วชัดเต็ม</div>
    </div>
    <div class="lm_card lm_lookcard">
      <div class="lm_lookline"><span>พื้น</span>${select('bg', BGS, L.bg)}${colorInput('bgColor', L.bgColor, !['custom', 'custom2'].includes(L.bg))}${colorInput('bgColor2', L.bgColor2, L.bg !== 'custom2')}</div>
      <div class="lm_lookline"><span>สีไอคอน</span>${select('fg', FGS, L.fg)}${colorInput('fgColor', L.fgColor, L.fg !== 'custom')}</div>
      <div class="lm_lookline"><span>เคลื่อนไหว</span>${select('anim', ANIMS, L.anim)}</div>
    </div>
    <div class="lm_card lm_settings">
      ${toggle('border', 'ขอบ', L.border)}
      ${toggle('shadow', 'เงา', L.shadow)}
      ${toggle('badge', 'จุดแดงเมื่อเบรกฉุกเฉินทำงาน <small>หายไปเมื่อเปิด Lore Master</small>', L.badge)}
    </div>
    <div class="lm_row lm_wrap"><button type="button" class="lm_btn" data-reset="launch">${icon('fa-rotate-left')} กลับเป็นแบบเดิม</button></div>
    <div class="lm_hint">กดค้างที่ปุ่มลอยเพื่อเปิดหน้านี้ได้เลย · รูปที่เลือกจากเครื่องถูกย่อ (GIF ไม่เกิน 500 KB) และเก็บใน settings ของ ST เห็นเหมือนกันทุกเครื่องที่ใช้ user เดียวกัน · ถ้าเปิด “ลดการเคลื่อนไหว” ในระบบไว้ ปุ่มจะไม่ขยับ</div>`;
}

function topHtml() {
    const T = topLook();
    const on = settings().topbar;
    return `
    <div class="lm_lookstage lm_lookstage_bar"><div class="lm_fakebar" data-prev="top">
      ${['fa-bars', 'fa-plug', 'fa-font', 'fa-book-atlas'].map(i => `<span class="lm_fakeicon">${icon(i)}</span>`).join('')}
      <div class="lm_fakeslot"><div class="lm_ticon"></div></div>
      ${['fa-user-gear', 'fa-cubes', 'fa-address-card'].map(i => `<span class="lm_fakeicon">${icon(i)}</span>`).join('')}
    </div></div>
    ${on ? '' : `<div class="lm_warn">${icon('fa-eye-slash')} ไอคอนบนแถบด้านบนปิดอยู่ <button type="button" class="lm_btn" data-enable="topbar">เปิด</button></div>`}
    <div class="lm_lookrow"><span class="lm_label">ไอคอน</span>${iconGrid('top', T.icon, !T.emoji && !T.image)}</div>
    ${emojiRow('emoji', T.emoji)}
    ${imageRow('top', T)}
    <div class="lm_card lm_lookcard">
      <div class="lm_lookslider"><span>ขนาด</span>${rangeHtml('data-k="size" aria-label="ขนาด"', T.size || 30, 12, 64)}<b data-val="size">${T.size ? `${T.size}px` : 'ตามธีม'}</b></div>
      ${T.size ? `<div class="lm_row"><button type="button" class="lm_btn" data-themesize>${icon('fa-palette')} ใช้ขนาดตามธีม</button></div>` : ''}
      ${slider('opacity', 'ความทึบ', T.opacity, 20, 100, '%')}
      <div class="lm_lookline"><span>สี</span>${select('color', [['theme', 'สีธีม'], ['custom', 'เลือกสี']], T.color)}${colorInput('colorHex', T.colorHex, T.color !== 'custom')}</div>
    </div>
    <div class="lm_card lm_settings">${toggle('badge', 'จุดแดงเมื่อเบรกฉุกเฉินทำงาน', T.badge)}</div>
    <div class="lm_row lm_wrap"><button type="button" class="lm_btn" data-reset="top">${icon('fa-rotate-left')} กลับเป็นแบบเดิม</button></div>
    <div class="lm_hint">ใช้รูป PNG พื้นใสให้เข้าชุดกับไอคอนอื่นของธีมได้ · “ตามธีม” ใช้ขนาดเดียวกับไอคอนอื่นของ ST</div>`;
}

function menuHtml() {
    const M = menuLook();
    const s = settings();
    return `
    <div class="lm_lookstage lm_lookstage_menu">
      <div class="lm_fakemenu">
        <div class="lm_fakerow"><div class="fa-solid fa-image extensionsMenuExtensionButton"></div><span>Generate Image</span></div>
        <div class="lm_fakerow lm_fakehot" data-prev="wand"></div>
        <div class="lm_fakerow"><div class="fa-solid fa-language extensionsMenuExtensionButton"></div><span>Translate Chat</span></div>
      </div>
      <div class="lm_fakewi"><span class="lm_fakebtn">${icon('fa-file-import')}</span><span class="lm_fakebtn">${icon('fa-file-export')}</span><span class="lm_fakehot"><div data-prev="wi"></div></span></div>
    </div>
    <h3 class="lm_h">${icon('fa-wand-magic-sparkles')} เมนูไม้กายสิทธิ์ (Extensions)</h3>
    ${s.wand ? '' : `<div class="lm_warn">${icon('fa-eye-slash')} ปิดอยู่ <button type="button" class="lm_btn" data-enable="wand">เปิด</button></div>`}
    <div class="lm_lookrow"><span class="lm_label">ไอคอน</span>${iconGrid('menu', M.icon, !M.emoji)}</div>
    ${emojiRow('emoji', M.emoji)}
    <div class="lm_lookrow"><span class="lm_label">ชื่อในเมนู</span><input type="text" class="lm_input" data-k="label" maxlength="30" value="${esc(M.label)}" placeholder="${esc(MENU_DEFAULT.label)}" autocomplete="off"></div>
    <div class="lm_card lm_lookcard"><div class="lm_lookline"><span>สีไอคอน <small>(ทั้งสองที่)</small></span>${select('color', [['theme', 'สีธีม'], ['custom', 'เลือกสี']], M.color)}${colorInput('colorHex', M.colorHex, M.color !== 'custom')}</div></div>
    <h3 class="lm_h">${icon('fa-book-bookmark')} ปุ่มในหน้า World Info ของ ST</h3>
    ${s.stPanelButton ? '' : `<div class="lm_warn">${icon('fa-eye-slash')} ปิดอยู่ <button type="button" class="lm_btn" data-enable="stPanelButton">เปิด</button></div>`}
    <div class="lm_lookrow"><span class="lm_label">ไอคอน</span>${iconGrid('wi', M.wiIcon, !M.wiEmoji)}</div>
    ${emojiRow('wiEmoji', M.wiEmoji)}
    <div class="lm_row lm_wrap"><button type="button" class="lm_btn" data-reset="menu">${icon('fa-rotate-left')} กลับเป็นแบบเดิม</button></div>`;
}

let edTab = 'launch';
const TABS = [['launch', 'fa-circle-dot', 'ปุ่มลอย'], ['top', 'fa-window-maximize', 'แถบด้านบน'], ['menu', 'fa-bars', 'เมนู & ปุ่มเล็ก']];

/** Open the look editor over Lore Master (which must be open). `tab`: launch | top | menu. */
export function openLookEditor(tab) {
    const host = shell.root;
    if (!host) return;
    if (tab) edTab = tab;
    host.querySelector('.lm_lookl')?.remove();
    const el = document.createElement('div');
    el.className = 'lm_layer lm_lookl';
    el.innerHTML = `
    <div class="lm_scrim" data-x></div>
    <div class="lm_sheet lm_looksheet" role="dialog" aria-label="แต่งหน้าตาปุ่ม">
      <div class="lm_grab"></div>
      <div class="lm_lookhead"><div class="lm_sheet_title lm_grow">${icon('fa-palette')} แต่งหน้าตาปุ่ม</div><button type="button" class="lm_icon" data-x aria-label="ปิด">${icon('fa-xmark')}</button></div>
      <div class="lm_seg lm_seg3 lm_looktabs" role="tablist">${TABS.map(([k, ic, t]) => `<button type="button" class="lm_segbtn" data-tab="${k}" role="tab">${icon(ic)} ${t}</button>`).join('')}</div>
      <div class="lm_lookbody"></div>
    </div>`;
    host.append(el);
    const body = el.querySelector('.lm_lookbody');
    const kind = () => (edTab === 'menu' ? 'menu' : edTab === 'top' ? 'top' : 'launch');

    /** Previews and the real buttons, from the saved look. */
    const paint = () => {
        applyAll();
        const lp = body.querySelector('[data-prev="launch"]');
        if (lp) {
            const L = launchLook();
            applyLaunch(lp, L);
            lp.dataset.alert = L.badge ? '1' : '';   // show the dot so its place can be judged
            lp.style.scale = String(Math.min(1, 104 / L.size));
            body.querySelectorAll('[data-preset-prev]').forEach(d => {
                const P = normLaunchLook({ ...LAUNCH_DEFAULT, ...PRESETS[Number(d.dataset.presetPrev)][1] });
                d.style.background = P.bg === 'custom' ? P.bgColor : P.bg === 'custom2' ? `linear-gradient(135deg, ${P.bgColor}, ${P.bgColor2})`
                    : P.bg === 'gradient' ? 'linear-gradient(135deg, var(--SmartThemeQuoteColor, #e18a24), #8a4bd6)' : 'var(--lm-surface2)';
            });
        }
        const tp = body.querySelector('[data-prev="top"]');
        if (tp) { applyTop(tp, topLook()); tp.dataset.alert = topLook().badge ? '1' : ''; }
        const wp = body.querySelector('[data-prev="wand"]'), ip = body.querySelector('[data-prev="wi"]');
        if (wp || ip) applyMenu(wp, ip, menuLook());
        // which icon is in use (typing an emoji or adding a picture takes the highlight away)
        const cur = { launch: launchLook(), top: topLook(), menu: menuLook() }[kind()];
        body.querySelectorAll('[data-pick]').forEach(b => {
            const g = b.dataset.pick;
            const on = g === 'shape' ? cur.shape === b.dataset.v
                : g === 'wi' ? !cur.wiEmoji && cur.wiIcon === b.dataset.v
                : !cur.emoji && !cur.image && cur.icon === b.dataset.v;
            b.classList.toggle('lm_on', on);
        });
    };
    const draw = () => {
        const st = body.scrollTop;
        el.querySelectorAll('[data-tab]').forEach(b => { b.classList.toggle('lm_on', b.dataset.tab === edTab); b.setAttribute('aria-selected', String(b.dataset.tab === edTab)); });
        body.innerHTML = edTab === 'top' ? topHtml() : edTab === 'menu' ? menuHtml() : launchHtml();
        body.scrollTop = st;
        paint();
    };
    const close = () => { el.classList.add('lm_closing'); setTimeout(() => el.remove(), 160); };
    const set = (patch, redraw = false) => { setLook(kind(), patch); if (redraw) draw(); else paint(); };

    el.addEventListener('click', async e => {
        const t = e.target;
        if (t.closest('[data-x]')) return close();
        const tabBtn = t.closest('[data-tab]');
        if (tabBtn) { if (edTab !== tabBtn.dataset.tab) { edTab = tabBtn.dataset.tab; body.scrollTop = 0; draw(); } return; }
        const b = t.closest('button');
        if (!b || !body.contains(b)) return;
        if (b.dataset.pick === 'shape') return set({ shape: b.dataset.v }, true);
        if (b.dataset.pick === 'wi') return set({ wiIcon: b.dataset.v, wiEmoji: '' }, true);
        if (b.dataset.pick) return set({ icon: b.dataset.v, emoji: '', ...(b.dataset.pick === 'menu' ? {} : { image: '' }) }, true);
        if (b.dataset.preset) { settings().launcherLook = { ...PRESETS[Number(b.dataset.preset)][1] }; save(); return draw(); }
        if (b.dataset.reset) { settings()[STORE[b.dataset.reset]] = {}; save(); return draw(); }
        if (b.hasAttribute('data-themesize')) return set({ size: 0 }, true);
        if (b.dataset.enable) { settings()[b.dataset.enable] = true; save(); shell.refreshEntryPoints?.(); return draw(); }
        if (b.dataset.img === 'clear') return set({ image: '' }, true);
        if (b.dataset.img === 'url') {
            const cur = (kind() === 'top' ? topLook() : launchLook()).image;
            const url = await promptBox({ title: 'ลิงก์รูป', text: 'https://… ใช้ PNG พื้นใส GIF หรือ WebP ได้', value: /^https?:/.test(cur) ? cur : '', placeholder: 'https://', ok: 'ใช้รูปนี้' });
            if (url == null) return;
            if (!/^https?:\/\/[^\s"'<>()\\]+$/i.test(url)) { toast.warning('ใส่ลิงก์ที่ขึ้นต้นด้วย https:// (ไม่มีช่องว่างหรือวงเล็บ)'); return; }
            set({ image: url, emoji: '', ...(kind() === 'launch' && launchLook().shape === 'sticker' ? { fit: 'contain' } : {}) }, true);
        }
    });
    // typing and dragging save and repaint at once, but never rebuild the form under the finger;
    // a choice that shows or hides other fields (a select, a switch) rebuilds it once made
    const onField = e => {
        const f = e.target.closest?.('[data-k]');
        if (!f || !body.contains(f)) return;
        const k = f.dataset.k;
        const v = f.type === 'checkbox' ? f.checked : f.type === 'range' ? Number(f.value) : f.value;
        if (f.type === 'range') {
            const out = body.querySelector(`[data-val="${k}"]`);
            if (out) out.textContent = `${v}${k === 'size' ? 'px' : '%'}`;
        }
        const patch = { [k]: v };
        if (k === 'emoji' && String(v).trim() && kind() !== 'menu') patch.image = '';
        if (e.type === 'input') return set(patch);
        if (f.tagName === 'SELECT' || f.type === 'checkbox' || (f.type === 'range' && kind() === 'top' && k === 'size')) set(patch, true);
    };
    el.addEventListener('input', onField);
    el.addEventListener('change', async e => {
        const file = e.target.closest?.('input[type=file][data-file]');
        if (!file) return onField(e);
        const f = file.files?.[0];
        file.value = '';
        if (!f) return;
        try {
            const url = await imageToDataUrl(f);
            set({ image: url, emoji: '', ...(kind() === 'launch' && launchLook().shape === 'sticker' ? { fit: 'contain' } : {}) }, true);
            if (!(kind() === 'top' ? topLook() : launchLook()).image) toast.warning('ใช้รูปนี้ไม่ได้ ลองเป็น PNG, JPG, GIF หรือ WebP');
        } catch (err) { toast.error(`ใช้รูปนี้ไม่ได้: ${String(err?.message ?? err)}`); }
    });
    el.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    draw();
}
