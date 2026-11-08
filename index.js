/*
 * Lore Master — SillyTavern extension
 *
 * A mobile-first lorebook manager next to SillyTavern's World Info panel (or, if chosen in
 * Settings, in place of it):
 *   • Books: every lorebook, what is in use right now, one book's entries, a full entry editor
 *   • ตรวจ & รวม: import books from other sites (JanitorAI…), merge books, find and fix
 *     what makes them misfire, test, save (v0.1)
 *   • Settings: ST's global World Info settings in plain Thai, entry points, per-turn caps
 *
 * Entry points (like Chat Browser): floating button, top-bar icon, the wand menu, /lore, a button
 * inside ST's panel, links from Lore Lens (LoreMaster.openEntry). Only when "replace World Info" is
 * switched on (off by default): the World Info button itself, the card's globe and Chat Lore buttons.
 *
 * Files: lib.js (pure logic) · store.js (SillyTavern data) · ui.js (toolkit, navigation)
 *        editor.js · doctor.js · settingsview.js (screens) · prefs.js (settings)
 *        look.js (how the floating button, top-bar icon and menu items look, and their editor)
 */

import {
    detectFormat, FORMAT_LABEL, overCap, isGlossary, parseGlossary, pickGlossary, GLOSSARY_HEAD,
    keyScanner, wouldFire, trimToLimits, byPriority, estTokens, bookStats,
} from './lib.js';
import * as St from './store.js';
import { settings, save, migrated } from './prefs.js';
import { esc, icon, on, shell, UI, top, back, goTab, viewKey, toast, paintRange } from './ui.js';
import { viewLibrary, viewBook, viewEntry, enterBook, hooks, onFieldEvent, onFocusOut, onToggleDetails, focusAfterRender, autosize } from './editor.js';
import { viewOrganize, onOrganizeToggle } from './organize.js';
import { viewDoctor, checkBook, importFiles, startMerge, importJson, initDoctor, thaiBook, condenseBook, translateBook, enterDoctor, onDoctorToggle } from './doctor.js';
import { viewSettings } from './settingsview.js';
import { applyLaunch, applyTop, applyMenu, setAlert, openLookEditor } from './look.js';

const LOG = '[LoreMaster]';
const VERSION = '0.10.3'; // keep in sync with manifest.json
const BASE_URL = new URL('.', import.meta.url);
/** Every file of the extension, so a hard refresh can replace all of them in the browser cache. */
const FILES = ['index.js', 'lib.js', 'store.js', 'ui.js', 'prefs.js', 'ai.js', 'backup.js', 'cache.js', 'editor.js', 'doctor.js', 'organize.js', 'settingsview.js', 'look.js', 'style.css', 'manifest.json'];
const W = St.WIref;

hooks.checkBook = checkBook;
hooks.importFiles = importFiles;
hooks.mergeBooks = startMerge;
hooks.thaiBook = thaiBook;
hooks.condenseBook = condenseBook;
hooks.translateBook = translateBook;

// ================================================================ shell

let root = null;
function ensureRoot() {
    if (root) return root;
    root = document.createElement('div');
    root.id = 'lm_root';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Lore Master');
    document.body.appendChild(root);
    shell.root = root;
    root.addEventListener('click', onClick);
    root.addEventListener('change', ev => dispatch('change', ev));
    root.addEventListener('input', ev => { paintRange(ev.target); if (!onFieldEvent(ev)) dispatch('input', ev); });
    root.addEventListener('keydown', onKeydown);
    root.addEventListener('focusout', onFocusOut);
    root.addEventListener('toggle', ev => { onToggleDetails(ev); onDoctorToggle(ev); onOrganizeToggle(ev); }, true);
    return root;
}

function dispatch(kind, ev) {
    const el = ev.target.closest?.('[data-act]');
    if (!el || !root.contains(el)) return;
    const fn = on[kind][el.dataset.act];
    if (fn) Promise.resolve(fn(el, ev)).catch(e => { console.error(LOG, e); toast.error(String(e?.message ?? e)); });
}
function onClick(ev) {
    if (ev.target.closest('[data-stop]')) return;               // switches inside cards
    const el = ev.target.closest('[data-act]');
    if (!el || !root.contains(el)) return;
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) return;
    if (el.tagName === 'LABEL' && el.querySelector('input[type=file]')) return;
    const a = el.dataset.act;
    if (a === 'close') return closeLM();
    if (a === 'back') { if (!back()) closeLM(); return; }
    if (a === 'nav') {
        const t = el.dataset.tab;
        if (UI.tab === t && t === 'books' && UI.stack.length > 1) { UI.stack = [UI.stack[0]]; }
        if (t === 'doctor' && UI.tab !== 'doctor') { enterDoctor().catch(e => { console.error(LOG, e); goTab(t); }); return; }
        goTab(t); return;
    }
    dispatch('click', ev);
}
function onKeydown(ev) {
    // keep SillyTavern's own shortcuts (Esc closes drawers, arrows edit messages…) out of Lore Master
    ev.stopPropagation();
    if (ev.key === 'Escape' && !ev.target.closest('.lm_layer')) {
        ev.preventDefault();
        if (!back()) closeLM();
        return;
    }
    // cards are role=button
    if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches?.('[role=button][data-act]')) { ev.preventDefault(); ev.target.click(); return; }
    if (ev.key === 'Enter' && ev.target.matches?.('input[data-f]')) ev.preventDefault();
    if (ev.target.dataset?.act) {
        const fn = on.keydown[ev.target.dataset.act];
        if (fn) fn(ev.target, ev);
    }
}

