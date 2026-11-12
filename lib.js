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
/** An entry longer than this is "long" (warnings, condense suggestions). */
export const LONG_TOKENS = 500;
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
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c >= 0x0E00 && c <= 0x0E7F) thai++; }
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

/**
 * The category a title names before the entry's own name, for grouping a long book:
 * "[NPC] Cody", "【สถานที่】ตลาดน้ำ", "สถานที่: ตลาดน้ำ", "Cody - วัยเด็ก" → { cat, rest }.
 * A bracketed prefix may be long (Lore Master's merge writes "[source book name] title", and book
 * names are often long file names); an unbracketed one only counts when short (≤ 30 characters),
 * so ordinary sentences are left alone.
 */
export function splitCategory(comment) {
    const s = String(comment ?? '').trim();
    const pick = (cat, rest, max) => (cat = cat.trim(), rest = rest.trim(), cat && rest && cat.length <= max ? { cat, rest } : null);
    let m = s.match(/^[[【〔(（]([^\]】〕)）]+)[\]】〕)）]\s*(.+)$/u);
    if (m) return pick(m[1], m[2], 100);
    m = s.match(/^([^:：]+?)\s*[:：]\s*(.+)$/u);
    if (m && !/^\d+$/.test(m[1].trim())) return pick(m[1], m[2], 30);
    m = s.match(/^(.+?)\s+[/|—–-]\s+(.+)$/u);
    if (m) return pick(m[1], m[2], 30);
    return null;
}

/** Entries whose title prefix is shared by at least `min` of them: Map(uid → { cat, rest }). */
function shared(items, min) {
    const split = new Map();
    const count = new Map();
    const label = new Map();
    for (const { uid, title } of items) {
        const c = splitCategory(title);
        if (!c) continue;
        const k = c.cat.toLowerCase();
        split.set(uid, { ...c, k });
        count.set(k, (count.get(k) ?? 0) + 1);
        if (!label.has(k)) label.set(k, c.cat);
    }
    const out = new Map();
    for (const [uid, c] of split) if (count.get(c.k) >= min) out.set(uid, { cat: label.get(c.k), rest: c.rest });
    return out;
}

/** Where the AI organiser (or the person) stores an entry's category, so titles can stay clean. */
export const CATEGORY_KEY = 'lore_master_category';
export function entryCategory(e) {
    const c = e?.extensions?.[CATEGORY_KEY];
    return typeof c === 'string' && c.trim() ? c.trim() : '';
}

/**
 * Category of each entry, as Map(uid → { cat, rest }):
 *  - a stored category (CATEGORY_KEY) always counts;
 *  - otherwise a title prefix shared by at least `min` entries (case-insensitive).
 *    A prefix used once is just part of a name, not a category.
 * One level deeper when the rest has its own shared prefix: "[Book] NPC: Cody" → "Book › NPC", "Cody".
 */
export function categorize(entries, min = 2) {
    const fixed = new Map();
    const free = [];
    for (const e of entries) {
        const c = entryCategory(e);
        if (!c) { free.push(e); continue; }
        const sp = splitCategory(e.comment);
        fixed.set(e.uid, { cat: c, rest: sp && sp.cat.toLowerCase() === c.toLowerCase() ? sp.rest : String(e.comment ?? '') });
    }
    const top = shared(free.map(e => ({ uid: e.uid, title: e.comment })), min);
    for (const [uid, c] of fixed) top.set(uid, c);
    const byCat = new Map();
    for (const [uid, c] of top) {
        if (!byCat.has(c.cat)) byCat.set(c.cat, []);
        byCat.get(c.cat).push({ uid, title: c.rest });
    }
    for (const [cat, items] of byCat) {
        for (const [uid, c] of shared(items, min)) top.set(uid, { cat: `${cat} › ${c.cat}`, rest: c.rest });
    }
    return top;
}

// ---------------------------------------------------------------- AI organiser: categories and tidy titles

const ORG_LANG = { th: 'Thai', en: 'English' };
const oneLine = (t, n) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export const organizePlanSystem = lang => `You organise a roleplay lorebook (SillyTavern World Info) so a person can browse hundreds of entries on a phone. You get every entry's id, title and first keywords. Choose the categories.
Rules:
- 4 to 12 categories, each 1-3 words, about the kind of thing an entry describes (for example: characters, places, organisations or teams, items, events, history, relationships, rules of the world, writing instructions). Pick what this book actually contains. Split a big kind (for example many characters) only where it splits naturally (by team, family, faction).
- Every entry must fit one category. Avoid a catch-all; if one is needed, keep it small.
- Category names in ${ORG_LANG[lang] ?? 'Thai'}.
Keep any thinking brief. Answer with JSON only: {"categories":[{"name":"...","about":"one short line: what goes here"}]}`;

export function organizePlanRequest(entries) {
    return `Entries (id | title | keywords):\n${entries.map(e => `${e.uid} | ${oneLine(e.comment, 80) || '(no title)'} | ${(e.key ?? []).slice(0, 3).map(k => oneLine(k, 30)).join(', ')}`).join('\n')}`;
}

export function parseOrganizePlan(text) {
    const j = parseJsonLoose(text);
    const cats = (Array.isArray(j?.categories) ? j.categories : [])
        .map(c => (typeof c === 'string' ? { name: c, about: '' } : { name: oneLine(c?.name, 40), about: oneLine(c?.about, 120) }))
        .filter(c => c.name);
    const seen = new Set();
    const out = cats.filter(c => !seen.has(c.name.toLowerCase()) && seen.add(c.name.toLowerCase()));
    if (out.length < 2) throw new Error('AI ไม่ได้ให้รายชื่อหมวดมา');
    return out.slice(0, 16);
}

export const organizeSystem = (lang, cats) => `You sort roleplay lorebook entries into categories and give each entry a short, tidy title.
Categories (use these names exactly; add a new one only if an entry fits none, named in ${ORG_LANG[lang] ?? 'Thai'}):
${cats.map(c => `- ${c.name}${c.about ? `: ${c.about}` : ''}`).join('\n')}
Title rules:
- 1-6 words, at most 40 characters: the name of the person, place or thing the entry is about. Not a sentence.
- Keep the language and spelling the entry uses for names. Never translate a proper noun.
- Drop book or file names in brackets, things like "_SillyTavern", "Lorebook", ".json", "v2", underscores (use spaces), emoji, numbering like "01.", and the category word itself (the category is shown separately).
- Several entries about one subject: "Subject – aspect" with an en dash, for example "Cody – Childhood".
- If the title is already short and clear, return it unchanged. If it is empty or meaningless, name it from the text.
- English titles in Title Case.
Keep any thinking brief. Answer with JSON only: {"entries":[[id,"category","title"], ...]} with one item for every id you were given.`;

export function organizeRequest(entries) {
    return `Entries (id | title | keywords | start of text):\n${entries.map(e => `${e.uid} | ${oneLine(e.comment, 100) || '(no title)'} | ${(e.key ?? []).slice(0, 4).map(k => oneLine(k, 30)).join(', ')} | ${oneLine(e.content, 160)}`).join('\n')}`;
}

