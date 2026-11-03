/*
 * Lore Master — small UI toolkit shared by the views: action registry, dialogs, sheets.
 */

import { escapeHtml } from './lib.js';

export const esc = escapeHtml;
export const toast = globalThis.toastr ?? { success: console.log, info: console.log, warning: console.warn, error: console.error };

/** data-act handlers, by event kind. Views register theirs at load. */
export const on = { click: {}, change: {}, input: {}, keydown: {} };
export function act(kind, map) { Object.assign(on[kind], map); }

/** Re-render hook set by index.js. */
export const shell = { render: () => {}, root: null };

export const icon = (name, extra = '') => `<i class="fa-solid ${name} ${extra}" aria-hidden="true"></i>`;

export function switchHtml(attrs, checked, label = '') {
    return `<label class="lm_switch" ${label ? `title="${esc(label)}"` : ''}><input type="checkbox" ${attrs} ${checked ? 'checked' : ''}><span class="lm_knob"></span>${label ? `<span class="lm_sr">${esc(label)}</span>` : ''}</label>`;
}

// ---------------------------------------------------------------- dialogs (own, so they sit above the overlay and match it)

function layer() {
    const host = shell.root ?? document.body;
    const el = document.createElement('div');
    el.className = 'lm_layer';
    host.appendChild(el);
    return el;
}

/**
 * Bottom sheet with a list of choices. Resolves with the chosen value or null.
 * @param {{title?:string, sub?:string, items:{value:any,label:string,icon?:string,danger?:boolean,disabled?:boolean,hint?:string,on?:boolean}[]}} o
 */
export function sheet({ title = '', sub = '', items }) {
    return new Promise(resolve => {
        const el = layer();
        el.innerHTML = `
        <div class="lm_scrim" data-x></div>
        <div class="lm_sheet" role="menu">
          <div class="lm_grab"></div>
          ${title ? `<div class="lm_sheet_title">${esc(title)}</div>` : ''}
          ${sub ? `<div class="lm_sheet_sub">${esc(sub)}</div>` : ''}
          <div class="lm_sheet_items">${items.map((it, i) => it === '-' ? '<div class="lm_sep"></div>' : `
            <button class="lm_sheet_item ${it.danger ? 'lm_danger' : ''} ${it.on ? 'lm_on' : ''}" data-i="${i}" ${it.disabled ? 'disabled' : ''} role="menuitem">
              ${it.icon ? icon(it.icon) : ''}<span class="lm_grow">${esc(it.label)}${it.hint ? `<small>${esc(it.hint)}</small>` : ''}</span>${it.on ? icon('fa-check') : ''}
            </button>`).join('')}</div>
          <button class="lm_sheet_cancel" data-x>ยกเลิก</button>
        </div>`;
        const close = v => { el.classList.add('lm_closing'); setTimeout(() => el.remove(), 160); resolve(v); };
        el.addEventListener('click', e => {
            if (e.target.closest('[data-x]')) return close(null);
            const b = e.target.closest('[data-i]');
            if (b && !b.disabled) close(items[Number(b.dataset.i)].value);
        });
        el.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } });
        el.querySelector('.lm_sheet_item:not([disabled])')?.focus({ preventScroll: true });
    });
}

/** Confirm dialog. Resolves true/false. */
export function confirmBox({ title, text = '', ok = 'ตกลง', danger = false }) {
    return new Promise(resolve => {
        const el = layer();
        el.innerHTML = `
        <div class="lm_scrim" data-x></div>
        <div class="lm_dialog" role="alertdialog">
          <div class="lm_dialog_title">${esc(title)}</div>
          ${text ? `<div class="lm_dialog_text">${text}</div>` : ''}
          <div class="lm_dialog_btns"><button class="lm_btn" data-x>ยกเลิก</button><button class="lm_btn ${danger ? 'lm_btn_danger' : 'lm_primary'}" data-ok>${esc(ok)}</button></div>
        </div>`;
        const close = v => { el.remove(); resolve(v); };
        el.addEventListener('click', e => { if (e.target.closest('[data-x]')) close(false); else if (e.target.closest('[data-ok]')) close(true); });
        el.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(false); } });
        el.querySelector('[data-ok]').focus();
    });
}