let loading = null;
let lastKey = '';
function render() {
    if (!UI.open || !root) return;
    const body = root.querySelector('.lm_body');
    if (body && lastKey) UI.scroll.set(lastKey, body.scrollTop);

    const v = top();
    if (UI.tab === 'books' && v.v !== 'library' && St.cur?.name !== v.name && loading !== v.name) {
        loading = v.name;
        enterBook(v.name).then(() => { loading = null; render(); }).catch(e => { loading = null; toast.error(String(e?.message ?? e)); UI.stack = [{ v: 'library' }]; render(); });
    }
    const key = viewKey(v);
    if (lastKey && lastKey !== key && St.cur?.dirty) St.flush();

    let view;
    try {
        view = UI.tab === 'doctor' ? viewDoctor() : UI.tab === 'settings' ? viewSettings()
            : v.v === 'book' ? viewBook(v) : v.v === 'entry' ? viewEntry(v) : v.v === 'organize' ? viewOrganize(v) : viewLibrary();
    } catch (e) {
        console.error(LOG, e);
        view = { title: 'Lore Master', body: `<div class="lm_card lm_err">เกิดข้อผิดพลาด: ${esc(e?.message ?? e)}</div>` };
    }
    const canBack = UI.tab === 'books' && UI.stack.length > 1;
    const nav = [['books', 'fa-book', 'เล่ม'], ['doctor', 'fa-stethoscope', 'ตรวจ & รวม'], ['settings', 'fa-gear', 'ตั้งค่า']];
    root.dataset.scheme = settings().scheme;
    root.dataset.view = UI.tab === 'books' ? v.v : UI.tab;
    const lookLayer = root.querySelector('.lm_lookl');   // the button editor stays open over a background re-draw
    root.innerHTML = `
    <div class="lm_panel">
      <header class="lm_head">
        ${canBack ? `<button class="lm_icon" data-act="back" aria-label="ย้อนกลับ">${icon('fa-arrow-left')}</button>` : `<div class="lm_logo">${icon('fa-book-atlas')}</div>`}
        <div class="lm_headtext">
          <div class="lm_htitle" ${view.titleId ? `id="${view.titleId}"` : ''}>${esc(view.title)}</div>
          ${view.sub ? `<div class="lm_hsub">${view.sub}</div>` : ''}
        </div>
        <div class="lm_hactions">${view.actions ?? ''}</div>
        <button class="lm_icon" data-act="close" aria-label="ปิด Lore Master">${icon('fa-xmark')}</button>
      </header>
      <main class="lm_body" data-key="${esc(key)}"><div class="lm_view">${view.body}</div></main>
      <nav class="lm_nav">${nav.map(([t, ic, label]) => `
        <button class="lm_navbtn ${UI.tab === t ? 'lm_on' : ''}" data-act="nav" data-tab="${t}">${icon(ic)}<span>${label}</span></button>`).join('')}
      </nav>
    </div>`;
    if (lookLayer) root.append(lookLayer);
    const nb = root.querySelector('.lm_body');
    if (key !== lastKey) nb.querySelector('.lm_view')?.classList.add('lm_enter');
    nb.scrollTop = UI.scroll.get(key) ?? 0;
    lastKey = key;
    autosize(root);
    focusAfterRender();
}
shell.render = render;
shell.applyScheme = () => { if (root) root.dataset.scheme = settings().scheme; };

// ---------------------------------------------------------------- open / close (+ phone back gesture)

let ownHistory = false;
export function openLM(stack = null, tab = null) {
    ensureRoot();
    if (stack) { UI.tab = 'books'; UI.stack = [{ v: 'library' }, ...stack]; }
    if (tab) UI.tab = tab;
    const was = UI.open;
    UI.open = true;
    setAlert(false);
    root.classList.add('lm_open');
    document.documentElement.classList.add('lm_noscroll');
    fitViewport();
    render();
    if (!was) {
        try { history.pushState({ loreMaster: true }, ''); ownHistory = true; } catch { ownHistory = false; }
    }
}
let lastClosedAt = 0;
function closeLM() {
    if (!UI.open) return;
    lastClosedAt = Date.now();
    St.flush();
    UI.open = false;
    root?.classList.remove('lm_open');
    document.documentElement.classList.remove('lm_noscroll');
    if (ownHistory && history.state?.loreMaster) { ownHistory = false; history.back(); }
    ownHistory = false;
}
window.addEventListener('popstate', () => {
    if (!UI.open || !ownHistory) return;
    // the phone's back gesture: go up one level, or close
    if (root.querySelector('.lm_layer')) { root.querySelectorAll('.lm_layer').forEach(l => l.remove()); }
    else if (back()) { /* went up */ }
    else { ownHistory = false; closeLM(); return; }
    try { history.pushState({ loreMaster: true }, ''); } catch { /* ignore */ }
});