/** Map(String(uid) → { cat, name }). Throws when the answer covers too few of the ids (the next API is tried). */
export function parseOrganizeReply(text, ids) {
    const j = parseJsonLoose(text);
    const want = new Set([...ids].map(String));
    const out = new Map();
    for (const it of Array.isArray(j?.entries) ? j.entries : []) {
        const [id, cat, name] = Array.isArray(it) ? it : [it?.id, it?.category ?? it?.cat, it?.title ?? it?.name];
        const k = String(id);
        const c = oneLine(cat, 40);
        if (!want.has(k) || !c) continue;
        out.set(k, { cat: c, name: oneLine(name, 60) });
    }
    if (out.size < Math.ceil(want.size * 0.7)) throw new Error(`AI ตอบมาแค่ ${out.size} จาก ${want.size} เอนทรี`);
    return out;
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
// Big books (500+ entries, megabytes of text) are checked key by key against every entry,
// so lower-casing and regex building are cached instead of being redone millions of times.
const lowerCache = new Map();
function lowered(s) {
    let l = lowerCache.get(s);
    if (l === undefined) {
        if (lowerCache.size > 4000) lowerCache.clear();
        l = s.toLowerCase();
        lowerCache.set(s, l);
    }
    return l;
}
const regexCache = new Map();
function cachedRegex(key, make) {
    let r = regexCache.get(key);
    if (r === undefined) {
        if (regexCache.size > 4000) regexCache.clear();
        r = make();
        regexCache.set(key, r);
    }
    return r;
}

export function keyMatches(text, key, { caseSensitive = false, wholeWords = false } = {}) {
    const k = String(key ?? '');
    const re = cachedRegex(`R${k}`, () => parseRegexKey(k));
    if (re) return re.test(text);
    let hay = String(text ?? '');
    let needle = k.trim();
    if (!needle) return false;
    if (!caseSensitive) { hay = lowered(hay); needle = needle.toLowerCase(); }
    if (!hay.includes(needle)) return false;
    if (wholeWords && !/\s/.test(needle)) {
        return cachedRegex(`W${needle}`, () => new RegExp(`(?:^|\\W)(${escapeRegex(needle)})(?:$|\\W)`)).test(hay);
    }
    return true;
}

/**
 * Finds, in one pass over a text, which entries have a primary key in it. Used instead of
 * testing every key of every entry one by one, which takes seconds on big books.
 * The result is a superset (case-insensitive substring); confirm with firingKey().
 */
export function keyScanner(entries, names = {}) {
    const byKey = new Map();   // lower-case key -> entries
    const regexEntries = [];   // entries with /regex/ keys are always candidates
    for (const e of entries) {
        for (const raw of e.key ?? []) {
            const k = subMacros(raw, names).trim();
            if (!k) continue;
            if (parseRegexKey(k)) { regexEntries.push(e); continue; }
            const lk = k.toLowerCase();
            if (!byKey.has(lk)) byKey.set(lk, []);
            byKey.get(lk).push(e);
        }
    }
    const keys = [...byKey.keys()].sort((a, b) => b.length - a.length);
    // the lookahead finds the longest key starting at each position; shorter keys hidden
    // inside it ("ken" in "ken kaneki") are added from this table
    const inside = new Map(keys.map(a => [a, keys.filter(b => b !== a && a.includes(b))]));
    const re = keys.length ? new RegExp(`(?=(${keys.map(escapeRegex).join('|')}))`, 'g') : null;
    return text => {
        const out = new Set(regexEntries);
        if (!re) return out;
        const seen = new Set();
        for (const m of lowered(String(text ?? '')).matchAll(re)) {
            const k = m[1];
            if (seen.has(k)) continue;
            seen.add(k);
            for (const e of byKey.get(k)) out.add(e);
            for (const sub of inside.get(k)) if (!seen.has(sub)) { seen.add(sub); for (const e of byKey.get(sub)) out.add(e); }
        }
        return out;
    };
}

export function subMacros(s, names = {}) {
    const t = String(s ?? '');
    if (!t.includes('{{') && !t.includes('<')) return t;
    return t
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
    const scanner = keyScanner(live.filter(e => !e.constant), names);
    let chunk = text;
    while (step < 30) {
        step++;
        const now = [];
        // only entries with a key in the newly added text can newly fire
        const cand = scanner(chunk);
        for (const e of live) {
            if (done.has(e)) continue;
            if (e.constant) {
                if (step === 1) now.push({ entry: e, key: null, step, via: 'constant' });
                continue;
            }
            if (!cand.has(e)) continue;
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
        chunk = more;
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
    const live = entries.filter(e => !e.disable && !isGlossary(e));
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
            id: 'messy', kind: 'safe', short: 'จัดรูปแบบคีย์', severity: 'low',
            fix: 'แยกคีย์ที่รวมอยู่ในช่องเดียว ตัดเครื่องหมายคำพูด และลบตัวซ้ำ',
            tradeoff: 'ไม่มีข้อเสีย คำที่ตั้งใจไว้ยังอยู่ครบ', title: `คีย์รูปแบบเพี้ยน ${changes.length} จุด`,
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
            id: 'dupes', kind: 'safe', short: 'รวมเอนทรีที่ซ้ำกัน', severity: 'mid',
            fix: 'รวมเนื้อหาของทั้งสองไว้ในเอนทรีที่ยาวกว่า และรวมคีย์ของทั้งสอง ตัวที่สั้นกว่าถูกลบ',
            tradeoff: 'เอนทรีที่รวมแล้วยาวขึ้น แต่ไม่ติดซ้ำ 2 ที่ และไม่มีข้อมูลขัดกัน ตรวจเฉพาะข้ามเล่ม ในเล่มเดียวกันคนเขียนมักตั้งใจแยกหัวข้อ', title: `เรื่องเดียวกันเขียนไว้ 2 ที่ ${changes.length} คู่`,
            why: 'คีย์ของทั้งสองตัวทับกัน พอพูดถึงเรื่องนี้จะติดทั้งคู่ กินโทเคน 2 เท่า และถ้าเนื้อหาไม่ตรงกัน โมเดลจะสับสน รวมเป็นเอนทรีเดียว: เอาเนื้อหามาต่อกันและรวมคีย์',
            changes,
        });
    }
    const dupOf = new Map();
    for (const [a, b] of dupPairs) { dupOf.set(a, b); dupOf.set(b, a); }

    // 3) keys that are in practically every message: the character's own name, {{user}}, or words in most entries
    const keyFreq = new Map(); // lower key -> number of OTHER entries whose content has it
    // which entries each content could trigger, found in one pass per content
    const scanAll = keyScanner(live, names);
    const reachOf = new Map(live.map(o => [o, scanAll(subMacros(o.content, names))]));
    {
        const changes = [];
        const always = [names.char, names.user, ...String(names.char ?? '').split(/\s+/)].filter(s => s && s.length > 1).map(s => s.toLowerCase());
        const minShare = Math.max(4, Math.ceil(live.length * 0.4));
        const hub = [];
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
                    // only contents that still recurse can pull this entry in
                    if (!keyFreq.has(lk)) keyFreq.set(lk, live.filter(o => o !== e && !o.preventRecursion && reachOf.get(o).has(e) && keyMatches(subMacros(o.content, names), k, opts)).length);
                    if (keyFreq.get(lk) >= minShare) reason = 'everywhere';
                }
                if (!reason) continue;
                const left = (e.key ?? []).filter(x => x !== k).length;
                if (reason === 'everywhere') {
                    hub.push(change({ op: 'removeKey', uid: e.uid, key: k, checked: false, label: `${nameOf(e)}: ลบคีย์ “${k}” (อยู่ในเนื้อหาของ ${keyFreq.get(lk)} เอนทรี)` }));
                    continue;
                }
                const why = reason === 'macro' ? 'ชื่อผู้เล่น/ตัวละครหลัก' : 'ชื่อตัวละครหลัก';
                changes.push(change({ op: 'removeKey', uid: e.uid, key: k, checked: left > 0, label: `${nameOf(e)}: ลบคีย์ “${k}” (${why})` }));
            }
        }
        if (hub.length) issues.push({
            id: 'hubkeys', kind: 'keys', short: 'ลบคีย์ที่อยู่ในเนื้อหาของเอนทรีอื่นจำนวนมาก', severity: 'low', title: `คีย์ที่อยู่ในเนื้อหาของเอนทรีอื่นจำนวนมาก ${hub.length} คีย์`,
            why: 'ชื่อพวกนี้ถูกพูดถึงในเนื้อหาของเอนทรีอื่นเป็นจำนวนมาก พอเปิด recursion อยู่ แค่เอนทรีไหนติด ก็ลากเอนทรีเจ้าของชื่อตามมาเกือบทุกครั้ง',
            fix: 'ลบคำนั้นออกจากคีย์',
            tradeoff: 'ไม่ติ๊กไว้ให้ เพราะทางแก้ที่ดีกว่าคือข้อ “ลูกโซ่ recursion” พอซ่อมข้อนั้นแล้ว ข้อนี้จะหายไปเอง ถ้าลบคีย์ที่เป็นชื่อหลักของเอนทรี แชทพูดถึงชื่อนั้นแล้วเอนทรีจะไม่ติด',
            changes: hub,
        });
        if (changes.length) issues.push({
            id: 'everywhere', kind: 'keys', short: 'ลบคีย์ที่เป็นชื่อตัวละครหลัก', severity: 'high', title: `คีย์เป็นชื่อตัวละครหลัก ${changes.length} คีย์`,
            why: 'ST ใส่ชื่อคนพูดไว้หน้าทุกข้อความ ชื่อตัวละครหลักและ {{user}} จึงอยู่ในแชททุกเทิร์น เอนทรีที่ใช้ชื่อพวกนี้เป็นคีย์จะติดตลอดเหมือนเป็น constant',
            fix: 'ลบชื่อนั้นออกจากคีย์ เอนทรีจะติดด้วยคีย์อื่นที่เหลือแทน',
            tradeoff: 'ข้อมูลของตัวละครหลักมักอยู่ในการ์ดอยู่แล้ว ถ้าอยากให้เอนทรีนี้อยู่ทุกเทิร์นจริง ๆ ให้เอาติ๊กออก แล้วตั้งเป็น “ติดตลอด” แทน',
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
            id: 'generic', kind: 'keys', short: 'ลบคีย์ที่เป็นคำทั่วไป', severity: 'mid',
            fix: 'ลบคำทั่วไปออกจากคีย์ เหลือชื่อเฉพาะไว้ให้ติด',
            tradeoff: 'ต้องพูดชื่อเฉพาะถึงจะติด เช่นลบ “Mom” ของ Dana แล้ว ต้องพูดว่า Dana ถึงจะติด คีย์ที่เป็นคีย์เดียวของเอนทรีจะไม่ติ๊กไว้ให้', title: `คีย์เป็นคำทั่วไป ${left.length} คีย์`,
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
            id: 'clash', kind: 'keys', short: 'ลบคีย์ที่ชนกับชื่ออื่น', severity: 'mid',
            fix: 'ลบคำเดียวที่ไปตรงกับชื่อของเอนทรีอื่นออกจากคีย์',
            tradeoff: 'ติ๊กไว้ให้เฉพาะนามสกุล ซึ่งในแชทไม่ค่อยเรียกเดี่ยว ๆ ชื่อต้น (เช่น “Malik”) ถ้าลบแล้ว ต้องพิมพ์ชื่อเต็มถึงจะติด ถ้าแชทเรียกชื่อต้นเป็นหลัก อย่าลบ', title: `คีย์ชนกับชื่อของเอนทรีอื่น ${changes.length} คีย์`,
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
            const cand = reachOf.get(e);
            const out = live.filter(o => o !== e && cand.has(o) && !o.constant && !o.excludeRecursion && firingKey(o, text, opts) !== null);
            if (out.length) links.set(e, out);
        }
        if (links.size) {
            const reach = (start) => {
                const seen = new Set([start]);
                const queue = [start];
                while (queue.length) for (const n of links.get(queue.shift()) ?? []) if (!seen.has(n)) { seen.add(n); queue.push(n); }
                return seen.size - 1;
            };
            // the full reach of every entry is slow on big books; the biggest chains start at the entries that link most
            const ranked = [...links.keys()].sort((a, b) => links.get(b).length - links.get(a).length).slice(0, 40)
                .map(e => ({ e, n: reach(e) })).sort((a, b) => b.n - a.n);
            const top = ranked[0];
            issues.push({
                id: 'recursion', kind: 'safe', short: 'ตัดลูกโซ่ recursion',
                fix: 'เปิด “Prevent further recursion” ให้เอนทรีที่ลากตัวอื่น เนื้อหาของมันจะไม่ถูกเอาไปหาคีย์ต่อ',
                tradeoff: 'เอนทรีจะติดเฉพาะตอนแชทพูดถึงจริง ไม่ถูกลากมาตามชื่อในเนื้อหาอื่น (แบบเดียวกับ JanitorAI) ข้อนี้ข้อเดียวแก้ระเบิดได้เกือบทั้งหมด ควรซ่อมก่อนข้ออื่น',
                severity: ctx.recursive === false ? 'mid' : 'high',
                title: `ลูกโซ่ recursion: ติด 1 เอนทรี ลากตามมาได้ถึง ${top.n} เอนทรี`,
                why: 'เนื้อหาของเอนทรีมีชื่อของเอนทรีอื่น พอเอนทรีหนึ่งติด ST จะเอาเนื้อหาไปสแกนต่อ แล้วดึงเอนทรีอื่นตามมาเป็นทอด ๆ JanitorAI ไม่มีระบบนี้ บอทที่ทำมาจากที่นั่นจึงไม่ได้เขียนเผื่อ' +
                    (ctx.recursive === false ? ' (ตอนนี้ ST ของเราปิด recursion อยู่ แต่คนที่เอาไปใช้ต่ออาจเปิดไว้)' : ''),
                examples: ranked.slice(0, 3).map(r => `${nameOf(r.e)} → ${links.get(r.e).slice(0, 4).map(nameOf).join(', ')}${links.get(r.e).length > 4 ? ` +${links.get(r.e).length - 4}` : ''} (รวมทอดต่อ ๆ ไป ${r.n})`),
                changes: [change({ op: 'setAll', field: 'preventRecursion', value: true, uids: [...links.keys()].map(e => e.uid), label: `เปิด Prevent further recursion ให้ ${links.size} เอนทรีที่ลากตัวอื่น` })],
            });
        }
    }

    // 7) too many always-on entries
    // Constants in one inclusion group are a random table (quotes, events, weather): SillyTavern
    // puts only one of them in each turn, so a group counts once, as its largest member, and is
    // never offered for "un-constant" (with no keys they would stop firing at all).
    {
        const consts = live.filter(e => e.constant);
        const solo = consts.filter(e => !groupsOf(e).length);
        const groups = new Set(consts.flatMap(e => groupsOf(e).slice(0, 1)));
        const { count, tokens } = turnSlots(consts);
        if (solo.length && (count > 3 || tokens > 1500)) {
            const sorted = [...solo].sort((a, b) => estTokens(a.content) - estTokens(b.content));
            const keepUid = sorted[0]?.uid;
            const inGroups = consts.length - solo.length;
            issues.push({
                id: 'constant', kind: 'safe', short: 'เลิกติดตลอด (constant)', severity: 'high',
                fix: 'เปลี่ยนเป็นติดเมื่อเจอคีย์',
                tradeoff: 'เรื่องนั้นจะเข้า prompt เฉพาะเทิร์นที่มีคนพูดถึง เก็บตัวที่เล็กที่สุดไว้ให้ 1 ตัว ตัวไหนต้องรู้ทุกเทิร์นจริง ๆ ให้เอาติ๊กออก',
                title: `ติดตลอด (constant) ${solo.length} เอนทรี${groups.size ? ` + กลุ่มสุ่ม ${groups.size} กลุ่ม` : ''} ≈ ${tokens.toLocaleString()} โทเคนทุกเทิร์น`,
                why: 'เอนทรี constant เข้า prompt ทุกเทิร์นโดยไม่ต้องเจอคีย์ ควรเหลือเฉพาะเรื่องที่ต้องรู้ตลอด เช่น ภาพรวมโลก ที่เหลือเปลี่ยนให้ติดเมื่อเจอคีย์' +
                    (inGroups ? ` (constant ${inGroups} เอนทรีที่อยู่ใน inclusion group นับกลุ่มละ 1 เพราะ ST สุ่มใส่แค่ตัวเดียวต่อเทิร์น จึงไม่อยู่ในรายการให้แก้)` : ''),
                changes: solo.map(e => change({
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
            id: 'nokeys', kind: 'safe', short: 'ใส่คีย์ให้เอนทรีที่ไม่มีคีย์', severity: 'mid',
            fix: 'ใช้ชื่อเอนทรีเป็นคีย์',
            tradeoff: 'ถ้าชื่อเอนทรีไม่ใช่คำที่แชทใช้จริง ให้ไปแก้คีย์เองในหน้าเล่มทีหลัง', title: `ไม่มีคีย์ ${changes.length} เอนทรี (ไม่มีวันติด)`,
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
            id: 'foreign', kind: 'safe', short: 'ลบคำสั่งของเว็บอื่น', severity: 'mid',
            fix: 'ลบบรรทัด @@ ของ RisuAI ส่วนคำสั่งอื่นต้องแก้เอง',
            tradeoff: 'ไม่มีข้อเสีย ST ไม่เข้าใจคำสั่งพวกนี้อยู่แล้ว', title: `คำสั่งของเว็บอื่นที่ ST ไม่รู้จัก ${changes.length + notes.length} จุด`,
            why: 'ST ไม่เข้าใจคำสั่งพวกนี้ จะส่งเข้า prompt ไปเป็นข้อความดิบ ๆ',
            changes, examples: notes.slice(0, 8),
        });
    }

    // 10) long entries (information only)
    {
        const big = live.filter(e => estTokens(e.content) > LONG_TOKENS).sort((a, b) => estTokens(b.content) - estTokens(a.content));
        if (big.length) issues.push({
            id: 'big', severity: 'low', title: `เอนทรียาวเกิน ${LONG_TOKENS} โทเคน ${big.length} ตัว`,
            why: 'ติดทีละไม่กี่ตัวก็กินงบหมดแล้ว ตัวอื่นที่สำคัญกว่าอาจถูกตัด ให้ AI ย่อได้: ตัดคำบรรยายฟุ่มเฟือย เก็บข้อเท็จจริงไว้ครบ ดูก่อนใช้ได้',
            uids: big.map(e => e.uid),
            examples: big.slice(0, 6).map(e => `${nameOf(e)} ≈ ${estTokens(e.content)}`), changes: [],
        });
    }

    // 11) entries without a Thai key
    {
        const without = live.filter(e => !e.constant && !(e.key ?? []).some(k => THAI.test(k)));
        if (without.length) issues.push({
            id: 'thai', severity: 'low', title: `ไม่มีคีย์ภาษาไทย ${without.length} เอนทรี`,
            why: 'ถ้าเล่นเป็นภาษาไทยและโมเดลเขียนชื่อเป็นภาษาไทย (เช่น “โคดี้” แทน “Cody”) คีย์ภาษาอังกฤษจะไม่ติด ให้ AI ช่วยคิดคีย์ไทยได้ แล้วเลือกเองว่าจะเพิ่มคีย์ไหน',
            uids: without.map(e => e.uid),
            changes: [],
        });
    }

    for (const i of issues) for (const c of i.changes) c.issue = i.id;
    // recommended order: what fixes the explosion without touching keys first, key edits after
    const ORDER = ['recursion', 'constant', 'dupes', 'messy', 'foreign', 'nokeys', 'everywhere', 'generic', 'clash', 'hubkeys', 'big', 'thai'];
    issues.sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id) || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
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
        else if (c.op === 'removeKey') {
            const left = (e.key ?? []).filter(k => k !== c.key);
            // several fixes together may remove every key of an entry: keep the last one so it can still fire
            if (!left.length && (e.key ?? []).length && !e.constant) { (out.keptKeys ??= []).push({ uid: e.uid, key: c.key, name: titleParts(e.comment)[0] || `#${e.uid}` }); continue; }
            e.key = left;
        }
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
    const result = out.filter(e => !removed.has(e.uid));
    result.keptKeys = out.keptKeys ?? [];
    return result;
}

/**
 * What the ticked changes do to each entry's keys, all fixes together.
 * @returns {Map<number, {before:string[], after:string[], kept:string|null}>}
 */
export function keyPlan(entries, changes) {
    const by = new Map(entries.map(e => [e.uid, e]));
    const plan = new Map();
    const get = uid => {
        if (!plan.has(uid)) { const e = by.get(uid); plan.set(uid, { before: [...(e?.key ?? [])], after: [...(e?.key ?? [])], kept: null, constant: !!e?.constant }); }
        return plan.get(uid);
    };
    for (const c of changes) if (c.checked && c.op === 'set' && c.field === 'key') get(c.uid).after = [...c.value];
    for (const c of changes) {
        if (!c.checked || c.op !== 'removeKey' || !by.has(c.uid)) continue;
        const p = get(c.uid);
        const left = p.after.filter(k => k !== c.key);
        if (!left.length && p.after.length && !p.constant) { p.kept = c.key; continue; }
        p.after = left;
    }
    return plan;
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
    if (estTokens(e.content) > LONG_TOKENS) out.push(`ยาว ≈${estTokens(e.content)} โทเคน`);
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

// ---------------------------------------------------------------- AI: Thai keys

/** Strip ```json fences / <think> blocks and parse the first JSON object in a model reply. */
export function parseJsonLoose(text) {
    let t = String(text ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?/gi, '');
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('คำตอบไม่มี JSON');
    t = t.slice(a, b + 1);
    try { return JSON.parse(t); } catch {
        // common slips: trailing commas, smart quotes
        return JSON.parse(t.replace(/,\s*([}\]])/g, '$1').replace(/[“”]/g, '"'));
    }
}

export const NAME_SYSTEM = `You turn names from a roleplay lorebook into Thai keywords. A lorebook entry is inserted into the prompt when one of its keywords appears in the chat; the chat is written in Thai, so the Thai spellings matter.

Input: one name per line as "<id>. <name>", optionally followed by "  (in: <entry title>)" and a "context:" line.

Return ONLY JSON in this shape:
{"names":[{"id":0,"lang":"de","translit":["..."],"english":["..."],"translated":["..."],"nick":["..."]}]}

- lang: ISO 639-1 code of the language the name comes from (en, ja, de, fr, it, es, ru, zh, ko, …). Judge from the name itself, not from the language of the text.
- translit: the Thai transliteration of how the name is pronounced in its origin language, following the Royal Institute of Thailand's rules for that language. If a famous name has a different spelling that is far more common in Thai, put that first. At most 2. Keep one space between the words of a multi-word name, word for word ("Marc Ellis" → "มาร์ก เอลลิส").
- english: the Thai spelling of the English pronunciation, only when it differs from translit (Michelangelo → translit ["มีเกลันเจโล"], english ["ไมเคิล แองเจโล"]). Otherwise [].
- translated: for descriptive names of places, organizations, teams, items and titles, the Thai translation ("Halpern Library" → "ห้องสมุดฮาลเพิร์น"). [] for people.
- nick: only when a context line is given: Thai nicknames or ways others address them that appear in the context. Otherwise [].
- Never output a lone ordinary Thai word of one or two syllables (ยา, หมี, ทีม); Thai has no spaces, so it would match inside other words.
- Every id must appear exactly once. No explanations, no markdown.`;

export const LANG_LABEL = { en: 'อังกฤษ', ja: 'ญี่ปุ่น', de: 'เยอรมัน', fr: 'ฝรั่งเศส', it: 'อิตาลี', es: 'สเปน', pt: 'โปรตุเกส', ru: 'รัสเซีย', zh: 'จีน', ko: 'เกาหลี', nl: 'ดัตช์', ar: 'อาหรับ', la: 'ละติน', el: 'กรีก', sv: 'สวีเดน', pl: 'โปแลนด์', th: 'ไทย' };

/**
 * The proper names of an entry worth turning into Thai: the subject in its title, and
 * Title-Case keys ("Garrick Voss", "Weld"). Descriptive lower-case keys, numbers, acronyms
 * and common words are skipped (they are not names, or Thai writers keep them in Latin).
 */
export function properNames(entry, { max = 6 } = {}) {
    const out = [];
    const seen = new Set();
    const add = n => {
        const t = String(n ?? '').trim();
        const k = t.toLowerCase();
        if (!t || seen.has(k) || THAI.test(t) || !/[A-Za-z]/.test(t) || parseRegexKey(t)) return;
        if (/^#?\d+$/.test(t) || /^[A-Z0-9]{2,5}$/.test(t)) return;           // numbers, acronyms
        const words = t.split(/\s+/);
        if (!words.every(w => /^[A-Z0-9(]/.test(w) || /^(of|the|de|von|van|da|di|del|la|le|du|and|&|-)$/i.test(w))) return; // not a name
        if (words.length === 1 && COMMON_WORDS.has(k)) return;
        seen.add(k);
        out.push(t);
    };
    // the title only counts when it is also a key ("Weld"), or the entry has no Latin key at all:
    // titles are often topics ("Season Structure") or carry a role ("Head Coach Raymond Hale")
    const title = titleParts(String(entry.comment ?? '').replace(/^\[[^\]]*\]\s*/, ''))[0] ?? '';
    const keys = (entry.key ?? []).map(k => String(k).trim());
    const latinKeys = keys.filter(k => /[A-Za-z]/.test(k) && !THAI.test(k));
    if (!latinKeys.length || latinKeys.some(k => k.toLowerCase() === title.toLowerCase())) add(title);
    for (const k of keys) add(k);
    return out.slice(0, max);
}

/**
 * Unique names across entries (asked once even if three entries share them). A one-word name
 * that is a word of a longer name of the same entry ("Marc" next to "Marc Ellis") is not asked:
 * its Thai is taken from the longer name's answer (see deriveNames), which saves a lot of names.
 * @returns {{ names: {id:number, name:string, lower:string, ctx:string}[], byEntry: Map<number, string[]>, derived: Map<string, {from:string, index:number}> }}
 */
export function collectNames(entries) {
    const per = entries.map(e => ({ e, own: properNames(e) }));
    const derived = new Map();
    const standalone = new Set();
    for (const { own } of per) {
        const multi = own.filter(n => /\s/.test(n)).map(n => ({ lower: n.toLowerCase(), words: n.toLowerCase().split(/\s+/) }));
        for (const n of own) {
            const lower = n.toLowerCase();
            if (/\s/.test(n)) continue;
            const parent = multi.find(m => m.words.includes(lower));
            if (parent) { if (!derived.has(lower)) derived.set(lower, { from: parent.lower, index: parent.words.indexOf(lower) }); }
            else standalone.add(lower);
        }
    }
    for (const n of standalone) derived.delete(n); // also used on its own somewhere: ask it
    const names = [];
    const index = new Map();
    const byEntry = new Map();
    for (const { e, own } of per) {
        byEntry.set(e.uid, own.map(n => n.toLowerCase()));
        for (const n of own) {
            const lower = n.toLowerCase();
            if (index.has(lower) || derived.has(lower)) continue;
            index.set(lower, names.length);
            names.push({ id: names.length, name: n, lower, ctx: titleParts(String(e.comment ?? '').replace(/^\[[^\]]*\]\s*/, ''))[0] ?? '' });
        }
    }
    return { names, byEntry, derived };
}

/** Fill in one-word names from the answer for the longer name they belong to ("มาร์ก เอลลิส" → "มาร์ก"). */
export function deriveNames(results, derived) {
    for (const [lower, { from, index }] of derived) {
        if (results.has(lower)) continue;
        const p = results.get(from);
        if (!p) continue;
        const words = from.split(/\s+/).length;
        const part = list => list.map(t => t.split(/\s+/)).filter(w => w.length === words).map(w => w[index]).filter(t => THAI.test(t) && [...t].length > 1);
        const rec = { lang: p.lang, translit: [...new Set(part(p.translit))], english: [...new Set(part(p.english))].filter(t => !part(p.translit).includes(t)), translated: [], nick: [] };
        if (rec.translit.length || rec.english.length) results.set(lower, rec);
    }
    return results;
}

/** The user message: one name per line, with the entry it comes from; `context` adds a content excerpt. */
export function nameRequest(list, { context = '' } = {}) {
    const lines = list.map((n, i) => `${i}. ${n.name}${n.ctx && n.ctx.toLowerCase() !== n.lower ? `  (in: ${n.ctx})` : ''}`);
    if (context) lines.push(`context: ${String(context).replace(/\s+/g, ' ').slice(0, 700)}`);
    return lines.join('\n');
}

/**
 * The model's answer → Map lower-case name → { lang, translit, english, translated, nick }.
 * Ids are positions in `list`. Only Thai strings are kept.
 */
export function parseNameReply(text, list) {
    const json = parseJsonLoose(text);
    const rows = Array.isArray(json) ? json : json.names;
    if (!Array.isArray(rows)) throw new Error('คำตอบไม่มีรายการ names');
    const out = new Map();
    for (const r of rows) {
        const n = list[Number(r?.id)];
        if (!n) continue;
        const pick = arr => cleanKeys(Array.isArray(arr) ? arr : typeof arr === 'string' ? [arr] : []).filter(k => THAI.test(k));
        const rec = { lang: String(r.lang ?? '').toLowerCase().slice(0, 5), translit: pick(r.translit), english: pick(r.english), translated: pick(r.translated), nick: pick(r.nick) };
        rec.english = rec.english.filter(k => !rec.translit.includes(k));
        if (rec.translit.length + rec.english.length + rec.translated.length + rec.nick.length) out.set(n.lower, rec);
    }
    return out;
}

/**
 * What to offer for one entry, from the answers for its names: origin-language spellings,
 * English-style spellings, nicknames, translations — minus keys it already has.
 */
export function entrySuggestions(entry, nameLowers, results) {
    const have = new Set((entry.key ?? []).map(k => String(k).toLowerCase()));
    const seen = new Set();
    const take = list => list.filter(k => !have.has(k.toLowerCase()) && !seen.has(k) && seen.add(k));
    const recs = nameLowers.map(n => results.get(n)).filter(Boolean);
    const langs = [...new Set(recs.map(r => r.lang).filter(Boolean))];
    return {
        langs,
        origin: take(recs.flatMap(r => r.translit)),
        english: take(recs.flatMap(r => r.english)),
        nick: take(recs.flatMap(r => r.nick ?? [])),
        translated: take(recs.flatMap(r => r.translated)),
    };
}

/** Put `key` first among the Thai keys (the glossary uses the first Thai key as the spelling). */
export function preferThaiKey(keys, key) {
    const list = cleanKeys([...(keys ?? []), key]);
    const rest = list.filter(k => k !== key);
    const firstThai = rest.findIndex(k => THAI.test(k));
    if (firstThai < 0) return [...rest, key];
    rest.splice(firstThai, 0, key);
    return rest;
}

/**
 * Problems with a proposed Thai key. Thai has no spaces, so a key also matches inside any
 * longer key of another entry ("มาร์ค" fires on "มาร์คัส").
 */
export function vetThaiKey(key, entry, entries, ctx = {}) {
    const out = keyWarnings(key, ctx).filter(w => w.level !== 'info');
    const k = String(key).toLowerCase();
    const clash = [];
    for (const o of entries) {
        if (o === entry || o.uid === entry.uid || isGlossary(o)) continue;
        for (const ok of o.key ?? []) {
            const lo = String(ok).toLowerCase();
            if (!THAI.test(lo)) continue;
            if (lo === k || lo.includes(k)) { clash.push(titleParts(o.comment)[0] || `#${o.uid}`); break; }
        }
    }
    if (clash.length) out.push({ level: 'warn', text: `ไปติดตอนพูดถึง ${[...new Set(clash)].slice(0, 3).join(', ')} ด้วย` });
    return out;
}

// ---------------------------------------------------------------- glossary of names

export const GLOSSARY_FLAG = 'loremaster_glossary';
export const GLOSSARY_TITLE = '📖 อภิธานชื่อ (Lore Master)';
export const GLOSSARY_HEAD = 'ชื่อเฉพาะในเรื่องนี้ เวลาเขียนภาษาไทยให้สะกดตามนี้เสมอ:';
export function isGlossary(e) { return !!e?.extensions?.[GLOSSARY_FLAG]; }

/** "English name = Thai spelling" for every entry that has a Thai key. */
export function glossaryLines(entries) {
    const out = [];
    const seen = new Set();
    for (const e of entries) {
        if (isGlossary(e) || e.disable) continue;
        const th = (e.key ?? []).find(k => THAI.test(k) && !parseRegexKey(k));
        if (!th) continue;
        const title = titleParts(String(e.comment ?? '').replace(/^\[[^\]]*\]\s*/, '')).find(p => /[A-Za-z]/.test(p) && !THAI.test(p));
        const en = (title || (e.key ?? []).find(k => /[A-Za-z]/.test(k) && !parseRegexKey(k)) || '').trim();
        if (!en || seen.has(en.toLowerCase())) continue;
        seen.add(en.toLowerCase());
        out.push({ en, th });
    }
    return out;
}
export const glossaryContent = lines => `${GLOSSARY_HEAD}\n${lines.map(l => `- ${l.en} = ${l.th}`).join('\n')}`;
export function parseGlossary(content) {
    const out = [];
    for (const line of String(content ?? '').split('\n')) {
        if (line.startsWith(GLOSSARY_HEAD)) continue;
        const m = /^\s*[-•*]?\s*(.+?)\s*=\s*(.+?)\s*$/.exec(line);
        if (m) out.push({ en: m[1], th: m[2] });
    }
    return out;
}
/** Fields of the glossary entry (merged into an existing one, or a new one). */
export function glossaryEntryFields(lines) {
    return {
        comment: GLOSSARY_TITLE, content: glossaryContent(lines), key: [], keysecondary: [],
        constant: true, disable: false, position: POSITION.before, order: 999,
        preventRecursion: true, excludeRecursion: true, ignoreBudget: false,
    };
}
/** Add or refresh the glossary entry in a list of entries (returns a new list). */
export function upsertGlossaryList(entries, template = ENTRY_DEFAULTS) {
    const lines = glossaryLines(entries);
    const out = structuredClone(entries);
    const i = out.findIndex(isGlossary);
    if (!lines.length) return i >= 0 ? out.filter((_, j) => j !== i) : out;
    if (i >= 0) { Object.assign(out[i], glossaryEntryFields(lines)); return out; }
    const uid = out.reduce((m, e) => Math.max(m, Number(e.uid) || 0), -1) + 1;
    out.push({ ...structuredClone(template), uid, displayIndex: out.length, ...glossaryEntryFields(lines), extensions: { [GLOSSARY_FLAG]: true } });
    return out;
}

