/*
 * Lore Master — SillyTavern extension
 *
 * A mobile-first replacement for SillyTavern's World Info panel:
 *   • Books: every lorebook, what is in use right now, one book's entries, a full entry editor
 *   • ตรวจ & รวม: import books from other sites (JanitorAI…), merge books, find and fix
 *     what makes them misfire, test, save (v0.1)
 *   • Settings: ST's global World Info settings in plain Thai, entry points, per-turn caps
 *
 * Entry points (like Chat Browser): floating button, top-bar icon, the World Info button itself,
 * the card's globe button and Chat Lore button, the wand menu, /lore, a button inside ST's panel.
 *
 * Files: lib.js (pure logic) · store.js (SillyTavern data) · ui.js (toolkit, navigation)
 *        editor.js · doctor.js · settingsview.js (screens) · prefs.js (settings)
 */

import {
    detectFormat, FORMAT_LABEL, overCap, isGlossary, parseGlossary, pickGlossary, GLOSSARY_HEAD,
    keyScanner, wouldFire, trimToLimits, byPriority, estTokens, bookStats,
} from './lib.js';
import * as St from './store.js';
import { settings, save } from './prefs.js';
import { esc, icon, on, shell, UI, top, back, goTab, viewKey, toast } from './ui.js';
import { viewLibrary, viewBook, viewEntry, enterBook, hooks, onFieldEvent, onFocusOut, onToggleDetails, focusAfterRender, autosize } from './editor.js';
import { viewDoctor, checkBook, importFiles, startMerge, importJson, initDoctor, thaiBook, condenseBook } from './doctor.js';
import { viewSettings } from './settingsview.js';

const LOG = '[LoreMaster]';
const VERSION = '0.4.0';
const W = St.WIref;