/** Size the overlay to the visible viewport, so the on-screen keyboard never hides what you type. */
function fitViewport() {
    if (!root) return;
    const vv = window.visualViewport;
    const h = vv ? vv.height : window.innerHeight;
    root.style.top = `${vv ? vv.offsetTop : 0}px`;
    root.style.height = `${h}px`;
    root.classList.toggle('lm_kb', !!vv && h < window.innerHeight * 0.75);
}
let fitTimers = [];
function fitSoon() { fitViewport(); fitTimers.forEach(clearTimeout); fitTimers = [100, 300, 600].map(ms => setTimeout(fitViewport, ms)); }
window.visualViewport?.addEventListener('resize', fitSoon);
window.visualViewport?.addEventListener('scroll', fitViewport);
window.addEventListener('resize', fitSoon);

// ================================================================ entry points

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
function visibleArea() {
    const vv = window.visualViewport;
    return vv ? { x: vv.offsetLeft, y: vv.offsetTop, w: vv.width, h: vv.height } : { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
}
function placeLauncher(el = document.getElementById('lm_launcher')) {
    if (!el || el.classList.contains('lm_dragging')) return;
    const { x: ox, y: oy, w: vw, h: vh } = visibleArea();
    const p = settings().launcherPos;
    const m = 8, w = el.offsetWidth || 48, h = el.offsetHeight || 48;
    let left = m + clamp(Number(p.x) || 0, 0, 1) * Math.max(0, vw - w - 2 * m);
    let top_ = m + clamp(Number(p.y) || 0, 0, 1) * Math.max(0, vh - h - 2 * m);
    if (p.edge === 'left') left = m;
    if (p.edge === 'right') left = vw - w - m;
    if (p.edge === 'top') top_ = m;
    if (p.edge === 'bottom') top_ = vh - h - m;
    el.style.left = `${Math.round(ox + left)}px`;
    el.style.top = `${Math.round(oy + top_)}px`;
    el.dataset.edge = p.edge ?? '';   // a chat-bubble tail points at the edge it sits on
}
shell.placeLauncher = placeLauncher;
/** Place again now and once the on-screen keyboard has finished sliding (iOS reports the size late). */
let placeTimer = null;
function placeLauncherSoon() {
    requestAnimationFrame(() => placeLauncher());
    clearTimeout(placeTimer);
    placeTimer = setTimeout(() => placeLauncher(), 350);
}
/** Open Lore Master on the button editor (long-press on the floating button, the Extensions panel, LoreMaster.customize). */
function openCustomize(tab = 'launch') {
    openLM(null, 'settings');
    openLookEditor(tab);
}
function renderLauncher() {
    let el = document.getElementById('lm_launcher');
    if (!settings().launcher) { el?.remove(); return; }
    if (el) { applyLaunch(el); return placeLauncher(el); }
    el = document.createElement('div');
    el.id = 'lm_launcher';
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.title = 'Lore Master — แตะเพื่อเปิด · ลากเพื่อย้าย · กดค้างเพื่อแต่งปุ่ม';
    el.setAttribute('aria-label', 'Lore Master');
    applyLaunch(el);
    document.body.append(el);
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFromContext(); } });
    el.addEventListener('contextmenu', e => e.preventDefault());   // a long press is ours, not the browser's menu
    let start = null, moved = false, longTimer = null, longDone = false, skipClick = false;
    // Open on click, not pointerup: opened on pointerup, Lore Master appears under the finger and the click
    // that follows the same tap presses whatever is there (the + button opened "add book" by itself).
    el.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        if (skipClick) { skipClick = false; return; } // the click that ends a drag or a long press
        openFromContext();
    });
    el.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        const r = el.getBoundingClientRect();
        start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, id: e.pointerId };
        moved = false;
        longDone = false;
        skipClick = false;
        clearTimeout(longTimer);
        longTimer = setTimeout(() => { if (start && !moved) { longDone = true; openCustomize('launch'); } }, 650);
        try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    });
    el.addEventListener('pointermove', e => {
        if (!start || e.pointerId !== start.id || longDone) return;
        const dx = e.clientX - start.x, dy = e.clientY - start.y;
        if (!moved && Math.hypot(dx, dy) < 6) return;
        moved = true;
        clearTimeout(longTimer);
        el.classList.add('lm_dragging');
        const a = visibleArea();
        el.style.left = `${clamp(start.left + dx, a.x, a.x + a.w - el.offsetWidth)}px`;
        el.style.top = `${clamp(start.top + dy, a.y, a.y + a.h - el.offsetHeight)}px`;
    });
    const end = e => {
        if (!start || e.pointerId !== start.id) return;
        start = null;
        clearTimeout(longTimer);
        if (longDone) { skipClick = true; return; }
        if (!moved) return; // a plain tap: the click handler opens Lore Master
        skipClick = true;
        el.classList.remove('lm_dragging');
        const { x: ox, y: oy, w: vw, h: vh } = visibleArea();
        const b = el.getBoundingClientRect();
        const r = { left: b.left - ox, top: b.top - oy, right: b.right - ox, bottom: b.bottom - oy, width: b.width, height: b.height };
        const dist = { left: r.left, right: vw - r.right, top: r.top, bottom: vh - r.bottom };
        const edge = Object.keys(dist).reduce((a, k) => (dist[k] < dist[a] ? k : a));
        settings().launcherPos = { x: clamp((r.left - 8) / Math.max(1, vw - r.width - 16), 0, 1), y: clamp((r.top - 8) / Math.max(1, vh - r.height - 16), 0, 1), edge };
        save();
        placeLauncher(el);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    placeLauncher(el);
}
// keep the button on the visible part of the screen, also while the on-screen keyboard is open
window.addEventListener('resize', placeLauncherSoon);
window.visualViewport?.addEventListener('resize', placeLauncherSoon);
window.visualViewport?.addEventListener('scroll', () => placeLauncher());
document.addEventListener('focusin', placeLauncherSoon);
document.addEventListener('focusout', placeLauncherSoon);