/** Which glossary lines matter this turn: names in the recent chat, or of entries that fired. */
export function pickGlossary(lines, { text = '', activated = [] } = {}) {
    const hay = String(text).toLowerCase();
    const fired = activated.map(e => [e.comment, ...(e.key ?? [])].join('\n').toLowerCase());
    return lines.filter(l => {
        const en = l.en.toLowerCase(), th = l.th.toLowerCase();
        // a given name on its own ("Cody" for "Cody Dawson"), but not "The" of "The Rail Crew"
        const first = en.split(/\s+/)[0];
        const useFirst = first.length > 2 && !COMMON_WORDS.has(first) && /^[A-Z]/.test(l.en);
        return hay.includes(en) || hay.includes(th) || (useFirst && new RegExp(`(?:^|\\W)${escapeRegex(first)}(?:$|\\W)`).test(hay))
            || fired.some(f => f.includes(en) || f.includes(th));
    });
}

// ---------------------------------------------------------------- AI: condense long entries

export const CONDENSE_SYSTEM = `You shorten lorebook entries for roleplay. Rewrite the entry so it is much shorter but keeps every fact the story needs: names, ages, roles, relationships, appearance details, abilities and limits, rules, secrets, history that matters, and how characters treat each other.
Remove flowery narration, jokes, rhetorical asides, repetition and filler words. Use terse bullet points under short headings (keep the original headings if there are any).
Keep the original language — do not translate. Keep macros such as {{char}} and {{user}} exactly as written.
Output only the rewritten entry, nothing else.`;
export function condenseRequest(entry, ratio = 0.5) {
    const target = Math.max(40, Math.round(estTokens(entry.content) * ratio));
    return `Target length: about ${target} tokens (${Math.round(ratio * 100)}% of the original).\nEntry title: ${entry.comment || '(none)'}\n\n<entry>\n${entry.content}\n</entry>`;
}
/** Clean the model's rewrite; null if it is unusable. */
export function cleanCondensed(text, original) {
    const t = String(text ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^```\w*\n?|```$/gm, '').replace(/<\/?entry>/gi, '').trim();
    if (!t) return null;
    // longer than the original, or a tiny stub: not a usable rewrite
    if (estTokens(t) >= estTokens(original) * 0.95 || estTokens(t) < Math.min(20, estTokens(original) * 0.1)) return null;
    for (const m of ['{{char}}', '{{user}}']) if (String(original).includes(m) && !t.includes(m)) return null;
    return t;
}

