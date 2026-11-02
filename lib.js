/*
 * Lore Master — pure logic (no DOM, no SillyTavern imports), so it can be tested in Node.
 *
 *  • read lorebooks from other sites (JanitorAI export, character_book / V2 card,
 *    SillyTavern's own format) into SillyTavern entries
 *  • merge several books into one
 *  • diagnose what makes imported books misfire in SillyTavern, and describe each
 *    fix as plain data (a "change") that applyChanges() carries out
 *  • simulate which entries a piece of text would trigger, the way SillyTavern does
 */

export const THAI = /[฀-๿]/;
export const LOGIC = { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 };
export const POSITION = { before: 0, after: 1, ANTop: 2, ANBottom: 3, atDepth: 4, EMTop: 5, EMBottom: 6, outlet: 7 };

/** Mirrors SillyTavern's newWorldInfoEntryTemplate; index.js passes the real one when it can. */
export const ENTRY_DEFAULTS = Object.freeze({
    key: [], keysecondary: [], comment: '', content: '', constant: false, vectorized: false,
    selective: true, selectiveLogic: 0, addMemo: true, order: 100, position: 0, disable: false,
    ignoreBudget: false, excludeRecursion: false, preventRecursion: false,
    matchPersonaDescription: false, matchCharacterDescription: false, matchCharacterPersonality: false,
    matchCharacterDepthPrompt: false, matchScenario: false, matchCreatorNotes: false,
    delayUntilRecursion: 0, probability: 100, useProbability: true, depth: 4, outletName: '',
    group: '', groupOverride: false, groupWeight: 100, scanDepth: null, caseSensitive: null,
    matchWholeWords: null, useGroupScoring: null, automationId: '', role: 0,
    sticky: null, cooldown: null, delay: null, triggers: [],
});

// ---------------------------------------------------------------- small helpers

export const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const escapeRegex = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `/pattern/flags` keys, as SillyTavern reads them. */
export function parseRegexKey(key) {
    const m = /^\/([\w\W]+?)\/([gimsuy]*)$/.exec(String(key ?? ''));
    if (!m) return null;
    try { return new RegExp(m[1], m[2].replace('g', '')); } catch { return null; }
}

/** Rough token count: ~4 Latin characters or ~2 Thai characters per token. */
export function estTokens(text) {
    const s = String(text ?? '');
    let thai = 0;
    for (const ch of s) if (THAI.test(ch)) thai++;
    return Math.ceil(thai / 2 + (s.length - thai) / 4);
}

/** Split "a, b, c" (keys pasted into one box), strip quotes and spaces, drop empties and repeats. */
export function cleanKeys(keys) {
    const out = [];
    const seen = new Set();
    for (const raw of Array.isArray(keys) ? keys : [keys]) {
        if (raw === null || raw === undefined) continue;
        const s = String(raw);
        const parts = parseRegexKey(s.trim()) ? [s.trim()] : s.split(/[,，、\n]/);
        for (let p of parts) {
            p = p.trim().replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '').trim();
            if (!p) continue;
            const k = p.toLowerCase();
            if (seen.has(k)) continue;
            seen.add(k);
            out.push(p);
        }
    }
    return out;
}

/** "Weld / Garrick Voss" → ["Weld", "Garrick Voss"]; "Marc Ellis — Point Guard" → ["Marc Ellis", "Point Guard"]. */
export function titleParts(comment) {
    return String(comment ?? '').split(/\s+[\/|—–-]\s+|\s*[()]\s*/).map(x => x.trim()).filter(Boolean);
}

/** Main name of an entry, normalised for comparing. */
export const normTitle = comment => (titleParts(comment)[0] ?? '').toLowerCase().replace(/^(the|dr\.?|mr\.?|mrs\.?|ms\.?)\s+/, '').replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------- reading other formats

/**
 * What kind of lorebook file is this?
 * janitor  – JanitorAI export: a bare array of entries
 * st       – SillyTavern: { entries: { uid: entry } }
 * charbook – character_book / Chub lorebook: { entries: [ ... ] }
 * card     – a character card JSON with data.character_book
 * novel / agnai / risu – formats SillyTavern itself converts (index.js hands them to ST)
 */
export function detectFormat(json) {
    if (Array.isArray(json)) {
        return json.length && json.every(e => e && typeof e === 'object' && 'content' in e) ? 'janitor' : null;
    }
    if (!json || typeof json !== 'object') return null;
    if (json.lorebookVersion !== undefined) return 'novel';
    if (json.kind === 'memory') return 'agnai';
    if (json.type === 'risu') return 'risu';
    if (json.entries && typeof json.entries === 'object' && !Array.isArray(json.entries)) return 'st';
    if (Array.isArray(json.entries)) return 'charbook';
    if (Array.isArray(json.data?.character_book?.entries)) return 'card';
    if (Array.isArray(json.character_book?.entries)) return 'card';
    return null;
}

export const FORMAT_LABEL = {
    janitor: 'JanitorAI', st: 'SillyTavern', charbook: 'Character book', card: 'การ์ดตัวละคร',
    novel: 'NovelAI', agnai: 'Agnai', risu: 'RisuAI',
};

const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : d);

/**
 * One entry from JanitorAI or the character_book spec → a SillyTavern entry.
 * Field names of both are accepted, so a Janitor array wrapped in { entries: [...] } also works.
 */