function renderTopbar() {
    let el = document.getElementById('lm_topbar');
    if (!settings().topbar) { el?.remove(); return; }
    if (el) return applyTop(el);
    const holder = document.getElementById('top-settings-holder');
    if (!holder) return;
    el = document.createElement('div');
    el.id = 'lm_topbar';
    el.className = 'drawer';
    el.innerHTML = '<div class="drawer-toggle"><div class="lm_ticon" title="Lore Master" tabindex="0"></div></div>';
    const before = document.getElementById('rightNavHolder');
    if (before?.parentElement === holder) holder.insertBefore(el, before); else holder.append(el);
    el.addEventListener('click', e => { e.stopPropagation(); openFromContext(); }, true);
    el.addEventListener('keydown', e => { if (e.key === 'Enter') openFromContext(); });
    applyTop(el);
}

function renderWand() {
    let el = document.getElementById('lm_wand');
    if (!settings().wand) { el?.remove(); return; }
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return;
    if (el) return applyMenu(el, null);
    el = document.createElement('div');
    el.id = 'lm_wand';
    el.className = 'list-group-item flex-container flexGap5 interactable';
    el.tabIndex = 0;
    el.addEventListener('click', () => openFromContext());
    menu.append(el);
    applyMenu(el, null);
}

function renderWiButton() {
    const old = document.getElementById('lm_wi_btn');
    if (!settings().stPanelButton) { old?.remove(); return; }
    if (old) return applyMenu(null, old);
    const anchor = document.getElementById('world_import_button');
    if (!anchor) return;
    const b = document.createElement('div');
    b.id = 'lm_wi_btn';
    b.title = 'เปิดใน Lore Master';
    applyMenu(null, b);
    b.addEventListener('click', () => {
        const sel = document.getElementById('world_editor_select');
        const name = sel && sel.value !== '' ? sel.options[sel.selectedIndex]?.text ?? '' : '';
        if (name && St.bookNames().includes(name)) openLM([{ v: 'book', name }]); else openLM();
        closeStWorldInfo();
    });
    anchor.insertAdjacentElement('afterend', b);
}

function refreshEntryPoints() { renderLauncher(); renderTopbar(); renderWand(); renderWiButton(); }
shell.refreshEntryPoints = refreshEntryPoints;

/**
 * Open one entry of one book (used by Lore Lens's "open in lorebook" links).
 * Resolves false when the book does not exist, so the caller can fall back to ST's own panel.
 */
async function openEntry(name, uid) {
    name = String(name ?? '');
    if (!name || !St.bookNames().includes(name)) return false;
    const id = Number(uid);
    await enterBook(name);
    closeStWorldInfo();
    if (!Number.isFinite(id) || !St.getEntry(id)) {
        openLM([{ v: 'book', name }]);
        toast.info(`ไม่เจอเอนทรี uid ${uid} ใน “${name}” (อาจถูกลบไปแล้ว) เปิดเล่มให้แทน`, 'Lore Master');
        return true;
    }
    openLM([{ v: 'book', name }, { v: 'entry', name, uid: id }]);
    return true;
}

/** Open where it makes most sense: keep the last screen if it was used recently, else the library. */
function openFromContext() {
    if (UI.open) return closeLM();
    if (Date.now() - lastClosedAt > 10 * 60 * 1000) { UI.tab = 'books'; UI.stack = [{ v: 'library' }]; }
    openLM();
}

// ---------------------------------------------------------------- taking over ST's own World Info buttons

let bypass = false;
function isOpenSt() { return document.getElementById('WorldInfo')?.classList.contains('openDrawer'); }
function closeStWorldInfo() {
    if (!isOpenSt()) return;
    bypass = true;
    try { document.getElementById('WIDrawerIcon')?.click(); } finally { bypass = false; }
}
shell.openStWorldInfo = () => {
    closeLM();
    if (isOpenSt()) return;
    bypass = true;
    try { document.getElementById('WIDrawerIcon')?.click(); } finally { bypass = false; }
};

function onDocClick(ev) {
    if (bypass || !ev.isTrusted || ev.shiftKey || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    if (!settings().replaceWorldInfo) return;
    const t = ev.target;
    if (!(t instanceof Element)) return;
    // top-bar World Info button (let it close ST's panel if that is open)
    if (t.closest('#WI-SP-button .drawer-toggle') && !isOpenSt()) {
        ev.preventDefault(); ev.stopImmediatePropagation();
        return openFromContext();
    }
    // the card's globe button: open the card's main book
    if (t.closest('#world_button')) {
        ev.preventDefault(); ev.stopImmediatePropagation();
        const p = St.charBooks().primary;
        return p && St.bookNames().includes(p) ? openLM([{ v: 'book', name: p }]) : openLM([]);
    }
    // Chat Lore button
    if (t.closest('.chat_lorebook_button')) {
        ev.preventDefault(); ev.stopImmediatePropagation();
        const c = St.chatBook();
        return c && St.bookNames().includes(c) ? openLM([{ v: 'book', name: c }]) : openLM([]);
    }
}

// ---------------------------------------------------------------- World Info "Import": JanitorAI files open here

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
        importJson(file.name.replace(/\.json$/i, ''), raw);
        closeStWorldInfo();
        openLM(null, 'doctor');
        toast.info(`ไฟล์นี้เป็นแบบ ${FORMAT_LABEL[fmt]} ซึ่ง ST import เองไม่ได้ เปิดใน Lore Master ให้แล้ว ตรวจเสร็จกดบันทึก`, 'Lore Master', { timeOut: 9000 });
        return;
    }
    try { await W.importWorldInfo(file); } finally { input.value = ''; }
}