// ---------------------------------------------------------------- AI: translate entries into English

/**
 * Scripts other than Latin that a lorebook may be written in. The weight makes one CJK / Hangul
 * character count like a few Latin letters, so "Kim (김민준)" in an English entry stays English.
 */
const SCRIPTS = [
    ['ko', /[ᄀ-ᇿ㄰-㆏가-힯]/g, 2.5],
    ['ja', /[぀-ヿㇰ-ㇿ]/g, 2.5],
    ['zh', /[㐀-䶿一-鿿]/g, 2.5],
    ['ru', /[Ѐ-ӿ]/g, 1],
    ['el', /[Ͱ-Ͽ]/g, 1],
    ['ar', /[؀-ۿ]/g, 1],
    ['th', /[฀-๿]/g, 1],
];
const LATIN = /[A-Za-zÀ-ɏ]/g;
/** An entry is "written in" another language when that script is at least this share of its letters. */
export const FOREIGN_SHARE = 0.3;

/** The main non-Latin script of a text: { lang, share } (share of the weighted letters), or null. */
export function textLanguage(text) {
    const s = String(text ?? '');
    const n = {};
    for (const [lang, re] of SCRIPTS) n[lang] = (s.match(re) ?? []).length;
    // Japanese mixes kanji with kana: kanji count as Japanese when there is any kana
    if (n.ja) { n.ja += n.zh; n.zh = 0; }
    let best = null, total = (s.match(LATIN) ?? []).length;
    for (const [lang, , w] of SCRIPTS) {
        total += n[lang] * w;
        if (n[lang] >= 2 && (!best || n[lang] * w > best.w)) best = { lang, w: n[lang] * w };
    }
    return best ? { lang: best.lang, share: best.w / total } : null;
}
/** The language an entry is written in (title, keys and content together), or null for English/Latin. */
export function entryLanguage(e) {
    return textLanguage([e.comment, ...(e.key ?? []), ...(e.keysecondary ?? []), e.content].join('\n'));
}
/** Should the "translate" picker tick this entry for the user? (Thai books are left to the user.) */
export const wantsTranslation = e => { const l = entryLanguage(e); return !!l && l.lang !== 'th' && l.share >= FOREIGN_SHARE; };
/** Written in a script other than Latin or Thai (Thai keys are for the chat, so they always stay). */
const hasForeignScript = s => SCRIPTS.some(([lang, re]) => lang !== 'th' && new RegExp(re.source).test(s));