export function fromLooseEntry(e, index, { defaultPosition = POSITION.before, template = ENTRY_DEFAULTS } = {}) {
    const x = e.extensions && typeof e.extensions === 'object' ? e.extensions : {};
    const splitRaw = s => (typeof s === 'string' ? s.split(',') : []);
    const keys = cleanKeys(e.keys ?? e.key ?? splitRaw(e.keysRaw ?? e.keywordsRaw));
    const secondary = cleanKeys(e.secondary_keys ?? e.keysecondary ?? splitRaw(e.keysecondaryRaw));
    let position = x.position;
    if (position === undefined) position = e.position === 'before_char' ? POSITION.before : e.position === 'after_char' ? POSITION.after : defaultPosition;
    const mode = String(e.activationMode ?? '').toLowerCase();
    const probability = num(x.probability ?? e.probability, 100);
    const minMessages = num(e.minMessages, 0);
    const entry = {
        ...structuredClone(template),
        uid: index,
        displayIndex: index,
        key: keys,
        keysecondary: secondary,
        comment: String(e.comment || e.name || ''),
        content: String(e.content ?? ''),
        constant: !!e.constant || mode === 'constant' || mode === 'always',
        selective: secondary.length > 0,
        selectiveLogic: num(x.selectiveLogic ?? e.selectiveLogic, LOGIC.AND_ANY),
        order: num(e.insertion_order ?? e.order, 100),
        position: num(position, defaultPosition),
        depth: num(x.depth ?? e.depth, 4),
        disable: e.enabled === false || e.disable === true,
        addMemo: true,
        probability,
        useProbability: x.useProbability ?? probability < 100,
        excludeRecursion: x.exclude_recursion ?? e.excludeRecursion ?? false,
        preventRecursion: x.prevent_recursion ?? e.preventRecursion ?? false,
        delayUntilRecursion: x.delay_until_recursion ?? 0,
        group: String(x.group ?? e.group ?? e.inclusionGroupRaw ?? ''),
        groupOverride: x.group_override ?? !!e.prioritizeInclusion,
        groupWeight: num(x.group_weight ?? e.groupWeight, 100),
        scanDepth: x.scan_depth ?? null,
        caseSensitive: x.case_sensitive ?? (e.case_sensitive === true || e.caseSensitive === true ? true : null),
        matchWholeWords: x.match_whole_words ?? (typeof e.matchWholeWords === 'boolean' ? e.matchWholeWords : null),
        role: x.role ?? 0,
        sticky: x.sticky ?? null,
        cooldown: x.cooldown ?? null,
        delay: x.delay ?? (minMessages > 0 ? minMessages : null),
        extensions: { ...x },
    };
    const script = String(e.activationScript ?? '').trim();
    if (script) entry._script = script;
    if (e.category && e.category !== 'other') entry._category = String(e.category);
    return entry;
}

/**
 * Any supported file → { format, name, entries[] } with SillyTavern entries.
 * `convert` handles novel/agnai/risu (SillyTavern's own converters, passed in by index.js).
 */
export function readLorebook(json, { name = '', defaultPosition = POSITION.before, template = ENTRY_DEFAULTS, convert = null } = {}) {
    let format = detectFormat(json);
    if (!format) throw new Error('ไม่รู้จักรูปแบบไฟล์นี้ (ไม่ใช่ lorebook)');
    if (format === 'novel' || format === 'agnai' || format === 'risu') {
        if (!convert) throw new Error(`ยังอ่านไฟล์ ${FORMAT_LABEL[format]} ไม่ได้`);
        const st = convert(format, json);
        return { format, name: name || json.name || '', entries: stEntries(st, template) };
    }
    if (format === 'st') return { format, name: name || json.name || '', entries: stEntries(json, template) };
    const book = format === 'card' ? (json.data?.character_book ?? json.character_book) : format === 'charbook' ? json : { entries: json };
    const entries = book.entries.filter(e => e && typeof e === 'object').map((e, i) => fromLooseEntry(e, i, { defaultPosition, template }));
    const cardName = json.data?.name ?? json.name;
    return { format, name: name || book.name || (format === 'card' ? cardName : '') || '', entries };
}

function stEntries(world, template) {
    return Object.values(world.entries ?? {})
        .filter(e => e && typeof e === 'object')
        .sort((a, b) => num(a.displayIndex, num(a.uid, 0)) - num(b.displayIndex, num(b.uid, 0)) || num(a.uid, 0) - num(b.uid, 0))
        .map(e => ({ ...structuredClone(template), ...structuredClone(e), key: Array.isArray(e.key) ? [...e.key] : cleanKeys(e.key), keysecondary: Array.isArray(e.keysecondary) ? [...e.keysecondary] : cleanKeys(e.keysecondary) }));
}

/**
 * Several books → one list with fresh uids. Each entry remembers where it came from in `_src`.
 * @param {{name: string, entries: any[]}[]} books
 */
export function mergeBooks(books) {
    const out = [];
    for (const b of books) {
        for (const e of b.entries) {
            const copy = structuredClone(e);
            copy._src = b.name;
            copy._origUid = e.uid;
            copy.uid = out.length;
            copy.displayIndex = out.length;
            out.push(copy);
        }
    }
    return out;
}

/** Entries → a SillyTavern world file. Internal `_` fields are dropped. */
export function toWorld(entries, { prefixSource = false, template = ENTRY_DEFAULTS } = {}) {
    const world = { entries: {} };
    entries.forEach((e, i) => {
        const clean = { ...structuredClone(template) };
        for (const [k, v] of Object.entries(e)) if (!k.startsWith('_')) clean[k] = structuredClone(v);
        clean.uid = i;
        clean.displayIndex = i;
        if (prefixSource && e._src && !clean.comment.startsWith(`[${e._src}]`)) clean.comment = `[${e._src}] ${clean.comment}`.trim();
        clean.selective = (clean.keysecondary?.length ?? 0) > 0 || clean.selective;
        world.entries[i] = clean;
    });
    return world;
}

// ---------------------------------------------------------------- matching like SillyTavern

/** Does `key` occur in `text`? Same rules as SillyTavern's matchKeys (non-unicode \W, so Thai keys match inside words). */
export function keyMatches(text, key, { caseSensitive = false, wholeWords = false } = {}) {
    const re = parseRegexKey(key);
    if (re) return re.test(text);
    let hay = String(text ?? '');
    let needle = String(key ?? '').trim();
    if (!needle) return false;
    if (!caseSensitive) { hay = hay.toLowerCase(); needle = needle.toLowerCase(); }
    if (wholeWords) {
        if (needle.split(/\s+/).length > 1) return hay.includes(needle);
        return new RegExp(`(?:^|\\W)(${escapeRegex(needle)})(?:$|\\W)`).test(hay);
    }
    return hay.includes(needle);
}

export function subMacros(s, names = {}) {
    return String(s ?? '')
        .replace(/\{\{char\}\}|<BOT>/gi, names.char || '{{char}}')
        .replace(/\{\{user\}\}|<USER>/gi, names.user || '{{user}}');
}

function matchOpts(entry, opts) {
    return {
        caseSensitive: entry.caseSensitive ?? opts.caseSensitive ?? false,
        wholeWords: entry.matchWholeWords ?? opts.wholeWords ?? false,
    };
}