// ---------------------------------------------------------------- runtime: per-turn cap

let lastCut = null;
function onScanDone(args) {
    const map = args?.activated?.entries;
    if (!(map instanceof Map)) return;
    const caps = settings().caps;
    if (caps && Object.keys(caps).length && map.size) {
        const drop = overCap([...map.values()], caps);
        if (drop.length) {
            for (const e of drop) map.delete(`${e.world}.${e.uid}`);
            lastCut = { at: Date.now(), n: drop.length, names: drop.map(e => e.comment || `#${e.uid}`) };
            console.info(LOG, `per-turn cap: dropped ${drop.length} entries`, lastCut.names);
        }
    }
    try { guardAfterLoop(args, map); } catch (e) { console.error(LOG, 'emergency brake failed', e); }
    // remember what the finished scan put in, for the status card in settings
    if (!args?.state?.next) {
        const act = [...map.values()];
        const books = {};
        for (const e of act) books[e.world] = (books[e.world] ?? 0) + 1;
        status.scan = { at: Date.now(), count: act.length, tokens: sumTokens(act), books, loaded: status.loadedCount, braked: !!lastTrip && lastTrip.at >= (status.loadedAt ?? 0) };
        noteFired(act);
    }
    // the last loop of the scan: send only the glossary names that matter this turn
    if (glossLines.length && !args?.state?.next) {
        const picked = pickGlossary(glossLines, { text: recentChat(), activated: [...map.values()] });
        setGlossaryPrompt(picked.length ? `${GLOSSARY_HEAD}\n${picked.map(l => `- ${l.en} = ${l.th}`).join('\n')}` : '');
    }
}

// ---------------------------------------------------------------- runtime: what fired in this chat
// Per chat, since SillyTavern loaded: how many turns each entry fired, and which fired last turn.
// The book screen shows these on top, because the entry someone wants to fix is usually one
// that just showed up in the chat.

const fired = { chat: null, turns: new Map(), last: new Set() }; // keys: `${world}\u0000${uid}`
const firedKey = (world, uid) => `${world}\u0000${uid}`;
function noteFired(act) {
    const chat = St.ctx().chatId ?? '';
    if (chat !== fired.chat) { fired.chat = chat; fired.turns.clear(); }
    fired.last = new Set(act.map(e => firedKey(e.world, e.uid)));
    for (const k of fired.last) fired.turns.set(k, (fired.turns.get(k) ?? 0) + 1);
}
/** For one book in the open chat: { turns: Map(String(uid) → turns fired), last: Set(String(uid)) }, or null. */
function firedIn(book) {
    if (!book || fired.chat === null || fired.chat !== (St.ctx().chatId ?? '')) return null;
    const turns = new Map();
    const last = new Set();
    const pre = `${book}\u0000`;
    for (const [k, n] of fired.turns) if (k.startsWith(pre)) turns.set(k.slice(pre.length), n);
    for (const k of fired.last) if (k.startsWith(pre)) last.add(k.slice(pre.length));
    return turns.size ? { turns, last } : null;
}

// ---------------------------------------------------------------- runtime: emergency brake
//
// A lorebook whose entries mention each other can pull in hundreds of entries through
// recursion in one turn (one card: 471 of 542 entries, ~760k tokens, from its first message).
// SillyTavern then counts tokens of megabytes of text over and over and freezes.
// Before the scan we trim what the chat itself would trigger; after each scan loop we look
// at what the next recursion loop would pull in, and stop the recursion if it is too much.
// Nothing is changed in the books: the entries handed to the scan are copies.

let scanCtx = null;     // { all, scanner, o }
const status = { loadedAt: 0, loadedCount: 0, scan: null };
let lastTrip = null;    // shown in the settings screen
const tripShown = new Set();
const guardLimits = () => {
    const s = settings();
    return { maxEntries: Math.max(5, Number(s.guardMaxEntries) || 40), maxTokens: Math.max(2000, Number(s.guardMaxTokens) || 25000) };
};
const matchOpts = () => {
    const c = St.ctx();
    return { names: { char: c.name2 ?? '', user: c.name1 ?? '' }, caseSensitive: !!W.world_info_case_sensitive, wholeWords: !!W.world_info_match_whole_words };
};
const sumTokens = list => list.reduce((n, e) => n + estTokens(e.content), 0);
function chatScanText() {
    const c = St.ctx();
    const depth = Math.max(1, Number(W.world_info_depth) || 2);
    const withNames = W.world_info_include_names !== false;
    return (c.chat ?? []).filter(m => !m.is_system && m.mes).slice(-depth).map(m => (withNames ? `${m.name}: ${m.mes}` : m.mes)).join('\n');
}
function mainBook(list) {
    const count = new Map();
    for (const e of list) if (e?.world) count.set(e.world, (count.get(e.world) ?? 0) + 1);
    return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
}