export const TRANSLATE_SYSTEM = `You translate lorebook (World Info) entries for a roleplay into natural, fluent English.
Translate everything that is not English: the title, every keyword and the content. Keep the meaning and every detail: do not shorten, summarize, add or explain anything.
Keep the layout: headings, bullet points, line breaks, brackets, and formats such as "Name: value" or W++ lists. Keep words that are already English as they are.
Keep macros such as {{char}} and {{user}} exactly as written.
Names of people, places and groups: romanize them the usual way for their language (Korean: Revised Romanization, family name first and the given name as one word, e.g. 김민준 → Kim Minjun; Japanese: Hepburn) unless the entry itself or the list of known names gives a spelling. Spell each name the same way every time. Names made of ordinary words may be translated (a café called 달빛 → Moonlight Café).
Keywords are what the chat is scanned for, so each one must be a word or name someone would actually write in English: one keyword per line.
Keep any thinking brief. Answer in exactly this format and nothing else:
<title>translated title</title>
<keys>
one keyword per line
</keys>
<secondary>
one keyword per line (leave empty when there are none)
</secondary>
<names>
original = English, one per line, for every name of a person, place or group in this entry
</names>
<content>
the translated content
</content>`;

/** Known spellings (original -> English) that matter for this entry. */
export function namesFor(entry, known, max = 60) {
    const text = [entry.comment, ...(entry.key ?? []), ...(entry.keysecondary ?? []), entry.content].join('\n');
    const out = [];
    for (const [orig, en] of known ?? []) {
        if (out.length >= max) break;
        if (orig && text.includes(orig)) out.push([orig, en]);
    }
    return out;
}
export function translateRequest(entry, known = []) {
    const plain = list => (list ?? []).filter(k => !parseRegexKey(String(k).trim()));
    const keys = plain(entry.key), sec = plain(entry.keysecondary);
    const names = namesFor(entry, known);
    return [
        names.length ? `Known names (use these spellings):\n${names.map(([o, e]) => `${o} = ${e}`).join('\n')}\n` : '',
        `Title: ${entry.comment || '(none)'}`,
        `Keywords:\n${keys.length ? keys.join('\n') : '(none)'}`,
        `Secondary keywords:\n${sec.length ? sec.join('\n') : '(none)'}`,
        '',
        `<entry>\n${entry.content ?? ''}\n</entry>`,
    ].filter(x => x !== '').join('\n');
}
/** Room for the answer: English runs about one token per CJK/Hangul character, plus room to think. */
export const translateBudget = entry => Math.max(4000, Math.round(String([entry.comment, ...(entry.key ?? []), entry.content].join(' ')).length * 1.3) + 2000);