hooks.checkBook = checkBook;
hooks.importFiles = importFiles;
hooks.mergeBooks = startMerge;
hooks.thaiBook = thaiBook;
hooks.condenseBook = condenseBook;

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
    root.addEventListener('input', ev => { if (!onFieldEvent(ev)) dispatch('input', ev); });
    root.addEventListener('keydown', onKeydown);
    root.addEventListener('focusout', onFocusOut);
    root.addEventListener('toggle', onToggleDetails, true);
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
    if (a === 'nav') { const t = el.dataset.tab; if (UI.tab === t && t === 'books' && UI.stack.length > 1) { UI.stack = [UI.stack[0]]; } goTab(t); return; }
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
            : v.v === 'book' ? viewBook(v) : v.v === 'entry' ? viewEntry(v) : viewLibrary();
    } catch (e) {
        console.error(LOG, e);
        view = { title: 'Lore Master', body: `<div class="lm_card lm_err">เกิดข้อผิดพลาด: ${esc(e?.message ?? e)}</div>` };
    }
    const canBack = UI.tab === 'books' && UI.stack.length > 1;
    const nav = [['books', 'fa-book', 'เล่ม'], ['doctor', 'fa-stethoscope', 'ตรวจ & รวม'], ['settings', 'fa-gear', 'ตั้งค่า']];
    root.dataset.scheme = settings().scheme;
    root.dataset.view = UI.tab === 'books' ? v.v : UI.tab;
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
}
function renderLauncher() {
    let el = document.getElementById('lm_launcher');
    if (!settings().launcher) { el?.remove(); return; }
    if (el) return placeLauncher(el);
    el = document.createElement('div');
    el.id = 'lm_launcher';
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.title = 'Lore Master — lorebook';
    el.innerHTML = icon('fa-book-atlas');
    document.body.append(el);
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFromContext(); } });
    let start = null, moved = false;
    el.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        const r = el.getBoundingClientRect();
        start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, id: e.pointerId };
        moved = false;
        try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    });
    el.addEventListener('pointermove', e => {
        if (!start || e.pointerId !== start.id) return;
        const dx = e.clientX - start.x, dy = e.clientY - start.y;
        if (!moved && Math.hypot(dx, dy) < 6) return;
        moved = true;
        el.classList.add('lm_dragging');
        const a = visibleArea();
        el.style.left = `${clamp(start.left + dx, a.x, a.x + a.w - el.offsetWidth)}px`;
        el.style.top = `${clamp(start.top + dy, a.y, a.y + a.h - el.offsetHeight)}px`;
    });
    const end = e => {
        if (!start || e.pointerId !== start.id) return;
        start = null;
        if (!moved) { if (e.type === 'pointerup') openFromContext(); return; }
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
window.addEventListener('resize', () => placeLauncher());
window.visualViewport?.addEventListener('resize', () => placeLauncher());

function renderTopbar() {
    let el = document.getElementById('lm_topbar');
    if (!settings().topbar) { el?.remove(); return; }
    if (el) return;
    const holder = document.getElementById('top-settings-holder');
    if (!holder) return;
    el = document.createElement('div');
    el.id = 'lm_topbar';
    el.className = 'drawer';
    el.innerHTML = `<div class="drawer-toggle"><div class="drawer-icon fa-solid fa-book-bookmark fa-fw closedIcon interactable" title="Lore Master" tabindex="0"></div></div>`;
    const before = document.getElementById('rightNavHolder');
    if (before?.parentElement === holder) holder.insertBefore(el, before); else holder.append(el);
    el.addEventListener('click', e => { e.stopPropagation(); openFromContext(); }, true);
}

function renderWand() {
    let el = document.getElementById('lm_wand');
    if (!settings().wand) { el?.remove(); return; }
    const menu = document.getElementById('extensionsMenu');
    if (!menu || el) return;
    el = document.createElement('div');
    el.id = 'lm_wand';
    el.className = 'list-group-item flex-container flexGap5 interactable';
    el.tabIndex = 0;
    el.innerHTML = '<div class="fa-solid fa-book-atlas extensionsMenuExtensionButton"></div><span>Lore Master</span>';
    el.addEventListener('click', () => openFromContext());
    menu.append(el);
}

function renderWiButton() {
    if (document.getElementById('lm_wi_btn')) return;
    const anchor = document.getElementById('world_import_button');
    if (!anchor) return;
    const b = document.createElement('div');
    b.id = 'lm_wi_btn';
    b.className = 'menu_button fa-solid fa-book-bookmark';
    b.title = 'เปิดใน Lore Master';
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
    // the last loop of the scan: send only the glossary names that matter this turn
    if (glossLines.length && !args?.state?.next) {
        const picked = pickGlossary(glossLines, { text: recentChat(), activated: [...map.values()] });
        setGlossaryPrompt(picked.length ? `${GLOSSARY_HEAD}\n${picked.map(l => `- ${l.en} = ${l.th}`).join('\n')}` : '');
    }
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
      <div class="inline-drawer-toggle inline-drawer-header"><b>Lore Master</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
      <div class="inline-drawer-content">
        <div class="lm_drawer_btns">
          <div class="menu_button" data-lm="books"><i class="fa-solid fa-book-atlas"></i> เปิด Lore Master</div>
          <div class="menu_button" data-lm="doctor"><i class="fa-solid fa-stethoscope"></i> ตรวจ & รวม</div>
          <div class="menu_button" data-lm="settings"><i class="fa-solid fa-gear"></i> ตั้งค่า</div>
        </div>
        <small>จัดการ lorebook แทนหน้า World Info ของ ST · ตั้งค่าทางเข้าได้ในหน้า ตั้งค่า ของ Lore Master · พิมพ์ <code>/lore</code></small>
      </div>
    </div>`;
    host.appendChild(div);
    div.addEventListener('click', e => { const t = e.target.closest('[data-lm]'); if (t) openLM(null, t.dataset.lm); });
}

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
    setInterval(() => { if (!document.getElementById('lm_wand') && settings().wand) renderWand(); if (!document.getElementById('lm_wi_btn')) renderWiButton(); }, 4000);
    globalThis.LoreMaster = { open: openLM, openBook: name => openLM([{ v: 'book', name }]), version: VERSION, lastCut: () => lastCut, lastTrip: () => lastTrip, glossary: () => glossLines };
    console.log(LOG, `v${VERSION} ready`);
})();