function guardBeforeScan(arrays) {
    scanCtx = null;
    if (!settings().guard) return;
    const all = arrays.flat();
    if (!all.length) return;
    const o = matchOpts();
    const scanner = keyScanner(all.filter(e => !e.constant && !e.disable), o.names);
    scanCtx = { all, scanner, o };
    const consts = all.filter(e => e.constant && !e.disable);
    const first = wouldFire(all, chatScanText(), { ...o, scanner }).sort(byPriority);
    const limits = guardLimits();
    const { drop, tokens } = trimToLimits([...consts, ...first], limits);
    if (!drop.length) return;
    const gone = new Set(drop);
    for (const arr of arrays) for (let i = arr.length - 1; i >= 0; i--) if (gone.has(arr[i])) arr.splice(i, 1);
    trip({ kind: 'first', would: consts.length + first.length, wouldTokens: sumTokens(consts) + sumTokens(first), kept: consts.length + first.length - drop.length, keptTokens: tokens, book: mainBook(drop) });
}

function guardAfterLoop(args, map) {
    if (!settings().guard || !scanCtx) return;
    const limits = guardLimits();
    const act = [...map.values()];
    const tokens = sumTokens(act);
    if (act.length > limits.maxEntries || tokens > limits.maxTokens) {
        // already too much (e.g. huge entries): keep the first-activated (most important), stop
        const { drop, tokens: kept } = trimToLimits(act, limits);
        for (const e of drop) map.delete(`${e.world}.${e.uid}`);
        if (args.state) args.state.next = 0;
        trip({ kind: 'over', would: act.length, wouldTokens: tokens, kept: act.length - drop.length, keptTokens: kept, book: mainBook(drop) });
        return;
    }
    if (!args.state?.next) return;
    // what would the next recursion loop pull in?
    const text = (args.new?.successful ?? []).filter(e => !e.preventRecursion).map(e => e.content).join('\n');
    if (!text) return;
    const next = wouldFire(scanCtx.all, text, { ...scanCtx.o, scanner: scanCtx.scanner, skip: new Set(act), recursion: true });
    const nt = sumTokens(next);
    if (act.length + next.length > limits.maxEntries || tokens + nt > limits.maxTokens) {
        args.state.next = 0;
        trip({ kind: 'chain', would: act.length + next.length, wouldTokens: tokens + nt, kept: act.length, keptTokens: tokens, book: mainBook(next) });
    }
}

function trip(info) {
    lastTrip = { ...info, at: Date.now(), chat: St.ctx().chatId ?? '' };
    console.warn(LOG, 'emergency brake', lastTrip);
    if (!UI.open) setAlert(true);
    const key = `${lastTrip.chat}|${info.book}|${info.kind}`;
    if (tripShown.has(key)) return;
    tripShown.add(key);
    const f = n => Number(n).toLocaleString();
    const what = info.kind === 'chain' ? 'จะดึงเอนทรีเป็นลูกโซ่' : 'เทิร์นนี้จะติด';
    const did = info.kind === 'chain' ? 'หยุดลูกโซ่ไว้ที่' : 'ตัดเหลือ';
    toast.warning(`${info.book ? `“${info.book}” ` : ''}${what} ${f(info.would)} เอนทรี ≈${f(info.wouldTokens)} โทเคน · ${did} ${f(info.kept)} เอนทรี ≈${f(info.keptTokens)} โทเคน${info.book ? '\nแตะเพื่อตรวจและซ่อมเล่มนี้' : ''}`,
        '🛑 Lore Master: เบรกฉุกเฉิน', { timeOut: 15000, extendedTimeOut: 8000, onclick: info.book ? () => { checkBook(info.book); openLM(null, 'doctor'); } : undefined });
}

/** Warn once per book when the chat uses a lorebook that is huge. */
const warnedBooks = new Set();
async function warnBigBooks() {
    if (!settings().warnBigBooks) return;
    for (const name of St.usage().keys()) {
        if (warnedBooks.has(name)) continue;
        warnedBooks.add(name);
        try {
            const data = await W.loadWorldInfo(name);
            if (!data) continue;
            const st = bookStats(data);
            if (st.tokens < 100000 && st.count < 300) continue;
            toast.warning(`“${name}” มี ${st.count.toLocaleString()} เอนทรี ≈${st.tokens.toLocaleString()} โทเคน ${settings().guard ? 'เบรกฉุกเฉินเปิดอยู่ ST จะไม่ค้าง แต่' : 'เล่มขนาดนี้ทำให้ ST ค้างได้ และ'}ควรตรวจเล่มก่อนเล่น\nแตะเพื่อตรวจ`,
                'Lore Master: lorebook ใหญ่มาก', { timeOut: 15000, extendedTimeOut: 8000, onclick: () => { checkBook(name); openLM(null, 'doctor'); } });
        } catch { /* ignore */ }
    }
}

// ---------------------------------------------------------------- runtime: glossary "saving mode"