/**
 * Read the model's translation. Throws (in Thai, for the progress card) when it is unusable,
 * so ask() moves on to the next API.
 * @returns {{comment:string, key:string[], keysecondary:string[], content:string, names:[string,string][]}}
 */
export function parseTranslation(text, entry) {
    const t = String(text ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^```\w*[ \t]*$/gm, '');
    const tag = name => { const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i').exec(t); return m ? m[1].trim() : null; };
    const lines = s => String(s ?? '').split('\n').map(x => x.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim()).filter(x => x && !/^\(?none\)?$/i.test(x));
    const orig = String(entry.content ?? '');
    let content = tag('content');
    if (content === null) {
        if (orig.trim()) throw new Error(/<content>/i.test(t) ? 'คำตอบถูกตัดกลางทาง (ไม่ครบ)' : 'คำตอบไม่ตรงรูปแบบ');
        content = '';
    }
    content = content.replace(/^<entry>\s*|\s*<\/entry>$/gi, '').trim();
    if (orig.trim() && !content) throw new Error('ได้เนื้อหาว่าง');
    for (const m of new Set(orig.match(/\{\{\w+\}\}/g) ?? [])) if (!content.toLowerCase().includes(m.toLowerCase())) throw new Error(`มาโคร ${m} หายไป`);
    const from = entryLanguage(entry);
    if (from && from.lang !== 'th' && orig.trim()) {
        const left = textLanguage(content);
        if (left?.lang === from.lang && left.share > 0.2) throw new Error('ยังแปลไม่หมด');
        // English is never much shorter than Korean / Japanese / Chinese for the same text
        if (content.length < orig.length * 0.4) throw new Error('สั้นกว่าต้นฉบับมาก อาจแปลไม่ครบ');
    }
    const key = cleanKeys(lines(tag('keys')));
    const plainKeys = (entry.key ?? []).filter(k => !parseRegexKey(String(k).trim()));
    if (plainKeys.length && !key.length) throw new Error('ไม่ได้คีย์กลับมา');
    const names = [];
    for (const l of lines(tag('names'))) {
        const m = /^(.+?)\s*(?:=|→|->)\s*(.+)$/.exec(l);
        if (m && hasForeignScript(m[1]) && !hasForeignScript(m[2])) names.push([m[1].trim(), m[2].trim()]);
    }
    const title = tag('title');
    return { comment: title && !/^\(?none\)?$/i.test(title) ? title : entry.comment || '', key, keysecondary: cleanKeys(lines(tag('secondary'))), content, names };
}

/**
 * The entry with a translation applied. English keys come first; regex keys and keys already in
 * Latin script stay. Original-language primary keys stay only with `keepKeys`. Secondary keys in
 * the old language always go: with "must have all of them" logic, mixing two languages would
 * stop the entry from ever firing.
 */
export function applyTranslation(entry, tr, { keepKeys = false } = {}) {
    const stay = k => parseRegexKey(String(k).trim()) || !hasForeignScript(String(k));
    const oldKeys = (entry.key ?? []).filter(k => keepKeys || stay(k));
    const oldSec = (entry.keysecondary ?? []).filter(stay);
    return {
        ...entry,
        comment: tr.comment,
        content: tr.content,
        key: cleanKeys([...tr.key, ...oldKeys]),
        keysecondary: (entry.keysecondary ?? []).length ? cleanKeys([...tr.keysecondary, ...oldSec]) : (entry.keysecondary ?? []),
    };
}

// ---------------------------------------------------------------- character card PNG

/** The character card JSON inside a PNG (tEXt chunk "ccv3", else "chara"), or null. */
export function cardFromPng(buffer) {
    const b = new Uint8Array(buffer);
    const sig = [137, 80, 78, 71, 13, 10, 26, 10];
    if (b.length < 8 || sig.some((v, i) => b[i] !== v)) return null;
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const found = {};
    for (let i = 8; i + 8 <= b.length;) {
        const len = view.getUint32(i);
        const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
        if (type === 'tEXt') {
            const body = b.subarray(i + 8, i + 8 + len);
            const z = body.indexOf(0);
            const key = new TextDecoder('latin1').decode(body.subarray(0, z)).toLowerCase();
            if (key === 'ccv3' || key === 'chara') found[key] = new TextDecoder('latin1').decode(body.subarray(z + 1));
        }
        if (type === 'IEND') break;
        i += 12 + len;
    }
    const b64 = found.ccv3 ?? found.chara;
    if (!b64) return null;
    const bin = atob(b64.trim());
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return JSON.parse(new TextDecoder('utf-8').decode(bytes));
}

// ---------------------------------------------------------------- emergency brake (runtime)

/**
 * How likely an entry is to really fire once it is picked. SillyTavern rolls the entry's
 * `probability` (when "useProbability" is on) after the keys matched (constants roll too),
 * so a 30% entry is in the prompt about a third of the time. 1 = always.
 */
export function fireChance(e) {
    if (!e || e.useProbability === false) return 1;
    const p = Number(e.probability);
    if (!Number.isFinite(p)) return 1;
    return Math.min(1, Math.max(0, p / 100));
}

/** The inclusion groups of an entry ("a, b" = two groups). */
export const groupsOf = e => String(e?.group ?? '').split(',').map(g => g.trim()).filter(Boolean);

/**
 * Is the entry still held back by its `delay` (it only fires once the chat has that many
 * messages)? `chatLength` unknown (not a number) = not delayed.
 */
export function delayed(e, chatLength) {
    const d = Number(e?.delay);
    return typeof chatLength === 'number' && Number.isFinite(d) && d > 0 && chatLength < d;
}

/**
 * What a set of entries that all match is worth in the prompt on average: probability entries
 * count by their chance, and entries in the same inclusion group count as one entry between
 * them, constants included (SillyTavern keeps only one per group: a book of 300 constant
 * quotes in one group puts 1 quote in the prompt, not 300). Groups in `taken` already have an
 * entry in the prompt from an earlier loop, so SillyTavern adds no more of them: weight 0.
 * Returns { n, tokens, weight } — n and tokens are sums of weight × (1 | tokens), weight(e) is
 * the weight of one entry (0..1).
 * @param {any[]} list
 * @param {{ taken?: Set<string> | null }} [opts]
 */
export function expectedLoad(list, { taken = null } = {}) {
    const chance = new Map();
    const groups = new Map();
    for (const e of list) {
        chance.set(e, fireChance(e));
        for (const g of groupsOf(e)) groups.set(g, (groups.get(g) ?? 0) + chance.get(e));
    }
    const w = new Map();
    for (const e of list) {
        let scale = 1;
        for (const g of groupsOf(e)) scale = taken?.has(g) ? 0 : Math.min(scale, 1 / Math.max(1, groups.get(g)));
        w.set(e, chance.get(e) * scale);
    }
    let n = 0, tokens = 0;
    for (const e of list) { const x = w.get(e); n += x; tokens += x * estTokens(e.content); }
    return { n, tokens, weight: e => w.get(e) ?? 1 };
}

/**
 * How much of the prompt a set of entries can take in one turn if all of them are picked:
 * entries of one inclusion group count once, as their largest member.
 * @returns {{ count: number, tokens: number }}
 */
export function turnSlots(list) {
    let count = 0, tokens = 0;
    const groups = new Map();
    for (const e of list) {
        const g = groupsOf(e)[0];
        const t = estTokens(e.content);
        if (!g) { count++; tokens += t; continue; }
        groups.set(g, Math.max(groups.get(g) ?? 0, t));
    }
    for (const t of groups.values()) { count++; tokens += t; }
    return { count, tokens };
}

/**
 * Keep entries in priority order until either limit is reached. Constant entries are always
 * kept (they are part of the book's design and usually small); the rest are dropped.
 * `weight` (optional, entry → 0..1) counts an entry as that fraction of itself, for entries that
 * only fire some of the time (see expectedLoad), constants too; without it every entry counts in full.
 * @param {any[]} list entries in priority order (most important first)
 * @param {{maxEntries:number, maxTokens:number}} limits
 * @param {(e:any)=>number} [weight]
 */
export function trimToLimits(list, { maxEntries, maxTokens }, weight = null) {
    const keep = [], drop = [];
    let n = 0, tokens = 0;
    const w = e => (weight ? weight(e) : 1);
    for (const e of list) if (e.constant) { keep.push(e); n += w(e); tokens += estTokens(e.content) * w(e); }
    for (const e of list) {
        if (e.constant) continue;
        const x = w(e);
        const t = estTokens(e.content) * x;
        if (n + x > maxEntries + 1e-9 || tokens + t > maxTokens + 1e-9) { drop.push(e); continue; }
        keep.push(e); n += x; tokens += t;
    }
    return { keep, drop, tokens };
}

/** SillyTavern's own priority: higher `order` first. */
export const byPriority = (a, b) => (Number(b.order) || 0) - (Number(a.order) || 0);

/**
 * Entries that would fire on `text` (first scan: chat), using the one-pass scanner.
 * Probability, groups, sticky and cooldown are ignored (worst case); `delay` is honoured when
 * `chatLength` is given, and "delay until recursion" entries only fire in recursion.
 */
export function wouldFire(entries, text, { names = {}, caseSensitive = false, wholeWords = false, scanner = null, skip = null, recursion = false, chatLength = null } = {}) {
    const scan = scanner ?? keyScanner(entries.filter(e => !e.constant && !e.disable), names);
    const cand = scan(text);
    const opts = { names, caseSensitive, wholeWords };
    const out = [];
    for (const e of entries) {
        if (e.disable || e.constant || !cand.has(e) || skip?.has(e)) continue;
        if (recursion && e.excludeRecursion) continue;
        if (!recursion && e.delayUntilRecursion) continue;
        if (delayed(e, chatLength)) continue;
        if (firingKey(e, text, opts) !== null) out.push(e);
    }
    return out;
}

// ================================================================ entry point looks
//
// How the floating button, the top-bar icon and the menu items look. Stored in the extension's
// settings; these only describe and clean a look, look.js draws it.

export const LAUNCH_SHAPES = ['rounded', 'circle', 'bubble', 'pill', 'hexagon', 'shield', 'heart', 'flower', 'star', 'cloud', 'sticker'];
export const LAUNCH_BGS = ['gradient', 'glass', 'accent', 'custom', 'custom2', 'none'];
export const LAUNCH_FGS = ['auto', 'theme', 'custom'];
export const LAUNCH_ANIMS = ['none', 'float', 'sway', 'pulse', 'spin', 'glow', 'shimmer', 'alert'];

/** The floating button. The defaults draw it exactly as before it could be styled. */
export const LAUNCH_DEFAULT = Object.freeze({
    shape: 'rounded',
    icon: 'fa-book-atlas',
    emoji: '',          // overrides the icon
    image: '',          // data: URL or https link; overrides icon and emoji
    fit: 'cover',       // cover | contain
    size: 48,           // px
    iconSize: 44,       // % of the button
    bg: 'gradient',     // see LAUNCH_BGS
    bgColor: '#7a4bd6',
    bgColor2: '#e18a24',
    fg: 'auto',         // auto: white on colour, theme colour on glass / none
    fgColor: '#ffffff',
    border: false,
    shadow: true,
    anim: 'none',
    opacity: 88,        // % while not touched
    label: 'Lore',      // pill only
    badge: true,        // red dot when the emergency brake stepped in
});

/** The icon in ST's top bar. */
export const TOP_DEFAULT = Object.freeze({
    icon: 'fa-book-bookmark',
    emoji: '',
    image: '',
    size: 0,            // px; 0 = the theme's own size
    color: 'theme',     // theme | custom
    colorHex: '#e18a24',
    opacity: 100,
    badge: true,
});

/** The wand menu item and the small button inside ST's World Info panel. */
export const MENU_DEFAULT = Object.freeze({
    icon: 'fa-book-atlas',
    emoji: '',
    label: 'Lore Master',  // wand menu only
    color: 'theme',        // theme | custom
    colorHex: '#e18a24',
    wiIcon: 'fa-book-bookmark',
    wiEmoji: '',
});

const LOOK_HEX = /^#[0-9a-f]{6}$/i;
const lookNum = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d; };
const lookOneOf = (v, list, d) => (list.includes(v) ? v : d);
const lookFa = (v, d) => (typeof v === 'string' && /^fa-[a-z0-9-]+$/.test(v) ? v : d);
const lookHex = (v, d) => (typeof v === 'string' && LOOK_HEX.test(v) ? v.toLowerCase() : d);
/** The emoji field, at most 8 characters (one ZWJ emoji, or a few simple ones). */
export const cleanEmoji = v => Array.from(String(v ?? '').trim()).slice(0, 8).join('');
/** A picture for a button: a data:image URL or an http(s) link, nothing else (no javascript:, no CSS breakouts). */
export function cleanImage(v) {
    const s = String(v ?? '').trim();
    if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml|avif);base64,[a-z0-9+/=\s]+$/i.test(s)) return s;
    if (/^https?:\/\/[^\s"'<>()\\]+$/i.test(s)) return s;
    return '';
}

/** A complete, safe floating-button look from whatever is stored (missing / broken fields fall back). */
export function normLaunchLook(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const d = LAUNCH_DEFAULT;
    return {
        shape: lookOneOf(r.shape, LAUNCH_SHAPES, d.shape),
        icon: lookFa(r.icon, d.icon),
        emoji: cleanEmoji(r.emoji),
        image: cleanImage(r.image),
        fit: lookOneOf(r.fit, ['cover', 'contain'], d.fit),
        size: lookNum(r.size, 28, 140, d.size),
        iconSize: lookNum(r.iconSize, 20, 100, d.iconSize),
        bg: lookOneOf(r.bg, LAUNCH_BGS, d.bg),
        bgColor: lookHex(r.bgColor, d.bgColor),
        bgColor2: lookHex(r.bgColor2, d.bgColor2),
        fg: lookOneOf(r.fg, LAUNCH_FGS, d.fg),
        fgColor: lookHex(r.fgColor, d.fgColor),
        border: r.border === undefined ? d.border : !!r.border,
        shadow: r.shadow === undefined ? d.shadow : !!r.shadow,
        anim: lookOneOf(r.anim, LAUNCH_ANIMS, d.anim),
        opacity: lookNum(r.opacity, 20, 100, d.opacity),
        label: String(r.label ?? d.label).slice(0, 16),
        badge: r.badge === undefined ? d.badge : !!r.badge,
    };
}

export function normTopLook(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const d = TOP_DEFAULT;
    const size = Number(r.size) || 0;
    return {
        icon: lookFa(r.icon, d.icon),
        emoji: cleanEmoji(r.emoji),
        image: cleanImage(r.image),
        size: size ? lookNum(size, 12, 64, 0) : 0,
        color: lookOneOf(r.color, ['theme', 'custom'], d.color),
        colorHex: lookHex(r.colorHex, d.colorHex),
        opacity: lookNum(r.opacity, 20, 100, d.opacity),
        badge: r.badge === undefined ? d.badge : !!r.badge,
    };
}

export function normMenuLook(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const d = MENU_DEFAULT;
    return {
        icon: lookFa(r.icon, d.icon),
        emoji: cleanEmoji(r.emoji),
        label: String(r.label ?? '').trim().slice(0, 30) || d.label,
        color: lookOneOf(r.color, ['theme', 'custom'], d.color),
        colorHex: lookHex(r.colorHex, d.colorHex),
        wiIcon: lookFa(r.wiIcon, d.wiIcon),
        wiEmoji: cleanEmoji(r.wiEmoji),
    };
}