/** The primary key that fires `entry` on `text`, or null. Secondary keys are checked too. */
export function firingKey(entry, text, opts = {}) {
    const mo = matchOpts(entry, opts);
    const names = opts.names ?? {};
    const hit = (entry.key ?? []).find(k => keyMatches(text, subMacros(k, names), mo));
    if (hit === undefined) return null;
    const sec = (entry.keysecondary ?? []).filter(Boolean);
    if (!entry.selective || !sec.length) return hit;
    const found = sec.map(k => keyMatches(text, subMacros(k, names), mo));
    const any = found.some(Boolean), all = found.every(Boolean);
    const logic = Number(entry.selectiveLogic ?? 0);
    const ok = logic === LOGIC.AND_ANY ? any : logic === LOGIC.NOT_ALL ? !all : logic === LOGIC.NOT_ANY ? !any : logic === LOGIC.AND_ALL ? all : true;
    return ok ? hit : null;
}

/**
 * Which entries would `text` trigger? Probability, groups, delays and the token budget are
 * ignored (the result is the worst case); recursion works as in SillyTavern.
 * @returns {{ hits: {entry:any, key:string|null, step:number, via:'constant'|'key'|'recursion'}[], tokens:number, steps:number }}
 */
export function simulate(entries, text, { recursive = true, maxSteps = 0, caseSensitive = false, wholeWords = false, names = {} } = {}) {
    const opts = { caseSensitive, wholeWords, names };
    const hits = [];
    const done = new Set();
    let recurse = '';
    let step = 0;
    const live = entries.filter(e => !e.disable);
    while (step < 30) {
        step++;
        const now = [];
        for (const e of live) {
            if (done.has(e)) continue;
            if (e.constant) {
                if (step === 1) now.push({ entry: e, key: null, step, via: 'constant' });
                continue;
            }
            if (step > 1 && (e.excludeRecursion || !recurse)) continue;
            const scan = step === 1 ? text : recurse;
            const k = firingKey(e, scan, opts);
            if (k !== null) now.push({ entry: e, key: k, step, via: step === 1 ? 'key' : 'recursion' });
        }
        if (!now.length) break;
        for (const h of now) { done.add(h.entry); hits.push(h); }
        if (!recursive || (maxSteps && step >= maxSteps)) break;
        const more = now.filter(h => !h.entry.preventRecursion).map(h => subMacros(h.entry.content, names)).join('\n');
        if (!more) break;
        recurse = `${recurse}\n${more}`;
    }
    return { hits, tokens: hits.reduce((n, h) => n + estTokens(h.entry.content), 0), steps: step };
}

// ---------------------------------------------------------------- diagnosis

/** Common English words that make poor keys on their own (they show up in ordinary prose). */
export const COMMON_WORDS = new Set(`
a an the i me my you your he him his she her it its we us our they them their this that these those
is are was were be been am do does did have has had will would can could should may might must
and or but if so not no yes up down in on at to of for from with by as into out over under off
mom mum dad mother father sister brother son daughter aunt uncle grandma grandpa baby kid kids boy girl man woman
men women guy lady sir madam mister miss mr mrs ms dr doc friend friends partner rival enemy boss
park bell switch brake ticket conductor grant rook arena center centre coach wing station library campus
hotel travel court market deli clinic mechanic doctor nurse teacher professor captain officer detective
police cop guard king queen prince princess lord master home house room school class office bar club
cafe shop store garden church temple tower bridge river lake sea ocean forest city town village street
road gate hall castle palace dungeon cave mountain hill field farm camp base lab hospital prison jail
ship car bus train plane bike phone computer game team crew gang guild family hero villain monster
demon angel god spirit ghost witch wizard mage knight soldier army war battle fight magic power energy
fire water ice earth wind light dark shadow night day morning evening sun moon star sky rain snow storm
blood heart soul mind body eye hand head love hate fear hope dream memory secret story book letter map
key door window bed table chair sword shield bow gun knife blade ring crown gold silver iron stone
glass wood paper food drink wine beer coffee tea bread meat apple rose lily ruby pearl crystal diamond
jade amber violet iris hazel ivy holly autumn summer winter spring dawn faith grace joy honey candy
fox wolf bear cat dog bird rabbit snake dragon tiger lion hawk raven crow owl eagle deer horse mouse rat
spider bee bug moth will mark rob bill pat ray art max hunter cook young long white black brown green
gray grey red blue cross chase price ward moss rivers stone grant park
shooter center guard forward point season practice training film fouls hotel travel statistics
conditioning sprints eligibility seeding endorsement pregame waterfront clinic station deli library
campus coach mechanic superintendent forklift blackmailer walk-on
`.trim().split(/\s+/));

const SEVERITY_RANK = { high: 0, mid: 1, low: 2 };
let changeSeq = 0;
const change = (c) => ({ id: `c${++changeSeq}`, checked: true, ...c });

const keyText = e => [...(e.key ?? [])].join(' ');
const nameOf = e => titleParts(e.comment)[0] || (e.key ?? [])[0] || `#${e.uid}`;
/** "Kingsbridge point guard": the word is followed by an ordinary lower-case word, so it names a part of the same thing. */
function isPartOf(phrase, word, entry) {
    const raw = [...(entry.key ?? []), ...titleParts(entry.comment)].find(s => s.toLowerCase().includes(phrase.split(' ')[0])) ?? '';
    const m = new RegExp(`(?:^|\\s)${escapeRegex(word)}\\s+(\\S+)`, 'i').exec(raw);
    return !!m && /^[a-z]/.test(m[1]);
}
const isWordKey = k => !parseRegexKey(k) && !/\s/.test(String(k).trim());

/**
 * Look for everything that makes an imported book misfire.
 * @param {any[]} entries
 * @param {{ names?: {char?:string,user?:string}, recursive?: boolean, wholeWords?: boolean, caseSensitive?: boolean, isThaiDictWord?: (s:string)=>boolean }} ctx
 * @returns {{ id:string, severity:'high'|'mid'|'low', title:string, why:string, changes:any[], note?:string, examples?:string[] }[]}
 */