const GLOSS_KEY = 'lore-master-glossary';
let glossLines = [];
function setGlossaryPrompt(text) {
    try { St.ctx().setExtensionPrompt?.(GLOSS_KEY, text, 0 /* IN_PROMPT */, 0, false, 0); } catch (e) { console.warn(LOG, e); }
}
function recentChat() {
    return (St.ctx().chat ?? []).filter(m => !m.is_system && m.mes).slice(-6).map(m => `${m.name}: ${m.mes}`).join('\n');
}
/** Before every scan: glossary saving mode, then the emergency brake. */
function onEntriesLoaded(lore) {
    status.loadedAt = Date.now();
    status.loadedCount = lore ? [lore.globalLore, lore.characterLore, lore.chatLore, lore.personaLore].filter(Array.isArray).reduce((n, a) => n + a.length, 0) : 0;
    glossLines = [];
    setGlossaryPrompt('');
    if (!lore) return;
    const arrays = [lore.globalLore, lore.characterLore, lore.chatLore, lore.personaLore].filter(Array.isArray);
    if (settings().glossarySmart) {
        for (const arr of arrays) {
            for (let i = arr.length - 1; i >= 0; i--) {
                if (!isGlossary(arr[i])) continue;
                if (!arr[i].disable) glossLines.push(...parseGlossary(arr[i].content));
                arr.splice(i, 1);
            }
        }
    }
    try { guardBeforeScan(arrays); } catch (e) { console.error(LOG, 'emergency brake failed', e); scanCtx = null; }
}

// ---------------------------------------------------------------- settings drawer + slash command

function mountSettings() {
    const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!host || document.getElementById('lm_settings')) return;
    const div = document.createElement('div');
    div.id = 'lm_settings';
    div.innerHTML = `
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header"><b>Lore Master <small class="lm_vertag">v${VERSION}</small></b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
      <div class="inline-drawer-content">
        <div class="lm_drawer_btns">
          <div class="menu_button" data-lm="books"><i class="fa-solid fa-book-atlas"></i> เปิด Lore Master</div>
          <div class="menu_button" data-lm="doctor"><i class="fa-solid fa-stethoscope"></i> ตรวจ & รวม</div>
          <div class="menu_button" data-lm="settings"><i class="fa-solid fa-gear"></i> ตั้งค่า</div>
          <div class="menu_button" data-lm-look><i class="fa-solid fa-palette"></i> แต่งหน้าตาปุ่ม</div>
          <div class="menu_button" data-lm-reload title="ดึงไฟล์ของ Lore Master จากเซิร์ฟเวอร์ใหม่ทั้งหมดแล้วโหลดหน้าใหม่"><i class="fa-solid fa-rotate"></i> โหลดเวอร์ชันล่าสุด</div>
        </div>
        <div class="lm_verline">ที่รันอยู่: <b>v${VERSION}</b> <span data-lm-remote></span></div>
        <small>จัดการ lorebook คู่กับหน้า World Info ของ ST (จะให้ใช้แทนเลยก็ได้ ตั้งในหน้า ตั้งค่า ของ Lore Master) · พิมพ์ <code>/lore</code></small>
      </div>
    </div>`;
    host.appendChild(div);
    div.addEventListener('click', e => {
        if (e.target.closest('[data-lm-reload]')) return reloadWithFreshFiles();
        if (e.target.closest('[data-lm-look]')) return openCustomize();
        const t = e.target.closest('[data-lm]');
        if (t) openLM(null, t.dataset.lm);
    });
    checkForNewVersion(true);
}

// ---------------------------------------------------------------- version check + hard refresh
//
// SillyTavern loads extension files by a fixed URL, and browsers (and home-screen web apps on
// iOS, which rarely reload for real) keep the old files cached after "Update". Compare with the
// manifest on the server; if it is newer, say so, and offer to refetch every file and reload.

let remoteVersion = '';
let versionCheckedAt = 0;
let versionToastShown = false;
const newer = (a, b) => {
    const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
    return false;
};
async function fetchRemoteVersion() {
    try {
        const res = await fetch(new URL('manifest.json', BASE_URL), { cache: 'no-store' });
        if (!res.ok) return '';
        return String((await res.json())?.version ?? '');
    } catch { return ''; }
}
function showRemote() {
    const stale = remoteVersion && newer(remoteVersion, VERSION);
    document.querySelectorAll('[data-lm-remote]').forEach(el => {
        el.innerHTML = !remoteVersion ? '' : stale ? `· ติดตั้งไว้ <b>v${esc(remoteVersion)}</b> <span class="lm_stale">ยังไม่ได้โหลด กด “โหลดเวอร์ชันล่าสุด”</span>` : '· เป็นเวอร์ชันล่าสุดที่ติดตั้งไว้แล้ว';
    });
}
export async function checkForNewVersion(force = false) {
    if (!force && Date.now() - versionCheckedAt < 10 * 60_000) return remoteVersion;
    versionCheckedAt = Date.now();
    remoteVersion = await fetchRemoteVersion();
    showRemote();
    if (remoteVersion && newer(remoteVersion, VERSION) && !versionToastShown) {
        versionToastShown = true;
        toast.info(`ติดตั้ง v${esc(remoteVersion)} ไว้แล้ว แต่หน้านี้ยังรัน v${VERSION} อยู่<br>แตะที่นี่เพื่อโหลดเวอร์ชันใหม่`, 'Lore Master', {
            timeOut: 0, extendedTimeOut: 0, closeButton: true, escapeHtml: false, onclick: () => reloadWithFreshFiles(),
        });
    }
    return remoteVersion;
}
async function reloadWithFreshFiles() {
    try {
        await St.flush();
        toast.info('กำลังดึงไฟล์ใหม่…', 'Lore Master', { timeOut: 2000 });
        // cache: 'reload' fetches from the server and overwrites the browser's cached copy,
        // so the page reload below runs the new files
        await Promise.all(FILES.map(f => fetch(new URL(f, BASE_URL), { cache: 'reload' }).catch(() => null)));
    } finally {
        location.reload();
    }
}
shell.reload = reloadWithFreshFiles;
shell.checkVersion = async () => { await checkForNewVersion(true); return remoteVersion; };

