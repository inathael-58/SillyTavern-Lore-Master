/*
 * Lore Master — calling a model, with an ordered list of APIs (like Memory Hub):
 * 'main' (SillyTavern's current API) or Connection Manager profile ids. When one fails,
 * times out or answers with something unusable, the next one is tried.
 */

import { settings, save } from './prefs.js';

const LOG = '[LoreMaster]';
const ctx = () => SillyTavern.getContext();

export function profiles() {
    try { return ctx().ConnectionManagerRequestService?.getSupportedProfiles?.() ?? []; } catch { return []; }
}
/** Tasks that can have their own API list (null = use the main list). */
export const TASKS = { keys: 'คิดคีย์ไทย', condense: 'ย่อเนื้อหา', organize: 'จัดหมวด', translate: 'แปล' };

export function aiSettings() {
    const s = settings();
    s.ai = { sources: ['main'], timeoutSec: 90, ...(s.ai ?? {}) };
    if (!Array.isArray(s.ai.sources) || !s.ai.sources.length) s.ai.sources = ['main'];
    if (!s.ai.tasks || typeof s.ai.tasks !== 'object') s.ai.tasks = {};
    for (const t of Object.keys(TASKS)) if (!Array.isArray(s.ai.tasks[t]) || !s.ai.tasks[t].length) s.ai.tasks[t] = null;
    return s.ai;
}
/** The list a task uses: its own, or the main one. */
export function listFor(task) {
    const a = aiSettings();
    return (task && a.tasks[task]) || a.sources;
}

// ---------------------------------------------------------------- requests used today (this device)

const USAGE_KEY = 'loremaster_ai_usage';
const today = () => new Date().toLocaleDateString('sv'); // YYYY-MM-DD, local time
function readUsage() {
    try {
        const u = JSON.parse(localStorage.getItem(USAGE_KEY) ?? 'null');
        return u && u.date === today() ? u : { date: today(), counts: {} };
    } catch { return { date: today(), counts: {} }; }
}
function countRequest(src) {
    const u = readUsage();
    u.counts[src] = (u.counts[src] ?? 0) + 1;
    try { localStorage.setItem(USAGE_KEY, JSON.stringify(u)); } catch { /* ignore */ }
}
/** Requests sent to this API today from this device (each attempt counts, also failed ones). */
export const usedToday = src => readUsage().counts[src] ?? 0;
export function sourceLabel(id) {
    if (id === 'main') return 'API หลักของ ST';
    const p = profiles().find(x => x.id === id);
    return p ? p.name : '(profile ที่ถูกลบไปแล้ว)';
}
export function activeSources(task) {
    const known = new Set(profiles().map(p => p.id));
    const list = listFor(task).filter(id => id === 'main' || known.has(id));
    return list.length ? list : ['main'];
}
/** Memory Hub's list, if it is installed and has one. */
export function memoryHubSources() {
    const mh = ctx().extensionSettings?.memory_hub;
    return Array.isArray(mh?.sources) && mh.sources.length ? [...mh.sources] : null;
}
export function copyFromMemoryHub() {
    const list = memoryHubSources();
    if (!list) return false;
    const a = aiSettings();
    a.sources = list;
    if (Number(ctx().extensionSettings.memory_hub?.timeoutSec) > 0) a.timeoutSec = Number(ctx().extensionSettings.memory_hub.timeoutSec);
    save();
    return true;
}

async function callOne(src, messages, maxTokens, timeoutMs, signal) {
    const c = ctx();
    if (signal?.aborted) throw new Error('หยุดแล้ว');
    if (src === 'main') {
        let timer;
        const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`ไม่ตอบภายใน ${timeoutMs / 1000} วินาที`)), timeoutMs); });
        const stop = new Promise((_, rej) => signal?.addEventListener('abort', () => rej(new Error('หยุดแล้ว')), { once: true }));
        try {
            return await Promise.race([c.generateRaw({ prompt: structuredClone(messages), responseLength: maxTokens }), timeout, stop]);
        } finally { clearTimeout(timer); }
    }
    const svc = c.ConnectionManagerRequestService;
    if (!svc) throw new Error('Connection Manager ไม่พร้อมใช้งาน');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    signal?.addEventListener('abort', () => ac.abort(), { once: true });
    try {
        const res = await svc.sendRequest(src, structuredClone(messages), maxTokens, { stream: false, signal: ac.signal, extractData: true, includePreset: true });
        return typeof res === 'string' ? res : String(res?.content ?? '');
    } catch (e) {
        if (signal?.aborted) throw new Error('หยุดแล้ว');
        if (ac.signal.aborted) throw new Error(`ไม่ตอบภายใน ${timeoutMs / 1000} วินาที`);
        throw e;
    } finally { clearTimeout(timer); }
}

/** Last outcome, for the settings screen. */
export let lastCall = null; // { ok, label, error?, ms }

/**
 * Ask the model. `accept(out)` returns the parsed value, or throws if the answer is unusable
 * (then the next API is tried).
 * @template T
 * @param {{system:string, user:string, maxTokens?:number, accept?:(out:string)=>T, signal?:AbortSignal, onTry?:(label:string)=>void, task?:string|null}} o
 * @returns {Promise<T>}
 */
export async function ask({ system, user, maxTokens = 2000, accept = out => out, signal, onTry, task = null }) {
    const a = aiSettings();
    const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
    const errors = [];
    for (const src of activeSources(task)) {
        const label = sourceLabel(src);
        onTry?.(label);
        const t0 = Date.now();
        countRequest(src);
        try {
            const out = await callOne(src, messages, maxTokens, a.timeoutSec * 1000, signal);
            if (!String(out ?? '').trim()) throw new Error('ได้คำตอบว่าง (อาจโดน safety filter หรือโควต้าหมด)');
            const value = accept(String(out));
            lastCall = { ok: true, label, ms: Date.now() - t0 };
            return value;
        } catch (e) {
            if (signal?.aborted) throw new Error('หยุดแล้ว');
            console.warn(LOG, `API ${label} failed`, e);
            errors.push(`${label}: ${e?.message ?? e}`);
        }
    }
    lastCall = { ok: false, label: 'ทุก API', error: errors.join(' · ') };
    throw new Error(errors.join('\n'));
}