/** Text prompt. Resolves with the text or null. */
export function promptBox({ title, text = '', value = '', ok = 'ตกลง', placeholder = '' }) {
    return new Promise(resolve => {
        const el = layer();
        el.innerHTML = `
        <div class="lm_scrim" data-x></div>
        <form class="lm_dialog" role="dialog">
          <div class="lm_dialog_title">${esc(title)}</div>
          ${text ? `<div class="lm_dialog_text">${text}</div>` : ''}
          <input class="lm_input" value="${esc(value)}" placeholder="${esc(placeholder)}" enterkeyhint="done">
          <div class="lm_dialog_btns"><button type="button" class="lm_btn" data-x>ยกเลิก</button><button type="submit" class="lm_btn lm_primary">${esc(ok)}</button></div>
        </form>`;
        const input = el.querySelector('input');
        const close = v => { el.remove(); resolve(v); };
        el.addEventListener('click', e => { if (e.target.closest('[data-x]')) close(null); });
        el.querySelector('form').addEventListener('submit', e => { e.preventDefault(); close(input.value.trim() || null); });
        el.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } });
        setTimeout(() => { input.focus(); input.select(); }, 50);
    });
}

/** Show a long text the user may edit before accepting it. Resolves with the text or null. */
export function previewBox({ title, text = '', value = '', ok = 'ใช้' }) {
    return new Promise(resolve => {
        const el = layer();
        el.innerHTML = `
        <div class="lm_scrim" data-x></div>
        <div class="lm_dialog lm_dialog_wide" role="dialog">
          <div class="lm_dialog_title">${esc(title)}</div>
          ${text ? `<div class="lm_dialog_text">${text}</div>` : ''}
          <textarea class="lm_input lm_preview" rows="12">${esc(value)}</textarea>
          <div class="lm_dialog_btns"><button class="lm_btn" data-x>ยกเลิก</button><button class="lm_btn lm_primary" data-ok>${esc(ok)}</button></div>
        </div>`;
        const ta = el.querySelector('textarea');
        const close = v => { el.remove(); resolve(v); };
        el.addEventListener('click', e => { if (e.target.closest('[data-x]')) close(null); else if (e.target.closest('[data-ok]')) close(ta.value.trim() || null); });
        el.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } });
    });
}

/** Pick one book. */
export async function pickBook(names, { title = 'เลือกเล่ม', exclude = [] } = {}) {
    const list = names.filter(n => !exclude.includes(n));
    if (!list.length) { toast.info('ไม่มีเล่มอื่นให้เลือก'); return null; }
    return sheet({ title, items: list.map(n => ({ value: n, label: n, icon: 'fa-book' })) });
}

export function download(name, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${String(name).replace(/[\\/:*?"<>|]/g, '_')}.json` });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export const fmt = n => Number(n || 0).toLocaleString();

// ---------------------------------------------------------------- navigation state

/** Which screen is showing. `stack` is the drill-down of the Books tab: library → book → entry. */
export const UI = {
    open: false,
    tab: 'books',          // books | doctor | settings
    stack: [{ v: 'library' }],
    scroll: new Map(),     // view key -> scrollTop
};
export const top = () => UI.stack[UI.stack.length - 1];
export const viewKey = v => `${UI.tab}:${v?.v ?? ''}:${v?.name ?? ''}:${v?.uid ?? ''}`;
export function push(v) { UI.tab = 'books'; UI.stack.push(v); shell.render(); }
export function back() {
    if (UI.tab === 'books' && UI.stack.length > 1) { UI.stack.pop(); shell.render(); return true; }
    return false;
}
export function goTab(tab) { UI.tab = tab; shell.render(); }
/** Replace the whole Books stack (e.g. "open this book" from elsewhere). */
export function goTo(stack) { UI.tab = 'books'; UI.stack = [{ v: 'library' }, ...stack]; shell.render(); }