function registerCommands() {
    try {
        const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = St.ctx();
        if (!SlashCommandParser || !SlashCommand) return;
        const callback = (_args, value) => {
            const name = String(value ?? '').trim();
            if (name) {
                const found = St.bookNames().find(n => n.toLowerCase() === name.toLowerCase()) ?? St.bookNames().find(n => n.toLowerCase().includes(name.toLowerCase()));
                if (found) { openLM([{ v: 'book', name: found }]); return ''; }
                toast.warning(`ไม่เจอเล่ม “${name}”`);
            }
            openLM();
            return '';
        };
        const props = {
            callback,
            helpString: 'เปิด Lore Master (จัดการ lorebook) ใส่ชื่อเล่มต่อท้ายเพื่อเปิดเล่มนั้นเลย เช่น <code>/lore Cody</code>',
        };
        if (SlashCommandArgument && ARGUMENT_TYPE) {
            props.unnamedArgumentList = [SlashCommandArgument.fromProps({ description: 'ชื่อเล่ม (ไม่ใส่ก็ได้)', typeList: [ARGUMENT_TYPE.STRING], isRequired: false })];
        }
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({ name: 'lore', aliases: ['loremaster', 'lm'], ...props }));
    } catch (e) { console.warn(LOG, 'slash command', e); }
}

// ================================================================ start

(function init() {
    settings();
    if (migrated.replaceWorldInfo) {
        save();
        setTimeout(() => toast.info('ตั้งแต่ v0.6 ปุ่ม World Info ปุ่มลูกโลก และ Chat Lore ของ ST เปิดหน้าเดิมของ ST ตามปกติ เปิด Lore Master ได้จากปุ่มลอย เมนูไม้กายสิทธิ์ หรือ /lore<br>ถ้าอยากให้ปุ่มของ ST เปิด Lore Master แทนเหมือนเดิม แตะที่นี่แล้วเลือก “ใช้แทน”',
            'Lore Master', { timeOut: 20000, extendedTimeOut: 8000, closeButton: true, escapeHtml: false, onclick: () => openLM(null, 'settings') }), 2500);
    }
    initDoctor();
    mountSettings();
    refreshEntryPoints();
    registerCommands();
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('change', onImportChange, true);
    const { eventSource, eventTypes } = St.ctx();
    const E = eventTypes ?? {};
    if (E.WORLDINFO_SCAN_DONE) eventSource.on(E.WORLDINFO_SCAN_DONE, onScanDone);
    else console.warn(LOG, 'no WORLDINFO_SCAN_DONE event — the per-turn cap needs a newer SillyTavern');
    if (E.WORLDINFO_ENTRIES_LOADED) eventSource.on(E.WORLDINFO_ENTRIES_LOADED, onEntriesLoaded);
    else console.warn(LOG, 'no WORLDINFO_ENTRIES_LOADED event — the glossary saving mode needs a newer SillyTavern');
    if (E.APP_READY) eventSource.on(E.APP_READY, () => { mountSettings(); refreshEntryPoints(); });
    // re-draw when the chat / links change, but never under the user's fingers while they type
    const typing = () => { const a = document.activeElement; return !!a && root?.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName); };
    const rerender = () => { if (UI.open && !typing()) render(); };
    for (const ev of [E.CHAT_CHANGED, E.WORLDINFO_SETTINGS_UPDATED, E.CHARACTER_EDITED].filter(Boolean)) eventSource.on(ev, rerender);
    if (E.CHAT_CHANGED) eventSource.on(E.CHAT_CHANGED, () => setTimeout(warnBigBooks, 800));
    if (E.WORLDINFO_UPDATED) {
        eventSource.on(E.WORLDINFO_UPDATED, async name => {
            St.statCache.delete(name);
            if (await St.reloadIfOpen(name)) rerender();
        });
    }
    // keep the extra launchers alive if the theme / UI rebuilds those parts
    setTimeout(() => checkForNewVersion(), 3000);
    if (E.CHAT_CHANGED) eventSource.on(E.CHAT_CHANGED, () => checkForNewVersion());
    setInterval(() => { if (!document.getElementById('lm_wand') && settings().wand) renderWand(); if (!document.getElementById('lm_wi_btn') && settings().stPanelButton) renderWiButton(); }, 4000);
    globalThis.LoreMaster = { open: openLM, openBook: name => openLM([{ v: 'book', name }]), openEntry, customize: openCustomize, version: VERSION, lastCut: () => lastCut, fired: firedIn, lastTrip: () => lastTrip, glossary: () => glossLines, remote: () => remoteVersion, isStale: () => !!remoteVersion && newer(remoteVersion, VERSION), status: () => ({ ...status, events: { before: !!E.WORLDINFO_ENTRIES_LOADED, after: !!E.WORLDINFO_SCAN_DONE } }) };
    console.log(LOG, `v${VERSION} ready`);
})();