export function diagnose(entries, ctx = {}) {
    const names = ctx.names ?? {};
    const opts = { caseSensitive: ctx.caseSensitive ?? false, wholeWords: ctx.wholeWords ?? true, names };
    const live = entries.filter(e => !e.disable);
    const issues = [];
    const byUid = new Map(entries.map(e => [e.uid, e]));

    // 1) messy keys: "a, b" in one key, quotes, blanks, repeats
    {
        const changes = [];
        for (const e of entries) {
            for (const field of ['key', 'keysecondary']) {
                const before = e[field] ?? [];
                const after = cleanKeys(before);
                if (JSON.stringify(before) !== JSON.stringify(after)) {
                    changes.push(change({ op: 'set', uid: e.uid, field, value: after, label: `${nameOf(e)}: ${before.map(k => `“${k}”`).join(' ')} → ${after.map(k => `“${k}”`).join(' ')}` }));
                }
            }
        }
        if (changes.length) issues.push({
            id: 'messy', short: 'จัดรูปแบบคีย์', severity: 'low', title: `คีย์รูปแบบเพี้ยน ${changes.length} จุด`,
            why: 'มีคีย์ที่หลายคำรวมอยู่ในช่องเดียว (เช่น "Noel, Noely") มีเครื่องหมายคำพูดติดมา หรือซ้ำกัน ST จะมองทั้งก้อนเป็นคำเดียว เลยไม่เคยติด',
            changes,
        });
    }

    // 2) the same thing written twice (common when a bot ships several books)
    const dupPairs = [];
    {
        const changes = [];
        const titles = live.map(e => ({ e, t: normTitle(e.comment) })).filter(x => x.t.split(' ').length >= 2);
        const used = new Set();
        const pairedTitle = new Set(); // "title|book": a book's sub-topics ("Marc Ellis — Stats") don't all pile into one entry
        for (let i = 0; i < titles.length; i++) {
            for (let j = i + 1; j < titles.length; j++) {
                const a = titles[i], b = titles[j];
                if (used.has(a.e) || used.has(b.e)) continue;
                if (pairedTitle.has(`${a.t}|${a.e._src}`) || pairedTitle.has(`${b.t}|${b.e._src}`)) continue;
                // already merged one entry of this title from that book: the rest are sub-topics
                if ((a.e._merged ?? []).includes(`${b.t}|${b.e._src}`) || (b.e._merged ?? []).includes(`${a.t}|${a.e._src}`)) continue;
                // inside one book the author split topics on purpose ("Marc Ellis — Stats"); only compare across books
                const sameBook = (a.e._src ?? '') === (b.e._src ?? '');
                if (sameBook && a.e.comment.trim().toLowerCase() !== b.e.comment.trim().toLowerCase()) continue;
                // "Head Coach Raymond Hale" ends with "Coach Raymond Hale"
                const same = a.t === b.t || a.t.endsWith(` ${b.t}`) || b.t.endsWith(` ${a.t}`);
                if (!same) continue;
                const [keep, drop] = a.e.content.length >= b.e.content.length ? [a.e, b.e] : [b.e, a.e];
                used.add(drop);
                pairedTitle.add(`${a.t}|${a.e._src}`).add(`${b.t}|${b.e._src}`);
                dupPairs.push([keep, drop]);
                const where = keep._src && drop._src && keep._src !== drop._src ? ` (${drop._src} → ${keep._src})` : '';
                changes.push(change({ op: 'merge', uid: drop.uid, into: keep.uid, label: `รวม “${drop.comment}” เข้ากับ “${keep.comment}”${where}` }));
            }
        }
        if (changes.length) issues.push({
            id: 'dupes', short: 'รวมเอนทรีที่ซ้ำกัน', severity: 'mid', title: `เรื่องเดียวกันเขียนไว้ 2 ที่ ${changes.length} คู่`,
            why: 'คีย์ของทั้งสองตัวทับกัน พอพูดถึงเรื่องนี้จะติดทั้งคู่ กินโทเคน 2 เท่า และถ้าเนื้อหาไม่ตรงกัน โมเดลจะสับสน รวมเป็นเอนทรีเดียว: เอาเนื้อหามาต่อกันและรวมคีย์',
            changes,
        });
    }
    const dupOf = new Map();
    for (const [a, b] of dupPairs) { dupOf.set(a, b); dupOf.set(b, a); }

    // 3) keys that are in practically every message: the character's own name, {{user}}, or words in most entries
    const keyFreq = new Map(); // lower key -> number of OTHER entries whose content has it
    {
        const changes = [];
        const always = [names.char, names.user, ...String(names.char ?? '').split(/\s+/)].filter(s => s && s.length > 1).map(s => s.toLowerCase());
        const minShare = Math.max(4, Math.ceil(live.length * 0.4));
        for (const e of live) {
            if (e.constant) continue;
            for (const k of e.key ?? []) {
                if (parseRegexKey(k)) continue;
                const lk = k.toLowerCase().trim();
                let reason = null;
                if (/^\{\{(char|user)\}\}$/i.test(k) || /^<(bot|user)>$/i.test(k)) reason = 'macro';
                else if (always.includes(lk)) reason = 'name';
                else if (!isWordKey(k)) continue;
                else {
                    if (!keyFreq.has(lk)) keyFreq.set(lk, live.filter(o => o !== e && keyMatches(subMacros(o.content, names), k, opts)).length);
                    if (keyFreq.get(lk) >= minShare) reason = 'everywhere';
                }
                if (!reason) continue;
                const left = (e.key ?? []).filter(x => x !== k).length;
                const why = reason === 'macro' ? 'ชื่อผู้เล่น/ตัวละครหลัก' : reason === 'name' ? 'ชื่อตัวละครหลัก' : `อยู่ในเนื้อหาของ ${keyFreq.get(lk)} เอนทรี`;
                changes.push(change({ op: 'removeKey', uid: e.uid, key: k, checked: left > 0, label: `${nameOf(e)}: ลบคีย์ “${k}” (${why})${left ? '' : ' — เป็นคีย์เดียวที่มี ต้องเพิ่มคีย์อื่นก่อน'}` }));
            }
        }
        if (changes.length) issues.push({
            id: 'everywhere', short: 'ลบคีย์ที่โผล่ทุกข้อความ', severity: 'high', title: `คีย์ที่โผล่แทบทุกข้อความ ${changes.length} คีย์`,
            why: 'ชื่อตัวละครหลัก {{user}} หรือคำที่อยู่ในเกือบทุกเอนทรี จะอยู่ในแชทแทบทุกเทิร์น (ST ใส่ชื่อคนพูดไว้หน้าทุกข้อความด้วย) เอนทรีที่ใช้คำพวกนี้เป็นคีย์จึงติดตลอดเหมือนเป็น constant',
            changes,
        });
    }

    // 4) generic words / numbers / very short keys
    {
        const changes = [];
        for (const e of live) {
            if (e.constant) continue;
            for (const k of e.key ?? []) {
                if (!isWordKey(k)) continue;
                const t = String(k).trim();
                const lk = t.toLowerCase();
                let why = null;
                if (/^#?\d+$/.test(t)) why = 'ตัวเลขอย่างเดียว';
                else if (!THAI.test(t) && t.length <= 2) why = 'สั้นเกินไป';
                else if (THAI.test(t) && ctx.isThaiDictWord?.(t) && [...t].length <= 4) why = 'คำไทยสั้นที่ไปติดกลางคำอื่นได้';
                else if (!THAI.test(t) && (COMMON_WORDS.has(lk) || (t === lk && /^[a-z][a-z'-]+$/.test(t)))) why = 'คำทั่วไป';
                if (!why) continue;
                if (changes.some(c => c.uid === e.uid && c.key === k)) continue;
                const left = (e.key ?? []).filter(x => x !== k).length;
                changes.push(change({ op: 'removeKey', uid: e.uid, key: k, checked: left > 0, label: `${nameOf(e)}: ลบคีย์ “${k}” (${why})${left ? '' : ' — เป็นคีย์เดียวที่มี'}` }));
            }
        }
        // don't list again what "everywhere" already covers
        const taken = new Set((issues.find(i => i.id === 'everywhere')?.changes ?? []).map(c => `${c.uid}|${c.key}`));
        const left = changes.filter(c => !taken.has(`${c.uid}|${c.key}`));
        if (left.length) issues.push({
            id: 'generic', short: 'ลบคีย์ที่เป็นคำทั่วไป', severity: 'mid', title: `คีย์เป็นคำทั่วไป ${left.length} คีย์`,
            why: 'คำอย่าง park, coach, library, #11 หรือคำที่ขึ้นต้นตัวเล็ก ใช้กันในประโยคปกติ เอนทรีเลยติดทั้งที่เรื่องไม่ได้พูดถึงสิ่งนั้น ลบคีย์พวกนี้ทิ้ง ยังเหลือชื่อเต็มให้ติดอยู่',
            changes: left,
        });
    }

    // 5) one-word key of entry A that is part of another entry's name ("Mercer" vs "Eli Mercer")
    {
        const changes = [];
        const covered = new Set(issues.flatMap(i => i.changes).filter(c => c.op === 'removeKey').map(c => `${c.uid}|${c.key.toLowerCase()}`));
        const dropTitle = s => s.replace(/^(the|dr\.?|mr\.?|mrs\.?|ms\.?|officer|detective|coach|professor)\s+/i, '');
        const phrasesOf = e => [...(e.key ?? []).filter(k => !isWordKey(k) && !parseRegexKey(k)), ...titleParts(e.comment)]
            .map(s => dropTitle(s.trim()).toLowerCase()).filter(s => s.includes(' '));
        const phrases = live.map(e => ({ e, list: phrasesOf(e) }));
        for (const a of live) {
            if (a.constant) continue;
            const own = new Set(phrasesOf(a));
            for (const k of a.key ?? []) {
                if (!isWordKey(k) || THAI.test(k)) continue;
                const lk = k.toLowerCase();
                if (covered.has(`${a.uid}|${lk}`)) continue;
                const re = new RegExp(`(?:^|\\s)${escapeRegex(lk)}(?:\\s|$)`);
                const hitBy = [];
                for (const p of phrases) {
                    if (p.e === a || dupOf.get(a) === p.e || (p.e.key ?? []).some(x => x.toLowerCase() === lk)) continue;
                    const bad = p.list.find(s => re.test(s) && !own.has(s) && !isPartOf(s, lk, p.e));
                    if (bad && !hitBy.includes(nameOf(p.e))) hitBy.push(nameOf(p.e));
                }
                if (!hitBy.length) continue;
                const surname = [...own].some(s => { const w = s.split(/\s+/); return w.length > 1 && w[w.length - 1] === lk; });
                const left = (a.key ?? []).filter(x => x !== k).length;
                const others = hitBy.slice(0, 3).join(', ') + (hitBy.length > 3 ? ` +${hitBy.length - 3}` : '');
                changes.push(change({
                    op: 'removeKey', uid: a.uid, key: k, checked: surname && left > 0,
                    label: `${nameOf(a)}: “${k}” ไปติดตอนพูดถึง ${others}${surname ? ' (เป็นนามสกุล)' : ' — ถ้าลบ ต้องพิมพ์ชื่อเต็มถึงจะติด'}`,
                }));
            }
        }
        changes.sort((x, y) => Number(y.checked) - Number(x.checked));
        if (changes.length) issues.push({
            id: 'clash', short: 'ลบคีย์ที่ชนกับชื่ออื่น', severity: 'mid', title: `คีย์ชนกับชื่อของเอนทรีอื่น ${changes.length} คีย์`,
            why: 'คีย์คำเดียวที่เป็นส่วนหนึ่งของชื่ออื่น เช่น “Mercer” ของตัวร้ายไปติดตอนพูดถึง “Eli Mercer” เพื่อนร่วมทีม ติ๊กไว้ให้เฉพาะนามสกุล ส่วนชื่อต้นเลือกเองว่าจะเก็บไหม',
            changes,
        });
    }

    // 6) recursion chains
    {
        const links = new Map(); // entry -> entries its content triggers
        for (const e of live) {
            if (e.preventRecursion) continue;
            const text = subMacros(e.content, names);
            const out = live.filter(o => o !== e && !o.constant && !o.excludeRecursion && firingKey(o, text, opts) !== null);
            if (out.length) links.set(e, out);
        }
        if (links.size) {
            const reach = (start) => {
                const seen = new Set([start]);
                const queue = [start];
                while (queue.length) for (const n of links.get(queue.shift()) ?? []) if (!seen.has(n)) { seen.add(n); queue.push(n); }
                return seen.size - 1;
            };
            const ranked = [...links.keys()].map(e => ({ e, n: reach(e) })).sort((a, b) => b.n - a.n);
            const top = ranked[0];
            issues.push({
                id: 'recursion', short: 'ตัดลูกโซ่ recursion', severity: ctx.recursive === false ? 'mid' : 'high',
                title: `ลูกโซ่ recursion: ติด 1 เอนทรี ลากตามมาได้ถึง ${top.n} เอนทรี`,
                why: 'เนื้อหาของเอนทรีมีชื่อของเอนทรีอื่น พอเอนทรีหนึ่งติด ST จะเอาเนื้อหาไปสแกนต่อ แล้วดึงเอนทรีอื่นตามมาเป็นทอด ๆ JanitorAI ไม่มีระบบนี้ บอทที่ทำมาจากที่นั่นจึงไม่ได้เขียนเผื่อ ทางแก้คือเปิด “Prevent further recursion” ให้ทุกเอนทรี' +
                    (ctx.recursive === false ? ' (ตอนนี้ ST ของเราปิด recursion อยู่ แต่คนที่เอาไปใช้ต่ออาจเปิดไว้)' : ''),
                examples: ranked.slice(0, 3).map(r => `${nameOf(r.e)} → ${links.get(r.e).slice(0, 4).map(nameOf).join(', ')}${links.get(r.e).length > 4 ? ` +${links.get(r.e).length - 4}` : ''} (รวมทอดต่อ ๆ ไป ${r.n})`),
                changes: [change({ op: 'setAll', field: 'preventRecursion', value: true, uids: [...links.keys()].map(e => e.uid), label: `เปิด Prevent further recursion ให้ ${links.size} เอนทรีที่ลากตัวอื่น` })],
            });
        }
    }

    // 7) too many always-on entries
    {
        const consts = live.filter(e => e.constant);
        const tokens = consts.reduce((n, e) => n + estTokens(e.content), 0);
        if (consts.length > 3 || tokens > 1500) {
            const sorted = [...consts].sort((a, b) => estTokens(a.content) - estTokens(b.content));
            const keepUid = sorted[0]?.uid;
            issues.push({
                id: 'constant', short: 'เลิกติดตลอด (constant)', severity: 'high', title: `ติดตลอด (constant) ${consts.length} เอนทรี ≈ ${tokens.toLocaleString()} โทเคนทุกเทิร์น`,
                why: 'เอนทรี constant เข้า prompt ทุกเทิร์นโดยไม่ต้องเจอคีย์ ควรเหลือเฉพาะเรื่องที่ต้องรู้ตลอด เช่น ภาพรวมโลก ที่เหลือเปลี่ยนให้ติดเมื่อเจอคีย์',
                changes: consts.map(e => change({
                    op: 'set', uid: e.uid, field: 'constant', value: false,
                    checked: e.uid !== keepUid && (e.key ?? []).length > 0,
                    label: `${nameOf(e)} (≈${estTokens(e.content)} โทเคน)${(e.key ?? []).length ? '' : ' — ไม่มีคีย์ ถ้าเปลี่ยนจะไม่ติดเลย'}`,
                })),
            });
        }
    }

    // 8) entries that can never fire
    {
        const changes = live.filter(e => !e.constant && !(e.key ?? []).length).map(e => {
            const parts = titleParts(e.comment).filter(p => p.length > 2);
            return change({ op: 'set', uid: e.uid, field: 'key', value: parts, checked: parts.length > 0, label: parts.length ? `${nameOf(e)}: ใช้ชื่อเอนทรีเป็นคีย์ (${parts.join(', ')})` : `#${e.uid}: ไม่มีทั้งคีย์และชื่อ ต้องใส่เอง` });
        });
        if (changes.length) issues.push({
            id: 'nokeys', short: 'ใส่คีย์ให้เอนทรีที่ไม่มีคีย์', severity: 'mid', title: `ไม่มีคีย์ ${changes.length} เอนทรี (ไม่มีวันติด)`,
            why: 'เอนทรีที่ไม่ได้เป็น constant และไม่มีคีย์ จะไม่ถูกใส่เข้า prompt เลย',
            changes,
        });
    }

    // 9) syntax from other sites that ST prints as-is
    {
        const changes = [];
        const notes = [];
        for (const e of live) {
            if (/^\s*@@/m.test(e.content)) changes.push(change({ op: 'stripDecorators', uid: e.uid, label: `${nameOf(e)}: ลบบรรทัด @@ ของ RisuAI` }));
            if (/\{\{#(if|each|when)\b|\{\{\/(if|each|when)\}\}/i.test(e.content)) notes.push(`${nameOf(e)}: มีเงื่อนไข {{#if}} ของเว็บอื่น ST ไม่รองรับ ต้องแก้เอง`);
            if (e._script) notes.push(`${nameOf(e)}: มีสคริปต์ทริกเกอร์ของ JanitorAI ซึ่ง ST ไม่รองรับ ใช้คีย์แทน`);
        }
        if (changes.length || notes.length) issues.push({
            id: 'foreign', short: 'ลบคำสั่งของเว็บอื่น', severity: 'mid', title: `คำสั่งของเว็บอื่นที่ ST ไม่รู้จัก ${changes.length + notes.length} จุด`,
            why: 'ST ไม่เข้าใจคำสั่งพวกนี้ จะส่งเข้า prompt ไปเป็นข้อความดิบ ๆ',
            changes, examples: notes.slice(0, 8),
        });
    }

    // 10) long entries (information only)
    {
        const big = live.filter(e => estTokens(e.content) > 700).sort((a, b) => estTokens(b.content) - estTokens(a.content));
        if (big.length) issues.push({
            id: 'big', severity: 'low', title: `เอนทรียาวเกิน 700 โทเคน ${big.length} ตัว`,
            why: 'ติดทีละไม่กี่ตัวก็กินงบหมดแล้ว ตัวอื่นที่สำคัญกว่าอาจถูกตัด ลองแยกเป็นหลายเอนทรีตามหัวข้อ',
            examples: big.slice(0, 6).map(e => `${nameOf(e)} ≈ ${estTokens(e.content)}`), changes: [],
        });
    }

    // 11) no Thai keys at all
    {
        const withThai = live.filter(e => (e.key ?? []).some(k => THAI.test(k))).length;
        if (live.length && withThai === 0) issues.push({
            id: 'thai', severity: 'low', title: 'ไม่มีคีย์ภาษาไทยเลย',
            why: 'ถ้าเล่นเป็นภาษาไทยและโมเดลเขียนชื่อเป็นภาษาไทย (เช่น “โคดี้” แทน “Cody”) คีย์ภาษาอังกฤษจะไม่ติด ตัวช่วยคิดคีย์ไทยจะมาในเวอร์ชันถัดไป',
            changes: [],
        });
    }

    for (const i of issues) for (const c of i.changes) c.issue = i.id;
    issues.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
    void byUid;
    return issues;
}

// ---------------------------------------------------------------- applying fixes

/** Carry out `changes` on a copy of `entries`. Changes that point at removed entries are skipped. */
export function applyChanges(entries, changes) {
    const out = structuredClone(entries);
    const by = new Map(out.map(e => [e.uid, e]));
    const removed = new Set();
    const movedTo = new Map(); // merged uid -> uid it went into
    const follow = uid => { while (movedTo.has(uid)) uid = movedTo.get(uid); return uid; };
    // keys first, merges last, so a merge carries the cleaned keys
    const order = { set: 0, removeKey: 1, stripDecorators: 2, setAll: 3, merge: 4 };
    const list = [...changes].sort((a, b) => (order[a.op] ?? 9) - (order[b.op] ?? 9));
    for (const c of list) {
        if (c.op === 'setAll') {
            for (const uid of c.uids) { const e = by.get(uid); if (e) e[c.field] = structuredClone(c.value); }
            continue;
        }
        const e = by.get(c.uid);
        if (!e || removed.has(c.uid)) continue;
        if (c.op === 'set') e[c.field] = structuredClone(c.value);
        else if (c.op === 'removeKey') e.key = (e.key ?? []).filter(k => k !== c.key);
        else if (c.op === 'stripDecorators') e.content = e.content.split('\n').filter(l => !/^\s*@@/.test(l)).join('\n').trim();
        else if (c.op === 'merge') {
            const target = follow(c.into);
            const into = by.get(target);
            if (!into || target === c.uid) continue;
            const head = `# ${titleParts(e.comment)[0] || e.comment}`;
            into.content = `${into.content.trim()}\n\n${e.content.trim().startsWith('#') ? '' : `${head}\n`}${e.content.trim()}`;
            into.key = cleanKeys([...(into.key ?? []), ...(e.key ?? [])]);
            into.keysecondary = cleanKeys([...(into.keysecondary ?? []), ...(e.keysecondary ?? [])]);
            into.preventRecursion = into.preventRecursion || e.preventRecursion;
            into._merged = [...(into._merged ?? []), ...(e._merged ?? []), `${normTitle(e.comment)}|${e._src}`];
            removed.add(e.uid);
            movedTo.set(e.uid, target);
        }
    }
    return out.filter(e => !removed.has(e.uid));
}

/** Totals for the header line. */
export function summarize(entries) {
    const live = entries.filter(e => !e.disable);
    return {
        count: entries.length,
        live: live.length,
        constant: live.filter(e => e.constant).length,
        tokens: live.reduce((n, e) => n + estTokens(e.content), 0),
        thaiKeys: live.filter(e => (e.key ?? []).some(k => THAI.test(k))).length,
    };
}

// ---------------------------------------------------------------- per-turn cap (runtime)

/**
 * Which activated entries to drop so each capped book keeps at most `cap` entries.
 * SillyTavern activates entries in priority order (higher `order` first, recursion
 * after), so the ones activated last are the least important: those go first.
 * Constant entries are always kept.
 * @param {any[]} activated entries in activation order (each with .world)
 * @param {Record<string, number>} caps book name -> max entries
 */
export function overCap(activated, caps) {
    const drop = [];
    const count = new Map();
    for (const e of activated) if (caps[e.world] > 0) count.set(e.world, (count.get(e.world) ?? 0) + 1);
    for (let i = activated.length - 1; i >= 0; i--) {
        const e = activated[i];
        const n = count.get(e.world);
        if (!n || n <= caps[e.world] || e.constant) continue;
        drop.push(e);
        count.set(e.world, n - 1);
    }
    return drop;
}

// ---------------------------------------------------------------- editor helpers

/** Where an entry goes in the prompt, in words. */
export const POSITION_INFO = [
    { value: 0, short: '↑ตัวละคร', label: 'ก่อนข้อมูลตัวละคร', help: 'อยู่ในส่วนข้อมูลตั้งต้นของ prompt เหมาะกับข้อมูลโลก ตัวละครรอง สถานที่ (ค่าที่ใช้กันมากที่สุด)' },
    { value: 1, short: '↓ตัวละคร', label: 'หลังข้อมูลตัวละคร', help: 'เหมือนด้านบน แต่อยู่ถัดจากการ์ด โมเดลให้น้ำหนักมากกว่านิดหน่อย' },
    { value: 5, short: '↑ตัวอย่าง', label: 'ก่อนตัวอย่างบทสนทนา', help: 'แทรกก่อน Example Messages ของการ์ด' },
    { value: 6, short: '↓ตัวอย่าง', label: 'หลังตัวอย่างบทสนทนา', help: 'แทรกหลัง Example Messages ของการ์ด' },
    { value: 2, short: '↑AN', label: "บน Author's Note", help: "ต่อท้ายด้านบนของ Author's Note (ต้องเปิดใช้ Author's Note)" },
    { value: 3, short: '↓AN', label: "ล่าง Author's Note", help: "ต่อท้ายด้านล่างของ Author's Note" },
    { value: 4, short: '@D', label: 'ในแชท ตามความลึก', help: 'แทรกเป็นข้อความในแชท ห่างจากข้อความล่าสุดตามจำนวนที่ตั้ง (0 = ล่างสุด) โมเดลเห็นชัดที่สุด แต่ถ้าติดหลายตัวจะรกบทสนทนา' },
    { value: 7, short: 'Outlet', label: 'Outlet (ใช้กับมาโคร)', help: 'ไม่ใส่เอง จะไปโผล่ตรงที่เขียน {{outlet::ชื่อ}} ไว้ใน prompt หรือการ์ด' },
];
export const positionInfo = v => POSITION_INFO.find(p => p.value === Number(v)) ?? POSITION_INFO[0];
export function positionShort(e) {
    const p = positionInfo(e.position);
    if (p.value === 4) return `@D${e.depth ?? 4}${['', '👤', '🤖'][Number(e.role) || 0]}`;
    if (p.value === 7) return `Outlet:${e.outletName || '?'}`;
    return p.short;
}

export const ROLE_INFO = [
    { value: 0, label: 'System (ระบบ)' },
    { value: 1, label: 'User (ผู้เล่น)' },
    { value: 2, label: 'Assistant (บอท)' },
];

export const LOGIC_INFO = [
    { value: LOGIC.AND_ANY, label: 'ต้องเจอคำใดคำหนึ่งในนี้ด้วย' },
    { value: LOGIC.AND_ALL, label: 'ต้องเจอครบทุกคำในนี้ด้วย' },
    { value: LOGIC.NOT_ANY, label: 'ต้องไม่เจอคำไหนในนี้เลย' },
    { value: LOGIC.NOT_ALL, label: 'ต้องไม่เจอครบทุกคำในนี้' },
];

export const TRIGGER_INFO = [
    { value: 'normal', label: 'ส่งข้อความปกติ' },
    { value: 'continue', label: 'Continue' },
    { value: 'impersonate', label: 'Impersonate' },
    { value: 'swipe', label: 'Swipe' },
    { value: 'regenerate', label: 'Regenerate' },
    { value: 'quiet', label: 'Quiet (extension สั่งเจนเบื้องหลัง)' },
];

/** off | constant | vector | key */
export function entryStatus(e) {
    if (e.disable) return 'off';
    if (e.constant) return 'constant';
    if (e.vectorized) return 'vector';
    return 'key';
}

/** A SillyTavern world's entries as a list, in the book's own order. */
export function entriesOf(world) {
    return Object.values(world?.entries ?? {})
        .filter(e => e && typeof e === 'object')
        .sort((a, b) => num(a.displayIndex, num(a.uid, 0)) - num(b.displayIndex, num(b.uid, 0)) || num(a.uid, 0) - num(b.uid, 0));
}

/** The lowest unused uid. */
export function freeUid(world) {
    const used = new Set(Object.keys(world?.entries ?? {}).map(Number));
    let i = 0;
    while (used.has(i)) i++;
    return i;
}

/** A new entry for `world`, put at the end of the book. */
export function newEntry(world, template = ENTRY_DEFAULTS, patch = {}) {
    const uid = freeUid(world);
    const last = entriesOf(world).reduce((m, e) => Math.max(m, num(e.displayIndex, -1)), -1);
    return { ...structuredClone(template), uid, displayIndex: last + 1, addMemo: true, ...structuredClone(patch) };
}

/** Problems with one key, for the editor. level: bad (fires far too often / never) | warn | info */
export function keyWarnings(key, { names = {}, isThaiDictWord = null } = {}) {
    const k = String(key ?? '').trim();
    const out = [];
    if (!k) return out;
    if (/^\/.*\/[a-z]*$/i.test(k) && !parseRegexKey(k)) out.push({ level: 'bad', text: 'regex ไม่ถูกต้อง จะไม่ติด' });
    if (parseRegexKey(k)) return out;
    const lk = k.toLowerCase();
    const always = [names.char, names.user, ...String(names.char ?? '').split(/\s+/)].filter(s => s && s.length > 1).map(s => s.toLowerCase());
    if (/^\{\{(char|user)\}\}$/i.test(k) || always.includes(lk)) out.push({ level: 'bad', text: 'ชื่อตัวละครหลัก/ผู้เล่น อยู่ในแชททุกเทิร์น เอนทรีจะติดตลอด' });
    else if (/^#?\d+$/.test(k)) out.push({ level: 'warn', text: 'เป็นตัวเลขอย่างเดียว ติดกับตัวเลขในประโยคปกติ' });
    else if (!THAI.test(k) && k.length <= 2) out.push({ level: 'warn', text: 'สั้นเกินไป ไปติดกับคำอื่นง่าย' });
    else if (THAI.test(k) && isThaiDictWord?.(k) && [...k].length <= 4) out.push({ level: 'warn', text: 'คำไทยสั้น ไปติดกลางคำอื่นได้ (เช่น “ยา” ใน “พยายาม”)' });
    else if (!THAI.test(k) && !/\s/.test(k) && COMMON_WORDS.has(lk)) out.push({ level: 'warn', text: 'คำทั่วไป ติดทั้งที่เรื่องไม่ได้พูดถึง' });
    else if (!THAI.test(k) && !/\s/.test(k) && k === lk && /^[a-z][a-z'-]+$/.test(k)) out.push({ level: 'info', text: 'คำตัวเล็กทั่วไป อาจติดบ่อยกว่าที่ตั้งใจ' });
    return out;
}

/** Warnings for one entry as a whole (for the list badge). */
export function entryWarnings(e, ctx = {}) {
    const out = [];
    if (!e.disable && !e.constant && !e.vectorized && !(e.key ?? []).length) out.push('ไม่มีคีย์ ไม่มีวันติด');
    if (estTokens(e.content) > 700) out.push(`ยาว ≈${estTokens(e.content)} โทเคน`);
    if (!String(e.content ?? '').trim()) out.push('ไม่มีเนื้อหา');
    for (const k of e.key ?? []) for (const w of keyWarnings(k, ctx)) if (w.level !== 'info') out.push(`“${k}”: ${w.text}`);
    return out;
}

/** Does the entry match a search? Searches title, keys and content; every word must match. */
export function entryMatches(e, query) {
    const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const hay = [e.comment, ...(e.key ?? []), ...(e.keysecondary ?? []), e.content, `#${e.uid}`].join('\n').toLowerCase();
    return words.every(w => hay.includes(w));
}

export const SORTS = {
    book: { label: 'ลำดับในเล่ม', fn: () => 0 },
    name: { label: 'ชื่อ ก–ฮ', fn: (a, b) => String(a.comment || '').localeCompare(String(b.comment || ''), ['th', 'en'], { numeric: true }) },
    order: { label: 'order มากสุด', fn: (a, b) => num(b.order, 0) - num(a.order, 0) },
    tokens: { label: 'ยาวสุด', fn: (a, b) => estTokens(b.content) - estTokens(a.content) },
};

/** Book-level totals for the list. */
export function bookStats(world) {
    const list = entriesOf(world);
    const live = list.filter(e => !e.disable);
    return {
        count: list.length,
        on: live.length,
        constant: live.filter(e => e.constant).length,
        tokens: live.reduce((n, e) => n + estTokens(e.content), 0),
    };
}
