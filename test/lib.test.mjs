import test from 'node:test';
import assert from 'node:assert/strict';
import {
    detectFormat, readLorebook, mergeBooks, toWorld, cleanKeys, titleParts, splitCategory, categorize, CATEGORY_KEY, parseOrganizePlan, parseOrganizeReply, organizeRequest, keyMatches, firingKey,
    simulate, diagnose, applyChanges, overCap, estTokens, LOGIC, POSITION,
    entryStatus, entriesOf, freeUid, newEntry, keyWarnings, entryWarnings, entryMatches, positionShort, bookStats, SORTS,
    parseJsonLoose, properNames, collectNames, deriveNames, nameRequest, parseNameReply, entrySuggestions, preferThaiKey, vetThaiKey, glossaryLines, glossaryContent, parseGlossary, upsertGlossaryList,
    isGlossary, pickGlossary, condenseRequest, cleanCondensed, LONG_TOKENS,
    textLanguage, entryLanguage, wantsTranslation, translateRequest, parseTranslation, applyTranslation, namesFor,
    keyScanner, trimToLimits, wouldFire, cardFromPng, keyPlan,
    LAUNCH_DEFAULT, normLaunchLook, normTopLook, normMenuLook, cleanImage, cleanEmoji,
} from '../lib.js';

/** A JanitorAI export entry, with the fields their files carry. */
const jan = (id, comment, key, content, extra = {}) => ({
    activationMode: 'standard', activationScript: '', case_sensitive: false, category: 'other', comment, constant: false,
    content, depth: 4, enabled: true, extensions: {}, groupWeight: 100, id, inclusionGroupRaw: '', insertion_order: (id + 1) * 100,
    key, keyMatchPriority: false, keysecondary: [], keysecondaryRaw: '', keysRaw: key.join(', '), matchWholeWords: true,
    minMessages: 0, name: '', prioritizeInclusion: false, priority: id + 1, probability: 100, selectiveLogic: 0, tags: [],
    keywordsRaw: key.join(', '), ...extra,
});

test('detectFormat tells the formats apart', () => {
    assert.equal(detectFormat([jan(0, 'A', ['a'], 'x')]), 'janitor');
    assert.equal(detectFormat({ entries: { 0: { key: [] } } }), 'st');
    assert.equal(detectFormat({ name: 'b', entries: [{ keys: ['a'], content: 'x' }] }), 'charbook');
    assert.equal(detectFormat({ spec: 'chara_card_v2', data: { name: 'C', character_book: { entries: [] } } }), 'card');
    assert.equal(detectFormat({ type: 'risu' }), 'risu');
    assert.equal(detectFormat([1, 2]), null);
    assert.equal(detectFormat('x'), null);
});

test('JanitorAI entries become SillyTavern entries', () => {
    const { format, entries } = readLorebook([
        jan(0, 'Weld / Garrick Voss', ['Weld', 'Garrick Voss'], 'armor', { minMessages: 3, probability: 60, prioritizeInclusion: true, inclusionGroupRaw: 'villains' }),
        jan(1, 'Off', ['x'], 'y', { enabled: false, keysecondary: ['night'], selectiveLogic: 2 }),
    ], { defaultPosition: POSITION.atDepth });
    assert.equal(format, 'janitor');
    const [a, b] = entries;
    assert.deepEqual(a.key, ['Weld', 'Garrick Voss']);
    assert.equal(a.comment, 'Weld / Garrick Voss');
    assert.equal(a.position, POSITION.atDepth);
    assert.equal(a.depth, 4);
    assert.equal(a.order, 100);
    assert.equal(a.delay, 3);
    assert.equal(a.probability, 60);
    assert.equal(a.useProbability, true);
    assert.equal(a.group, 'villains');
    assert.equal(a.groupOverride, true);
    assert.equal(a.matchWholeWords, true);
    assert.equal(a.caseSensitive, null);
    assert.equal(a.selective, false);
    assert.equal(b.disable, true);
    assert.equal(b.selective, true);
    assert.equal(b.selectiveLogic, LOGIC.NOT_ANY);
});

test('character_book entries keep their extensions; card files are read too', () => {
    const book = { name: 'Book', entries: [{ keys: ['Noel'], content: 'c', insertion_order: 5, position: 'after_char', extensions: { prevent_recursion: true, depth: 2 } }] };
    const r = readLorebook(book);
    assert.equal(r.name, 'Book');
    assert.equal(r.entries[0].position, POSITION.after);
    assert.equal(r.entries[0].preventRecursion, true);
    assert.equal(r.entries[0].depth, 2);
    const card = readLorebook({ data: { name: 'Card', character_book: { entries: [{ keys: 'a, b', content: 'c' }] } } });
    assert.equal(card.format, 'card');
    assert.equal(card.name, 'Card');
    assert.deepEqual(card.entries[0].key, ['a', 'b']);
    assert.throws(() => readLorebook({ hello: 1 }));
});

test('SillyTavern books keep every field and their order', () => {
    const r = readLorebook({ entries: { 5: { uid: 5, displayIndex: 1, key: ['b'], content: 'B', sticky: 2 }, 2: { uid: 2, displayIndex: 0, key: ['a'], content: 'A' } } });
    assert.deepEqual(r.entries.map(e => e.content), ['A', 'B']);
    assert.equal(r.entries[1].sticky, 2);
});

test('cleanKeys splits pasted lists, strips quotes and repeats, leaves regex alone', () => {
    assert.deepEqual(cleanKeys(['Noel, noel-sama', ' "Rook" ', 'noel', '', '/a,b/i']), ['Noel', 'noel-sama', 'Rook', '/a,b/i']);
});

test('titleParts splits the usual separators', () => {
    assert.deepEqual(titleParts('Weld / Garrick Voss'), ['Weld', 'Garrick Voss']);
    assert.deepEqual(titleParts('Marc Ellis — Point Guard'), ['Marc Ellis', 'Point Guard']);
});

test('keyMatches follows SillyTavern: whole words for Latin, Thai matches inside words', () => {
    assert.ok(keyMatches('Meet at the park.', 'Park', { wholeWords: true }));
    assert.ok(!keyMatches('He parked the car.', 'Park', { wholeWords: true }));
    assert.ok(keyMatches('He parked the car.', 'Park', { wholeWords: false }));
    assert.ok(keyMatches('ของโนเอลดังขึ้น', 'โนเอล', { wholeWords: true }));
    assert.ok(keyMatches('Eli Mercer shoots', 'eli mercer', { wholeWords: true }));
    assert.ok(!keyMatches('Park', 'park', { caseSensitive: true }));
    assert.ok(keyMatches('room 404', '/\\d{3}/', {}));
});

test('secondary key logic', () => {
    const e = { key: ['Noel'], keysecondary: ['night'], selective: true, selectiveLogic: LOGIC.AND_ANY };
    assert.equal(firingKey(e, 'Noel at night'), 'Noel');
    assert.equal(firingKey(e, 'Noel at noon'), null);
    assert.equal(firingKey({ ...e, selectiveLogic: LOGIC.NOT_ANY }, 'Noel at noon'), 'Noel');
});

test('simulate follows recursion and stops at prevent/exclude', () => {
    const es = readLorebook([
        jan(0, 'A', ['Alpha'], 'Alpha knows Beta.'),
        jan(1, 'B', ['Beta'], 'Beta fears Gamma.'),
        jan(2, 'C', ['Gamma'], 'Gamma.'),
        jan(3, 'K', ['zzz'], 'always', { constant: true }),
    ]).entries;
    const r = simulate(es, 'Alpha arrives', { recursive: true, wholeWords: true });
    assert.deepEqual(r.hits.map(h => `${h.entry.comment}${h.step}`), ['A1', 'K1', 'B2', 'C3']);
    assert.equal(simulate(es, 'Alpha arrives', { recursive: false }).hits.length, 2);
    es[0].preventRecursion = true;
    assert.equal(simulate(es, 'Alpha arrives', { recursive: true }).hits.length, 2);
    es[0].preventRecursion = false;
    es[1].excludeRecursion = true;
    assert.equal(simulate(es, 'Alpha arrives', { recursive: true }).hits.length, 2);
});

function sampleBooks() {
    const villains = { name: 'Villains', entries: readLorebook([
        jan(0, 'Dead Air / Renee Mercer', ['Dead Air', 'Renee Mercer', 'Renee', 'Mercer', 'Park'], 'Cody hates her. Eli Mercer once met her.'),
        jan(1, 'The Rail Crew', ['The Rail Crew', 'Switch', 'Ticket'], 'Smugglers. Cody tracks them. Dead Air helps them.'),
    ]).entries };
    const npcs = { name: 'NPC', entries: readLorebook([
        jan(0, 'Eli Mercer', ['Eli', 'Eli Mercer', '#2'], 'Cody\'s teammate.'),
        jan(1, 'Cody Dawson', ['Cody Dawson', 'Cody', 'campus'], 'The hero.'),
        jan(2, 'Marc Ellis', ['Marc Ellis', 'Marc'], 'Captain. Cody trusts him. Long text '.repeat(3)),
        jan(3, 'Empty', [], 'never fires'),
    ]).entries };
    const team = { name: 'Team', entries: readLorebook([jan(0, 'Marc Ellis — Point Guard', ['Marc Ellis', '#4'], 'Point guard.')]).entries };
    return mergeBooks([villains, npcs, team]);
}

test('mergeBooks gives fresh uids and remembers the source', () => {
    const all = sampleBooks();
    assert.deepEqual(all.map(e => e.uid), [0, 1, 2, 3, 4, 5, 6]);
    assert.equal(all[2]._src, 'NPC');
});

test('diagnose finds the problems an imported book has', () => {
    const all = sampleBooks();
    const issues = diagnose(all, { names: { char: 'Cody Dawson', user: 'Kim' }, recursive: true, wholeWords: true });
    const by = Object.fromEntries(issues.map(i => [i.id, i]));
    assert.ok(by.everywhere.changes.some(c => c.key === 'Cody' && c.checked));
    assert.ok(by.generic.changes.some(c => c.key === '#2'));
    assert.ok(by.generic.changes.some(c => c.key === 'campus'));
    assert.ok(by.generic.changes.some(c => c.key === 'Switch'));
    assert.ok(by.generic.changes.some(c => c.key === 'Park'));
    const clash = by.clash.changes.find(c => c.key === 'Mercer');
    assert.ok(clash?.checked, 'surname clash is ticked');
    assert.ok(by.clash.changes.every(c => c.key !== 'Eli'), 'a key is not a clash with its own name');
    const dupe = by.dupes.changes[0];
    assert.equal(dupe.op, 'merge');
    assert.equal(all.find(e => e.uid === dupe.uid).comment, 'Marc Ellis — Point Guard');
    assert.ok(by.recursion);
    assert.ok(by.nokeys.changes[0].label.includes('Empty'));
    assert.ok(by.thai);
    assert.equal(issues[0].severity, 'high');
});

test('applyChanges carries out fixes and merges duplicates', () => {
    const all = sampleBooks();
    const issues = diagnose(all, { names: { char: 'Cody Dawson' }, recursive: true, wholeWords: true });
    const fixed = applyChanges(all, issues.flatMap(i => i.changes.filter(c => c.checked)));
    assert.equal(fixed.length, all.length - 1);
    const marc = fixed.find(e => e.comment === 'Marc Ellis');
    assert.ok(marc.content.includes('Point guard.'));
    assert.ok(!marc.key.includes('#4'));
    assert.ok(!diagnose(fixed, { recursive: true, wholeWords: true }).some(i => i.id === 'recursion'), 'no recursion chain left');
    assert.ok(!fixed.find(e => e.comment === 'Cody Dawson').key.includes('Cody'));
    assert.deepEqual(all.find(e => e.comment === 'Cody Dawson').key, ['Cody Dawson', 'Cody', 'campus'], 'input is not changed');
    // after fixing, the same text triggers fewer entries
    const text = 'Cody walks across campus to the park with Eli Mercer.';
    const o = { recursive: true, wholeWords: true, names: { char: 'Cody Dawson' } };
    assert.ok(simulate(fixed, text, o).hits.length < simulate(all, text, o).hits.length);
});

test('chained merges follow the entry that was merged away', () => {
    const es = [{ uid: 0, comment: 'A', key: ['a'], content: 'A' }, { uid: 1, comment: 'B', key: ['b'], content: 'B' }, { uid: 2, comment: 'C', key: ['c'], content: 'C' }];
    const out = applyChanges(es, [{ op: 'merge', uid: 1, into: 2 }, { op: 'merge', uid: 0, into: 1 }]);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].key, ['c', 'b', 'a']);
});

test('constant overload is reported, keeping the smallest one on', () => {
    const es = readLorebook([0, 1, 2, 3].map(i => jan(i, `C${i}`, [`k${i}`], 'x'.repeat(100 * (i + 1)), { constant: true }))).entries;
    const issue = diagnose(es, {}).find(i => i.id === 'constant');
    assert.equal(issue.severity, 'high');
    assert.deepEqual(issue.changes.map(c => c.checked), [false, true, true, true]);
});

test('Risu decorators are found and stripped', () => {
    const es = readLorebook({ entries: [{ keys: ['x'], content: '@@depth 0\n@@role system\nReal text' }] }).entries;
    const issue = diagnose(es, {}).find(i => i.id === 'foreign');
    assert.equal(applyChanges(es, issue.changes)[0].content, 'Real text');
});

test('toWorld writes a SillyTavern world, drops internal fields, can prefix the source', () => {
    const w = toWorld(sampleBooks().slice(0, 2), { prefixSource: true });
    assert.deepEqual(Object.keys(w.entries), ['0', '1']);
    assert.equal(w.entries[0].comment, '[Villains] Dead Air / Renee Mercer');
    assert.ok(!('_src' in w.entries[0]));
    assert.equal(w.entries[1].uid, 1);
});

test('overCap drops the last activated, never constants, only in capped books', () => {
    const act = [
        { world: 'B', uid: 1, constant: true }, { world: 'B', uid: 2 }, { world: 'X', uid: 3 },
        { world: 'B', uid: 4 }, { world: 'B', uid: 5 },
    ];
    assert.deepEqual(overCap(act, { B: 2 }).map(e => e.uid), [5, 4]);
    assert.deepEqual(overCap(act, {}).length, 0);
});

test('estTokens counts Thai denser than English', () => {
    assert.equal(estTokens('abcd'), 1);
    assert.equal(estTokens('สวัสดี'), 3);
});

test('fixing settles: a second pass suggests nothing new that is ticked', () => {
    const team = { name: 'Team', entries: readLorebook([
        jan(0, 'Marc Ellis — Point Guard', ['Marc Ellis'], 'Guard.'),
        jan(1, 'Marc Ellis — Typical Production', ['Marc stats'], 'Stats.'),
    ]).entries };
    const npc = { name: 'NPC', entries: readLorebook([jan(0, 'Marc Ellis', ['Marc Ellis', 'Marc'], 'Captain, long bio text.')]).entries };
    let all = mergeBooks([team, npc]);
    const first = diagnose(all, {});
    assert.equal(first.find(i => i.id === 'dupes').changes.length, 1, 'only one entry per title and book is merged');
    all = applyChanges(all, first.flatMap(i => i.changes.filter(c => c.checked)));
    const second = diagnose(all, {});
    assert.equal(second.flatMap(i => i.changes.filter(c => c.checked)).length, 0);
    assert.ok(all.some(e => e.comment === 'Marc Ellis — Typical Production'), 'the stats entry stays its own entry');
});

test('the character\'s full name as a key is reported even when it is two words', () => {
    const es = readLorebook([jan(0, 'Cody Dawson — Small Forward', ['Cody Dawson', 'Bears small forward'], 'x')]).entries;
    const c = diagnose(es, { names: { char: 'Cody Dawson' } }).find(i => i.id === 'everywhere').changes[0];
    assert.equal(c.key, 'Cody Dawson');
    assert.ok(c.checked);
});

test('entryStatus', () => {
    assert.equal(entryStatus({ disable: true, constant: true }), 'off');
    assert.equal(entryStatus({ constant: true }), 'constant');
    assert.equal(entryStatus({ vectorized: true }), 'vector');
    assert.equal(entryStatus({}), 'key');
});

test('entriesOf keeps book order; freeUid and newEntry fill gaps and append', () => {
    const w = { entries: { 0: { uid: 0, displayIndex: 2 }, 2: { uid: 2, displayIndex: 0 }, 3: { uid: 3 } } };
    assert.deepEqual(entriesOf(w).map(e => e.uid), [2, 0, 3]);
    assert.equal(freeUid(w), 1);
    const e = newEntry(w, undefined, { comment: 'x' });
    assert.equal(e.uid, 1);
    assert.equal(e.displayIndex, 3);
    assert.equal(e.comment, 'x');
    assert.deepEqual(e.key, []);
    assert.equal(freeUid({ entries: {} }), 0);
});

test('keyWarnings: names, numbers, short, common, Thai dictionary words, bad regex', () => {
    const ctx = { names: { char: 'Cody Dawson', user: 'Kim' }, isThaiDictWord: s => ['ยา', 'แมว'].includes(s) };
    const lv = k => keyWarnings(k, ctx).map(w => w.level);
    assert.deepEqual(lv('Cody'), ['bad']);
    assert.deepEqual(lv('{{user}}'), ['bad']);
    assert.deepEqual(lv('#11'), ['warn']);
    assert.deepEqual(lv('Al'), ['warn']);
    assert.deepEqual(lv('Park'), ['warn']);
    assert.deepEqual(lv('ยา'), ['warn']);
    assert.deepEqual(lv('โนเอล'), []);
    assert.deepEqual(lv('forklift'), ['warn']);
    assert.deepEqual(lv('zebrafish'), ['info']);
    assert.deepEqual(lv('Garrick Voss'), []);
    assert.deepEqual(lv('/(unclosed/'), ['bad']);
    assert.deepEqual(lv('/ok|fine/i'), []);
});

test('entryWarnings counts what matters for the list badge', () => {
    assert.deepEqual(entryWarnings({ key: [], content: 'x' }), ['ไม่มีคีย์ ไม่มีวันติด']);
    assert.equal(entryWarnings({ key: [], constant: true, content: 'x' }).length, 0);
    assert.equal(entryWarnings({ key: ['zebrafish'], content: 'x' }).length, 0, 'info-level key notes are not counted');
    assert.equal(entryWarnings({ key: ['Park'], content: '' }).length, 2);
});

test('entryMatches searches title, keys and content with every word', () => {
    const e = { uid: 7, comment: 'Weld', key: ['Garrick'], keysecondary: [], content: 'hydraulic armor' };
    assert.ok(entryMatches(e, 'weld armor'));
    assert.ok(entryMatches(e, 'garrick'));
    assert.ok(entryMatches(e, '#7'));
    assert.ok(!entryMatches(e, 'weld laser'));
    assert.ok(entryMatches(e, '  '));
});

test('positionShort and sorts', () => {
    assert.equal(positionShort({ position: 0 }), '↑ตัวละคร');
    assert.equal(positionShort({ position: 4, depth: 2, role: 1 }), '@D2👤');
    assert.equal(positionShort({ position: 7, outletName: 'v' }), 'Outlet:v');
    const list = [{ comment: 'ข', order: 1, content: 'a' }, { comment: 'ก', order: 5, content: 'aaaaaaaa' }];
    assert.equal([...list].sort(SORTS.name.fn)[0].comment, 'ก');
    assert.equal([...list].sort(SORTS.order.fn)[0].order, 5);
    assert.equal([...list].sort(SORTS.tokens.fn)[0].comment, 'ก');
});

test('bookStats', () => {
    const s = bookStats({ entries: { 0: { content: 'abcdefgh', constant: true }, 1: { content: 'abcd', disable: true } } });
    assert.deepEqual(s, { count: 2, on: 1, constant: 1, tokens: 2 });
});

test('parseJsonLoose copes with fences, think blocks and trailing commas', () => {
    assert.deepEqual(parseJsonLoose('<think>hmm {x}</think>```json\n{"a":[1,2,],}\n```'), { a: [1, 2] });
    assert.throws(() => parseJsonLoose('no json here'));
});

test('properNames keeps the subject and Title-Case keys, skips descriptions, numbers, acronyms, common words', () => {
    const e = { comment: '[Villains] Weld / Garrick Voss', key: ['Weld', 'Garrick Voss', 'Garrick', 'industrial armor', '#4', 'EMC', 'Park', 'Spider-Man from Temu', 'Karren von Rosewald', 'เวลด์'] };
    assert.deepEqual(properNames(e), ['Weld', 'Garrick Voss', 'Garrick', 'Karren von Rosewald']);
});

test('collectNames asks each name once, and given names come from the full name', () => {
    const es = [
        { uid: 0, comment: 'Marc Ellis — Point Guard', key: ['Marc Ellis', 'Marc'] },
        { uid: 1, comment: 'Marc Ellis', key: ['Marc Ellis', 'team captain'] },
        { uid: 2, comment: 'Weld', key: ['Weld'] },
    ];
    const { names, byEntry, derived } = collectNames(es);
    assert.deepEqual(names.map(n => n.name), ['Marc Ellis', 'Weld']);
    assert.deepEqual(byEntry.get(0), ['marc ellis', 'marc']);
    assert.deepEqual(derived.get('marc'), { from: 'marc ellis', index: 0 });
    assert.match(nameRequest(names), /^0\. Marc Ellis\n1\. Weld$/);
    assert.match(nameRequest(names.slice(0, 1), { context: 'a\n b' }), /context: a b$/);
    const results = new Map([['marc ellis', { lang: 'en', translit: ['มาร์ก เอลลิส', 'มาร์ค เอลลิส'], english: [], translated: [], nick: [] }]]);
    deriveNames(results, derived);
    assert.deepEqual(results.get('marc').translit, ['มาร์ก', 'มาร์ค']);
});

test('a one-word name used on its own somewhere is still asked', () => {
    const { names } = collectNames([
        { uid: 0, comment: 'Marc Ellis', key: ['Marc Ellis', 'Marc'] },
        { uid: 1, comment: 'Marc', key: ['Marc'] },
    ]);
    assert.deepEqual(names.map(n => n.name), ['Marc Ellis', 'Marc']);
});

test('parseNameReply keeps Thai only, drops English readings equal to the origin one', () => {
    const list = [{ id: 0, name: 'Michelangelo', lower: 'michelangelo' }, { id: 1, name: 'Halpern Library', lower: 'halpern library' }];
    const reply = '```json\n{"names":[{"id":0,"lang":"it","translit":["มีเกลันเจโล"],"english":["ไมเคิล แองเจโล","มีเกลันเจโล","Michael"]},{"id":1,"lang":"en","translit":["ฮาลเพิร์น ไลบรารี"],"translated":["ห้องสมุดฮาลเพิร์น"]},{"id":7,"translit":["x"]}]}\n```';
    const m = parseNameReply(reply, list);
    assert.deepEqual(m.get('michelangelo'), { lang: 'it', translit: ['มีเกลันเจโล'], english: ['ไมเคิล แองเจโล'], translated: [], nick: [] });
    assert.deepEqual(m.get('halpern library').translated, ['ห้องสมุดฮาลเพิร์น']);
    assert.equal(m.size, 2);
});

test('entrySuggestions groups the answers for an entry and skips keys it has', () => {
    const results = new Map([
        ['garrick voss', { lang: 'de', translit: ['การ์ริค ฟอสส์'], english: ['แกร์ริค วอสส์'], translated: [], nick: [] }],
        ['weld', { lang: 'en', translit: ['เวลด์'], english: [], translated: [], nick: ['ไอ้หุ่นเหล็ก'] }],
    ]);
    const s = entrySuggestions({ key: ['Weld', 'เวลด์'] }, ['weld', 'garrick voss', 'missing'], results);
    assert.deepEqual(s, { langs: ['en', 'de'], origin: ['การ์ริค ฟอสส์'], english: ['แกร์ริค วอสส์'], nick: ['ไอ้หุ่นเหล็ก'], translated: [] });
});

test('preferThaiKey makes a key the first Thai key, after the English ones', () => {
    assert.deepEqual(preferThaiKey(['Weld', 'เวลด์', 'เว็ลด์'], 'เว็ลด์'), ['Weld', 'เว็ลด์', 'เวลด์']);
    assert.deepEqual(preferThaiKey(['Weld'], 'เวลด์'), ['Weld', 'เวลด์']);
    assert.deepEqual(glossaryLines([{ comment: 'Weld', key: preferThaiKey(['Weld', 'เวลด์', 'เว็ลด์'], 'เว็ลด์') }]), [{ en: 'Weld', th: 'เว็ลด์' }]);
});

test('vetThaiKey warns when a Thai key sits inside another entry\'s key', () => {
    const es = [{ uid: 1, comment: 'Marc', key: ['มาร์ค'] }, { uid: 2, comment: 'Marcus Lee', key: ['มาร์คัส'] }];
    const w = vetThaiKey('มาร์ค', es[0], es, {});
    assert.ok(w.some(x => x.text.includes('Marcus Lee')));
    assert.equal(vetThaiKey('มาร์คัส', es[1], es, {}).length, 0);
    assert.ok(vetThaiKey('ยา', es[0], es, { isThaiDictWord: s => s === 'ยา' }).length);
});

test('glossary: lines from Thai keys, content round-trip, upsert and removal', () => {
    const es = [
        { uid: 0, comment: '[Villains] Weld / Garrick Voss', key: ['Weld', 'เวลด์'], content: 'x' },
        { uid: 1, comment: 'Cody Dawson — Small Forward', key: ['Cody Dawson', 'โคดี้ ดอว์สัน'], content: 'x' },
        { uid: 2, comment: 'No Thai', key: ['Nope'], content: 'x' },
    ];
    const lines = glossaryLines(es);
    assert.deepEqual(lines, [{ en: 'Weld', th: 'เวลด์' }, { en: 'Cody Dawson', th: 'โคดี้ ดอว์สัน' }]);
    assert.deepEqual(parseGlossary(glossaryContent(lines)), lines);
    const withG = upsertGlossaryList(es);
    assert.equal(withG.length, 4);
    const g = withG.find(isGlossary);
    assert.equal(g.uid, 3);
    assert.equal(g.constant, true);
    assert.equal(g.preventRecursion, true);
    // refresh in place, not a second one
    withG[0].key.push('เวลด์ดี้');
    assert.equal(upsertGlossaryList(withG).filter(isGlossary).length, 1);
    // no Thai keys left → the glossary goes away
    const none = upsertGlossaryList(withG.map(e => (isGlossary(e) ? e : { ...e, key: ['x'] })));
    assert.equal(none.filter(isGlossary).length, 0);
    // the glossary is not checked as a normal entry
    assert.ok(!diagnose(withG, {}).some(i => i.id === 'nokeys'));
});

test('pickGlossary keeps names in the chat or of fired entries', () => {
    const lines = [{ en: 'Cody Dawson', th: 'โคดี้ ดอว์สัน' }, { en: 'Weld', th: 'เวลด์' }, { en: 'Dana', th: 'ดาน่า' }];
    const picked = pickGlossary(lines, { text: 'Kim: Cody, look out!', activated: [{ comment: 'Weld / Garrick', key: ['Weld'] }] });
    assert.deepEqual(picked.map(l => l.en), ['Cody Dawson', 'Weld']);
    assert.deepEqual(pickGlossary(lines, { text: 'ดาน่ายิ้ม' }).map(l => l.en), ['Dana']);
    assert.deepEqual(pickGlossary([{ en: 'The Rail Crew', th: 'เรลครูว์' }], { text: 'the park' }), [], '"The" alone is not a name');
});

test('condense: request names the target, cleaning rejects bad rewrites', () => {
    const orig = `# WELD\n${'Garrick talks a lot about {{user}} and labor. '.repeat(30)}`;
    assert.match(condenseRequest({ comment: 'Weld', content: orig }, 0.5), /Target length: about \d+ tokens \(50%/);
    const good = `# WELD\n${'- Garrick Voss: armored thief, labor speeches, hates {{user}}\n'.repeat(6)}`.trim();
    assert.equal(cleanCondensed(`\`\`\`\n${good}\n\`\`\``, orig), good);
    assert.equal(cleanCondensed('# WELD\n- Garrick, armored thief', orig), null, 'lost the {{user}} macro');
    assert.equal(cleanCondensed(orig, orig), null, 'not shorter');
    assert.equal(cleanCondensed('ok', orig), null, 'a stub');
});

test('Thai-key issue lists every entry without a Thai key; long entries use LONG_TOKENS', () => {
    const es = [{ uid: 0, comment: 'A', key: ['Alpha'], content: 'x'.repeat(LONG_TOKENS * 4 + 8) }, { uid: 1, comment: 'B', key: ['บี'], content: 'y' }];
    const issues = diagnose(es, {});
    assert.deepEqual(issues.find(i => i.id === 'thai').uids, [0]);
    assert.deepEqual(issues.find(i => i.id === 'big').uids, [0]);
});

test('keyScanner finds every entry with a key in the text, including keys inside longer keys', () => {
    const es = [
        { uid: 0, key: ['Ken Kaneki'] }, { uid: 1, key: ['Ken'] }, { uid: 2, key: ['Touka'] }, { uid: 3, key: ['/ann?ie/i'] }, { uid: 4, key: ['{{char}}'] },
    ];
    const scan = keyScanner(es, { char: 'Hide' });
    const ids = t => [...scan(t)].map(e => e.uid).sort();
    assert.deepEqual(ids('Then KEN KANEKI smiled'), [0, 1, 3]);
    assert.deepEqual(ids('touka and hide'), [2, 3, 4]);
    assert.deepEqual(ids('nothing'), [3]);
});

test('simulate gives the same result with the scanner on overlapping keys and recursion', () => {
    const es = [
        { uid: 0, comment: 'A', key: ['Ken Kaneki'], content: 'Ken knows Touka.' },
        { uid: 1, comment: 'B', key: ['Touka'], content: 'Touka works at Anteiku.' },
        { uid: 2, comment: 'C', key: ['Anteiku'], content: 'A café.' },
        { uid: 3, comment: 'D', key: ['Ken'], content: 'x' },
    ];
    const r = simulate(es, 'Ken Kaneki walks in', { recursive: true });
    assert.deepEqual(r.hits.map(h => `${h.entry.comment}${h.step}`), ['A1', 'D1', 'B2', 'C3']);
});

test('trimToLimits keeps constants, then entries in order, within both limits', () => {
    const e = (uid, len, constant = false) => ({ uid, content: 'x'.repeat(len * 4), constant });
    const { keep, drop, tokens } = trimToLimits([e(0, 10), e(1, 50, true), e(2, 30), e(3, 30), e(4, 5)], { maxEntries: 3, maxTokens: 100 });
    assert.deepEqual(keep.map(x => x.uid), [1, 0, 2]);
    assert.deepEqual(drop.map(x => x.uid), [3, 4]);
    assert.equal(tokens, 90);
});

test('wouldFire skips constants, disabled, already active, and non-recursable entries in recursion', () => {
    const es = [
        { uid: 0, key: ['Ken'] }, { uid: 1, key: ['Ken'], constant: true }, { uid: 2, key: ['Ken'], disable: true },
        { uid: 3, key: ['Ken'], excludeRecursion: true }, { uid: 4, key: ['Touka'] },
    ];
    assert.deepEqual(wouldFire(es, 'Ken', {}).map(e => e.uid), [0, 3]);
    assert.deepEqual(wouldFire(es, 'Ken', { recursion: true, skip: new Set([es[0]]) }).map(e => e.uid), []);
});

test('cardFromPng reads the ccv3 / chara text chunk', () => {
    const card = { spec: 'chara_card_v3', data: { name: 'โนเอล', character_book: { entries: [{ keys: ['a'], content: 'b' }] } } };
    const b64 = Buffer.from(JSON.stringify(card), 'utf8').toString('base64');
    const chunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
    };
    const png = Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', Buffer.alloc(13)),
        chunk('tEXt', Buffer.concat([Buffer.from('chara\0', 'latin1'), Buffer.from(b64, 'latin1')])),
        chunk('IEND', Buffer.alloc(0)),
    ]);
    assert.deepEqual(cardFromPng(png), card);
    assert.equal(detectFormat(cardFromPng(png)), 'card');
    assert.equal(cardFromPng(Buffer.from('nope')), null);
});

test('hub keys only count contents that still recurse, and are never pre-ticked', () => {
    const mk = (uid, key, content, extra = {}) => ({ uid, comment: key, key: [key], content, ...extra });
    const es = [mk(0, 'Kaneki', 'x'), ...[1, 2, 3, 4, 5].map(i => mk(i, `E${i}`, 'Kaneki was here'))];
    const before = diagnose(es, {}).find(i => i.id === 'hubkeys');
    assert.ok(before.changes.length && before.changes.every(c => !c.checked));
    const fixed = es.map(e => ({ ...e, preventRecursion: true }));
    assert.ok(!diagnose(fixed, {}).some(i => i.id === 'hubkeys'), 'gone once recursion is fixed');
});

test('several fixes never leave an entry without keys; keyPlan shows what is left', () => {
    const es = [{ uid: 0, comment: 'Dana', key: ['Mom', 'mother'], content: 'x' }];
    const changes = [
        { op: 'removeKey', uid: 0, key: 'Mom', checked: true },
        { op: 'removeKey', uid: 0, key: 'mother', checked: true },
    ];
    const plan = keyPlan(es, changes).get(0);
    assert.deepEqual(plan.after, ['mother']);
    assert.equal(plan.kept, 'mother');
    const out = applyChanges(es, changes);
    assert.deepEqual(out[0].key, ['mother']);
    assert.deepEqual(out.keptKeys.map(k => k.key), ['mother']);
});

test('issues come in the recommended order and say what fixing costs', () => {
    const issues = diagnose(sampleBooks(), { names: { char: 'Cody Dawson' }, recursive: true, wholeWords: true });
    const ids = issues.map(i => i.id);
    assert.ok(ids.indexOf('recursion') < ids.indexOf('generic'));
    for (const i of issues.filter(x => x.changes.length)) {
        assert.ok(i.kind === 'safe' || i.kind === 'keys', i.id);
        assert.ok(i.fix && i.tradeoff, i.id);
    }
});

test('splitCategory reads a short leading category', () => {
    assert.deepEqual(splitCategory('[NPC] Cody'), { cat: 'NPC', rest: 'Cody' });
    assert.deepEqual(splitCategory('【สถานที่】ตลาดน้ำ'), { cat: 'สถานที่', rest: 'ตลาดน้ำ' });
    assert.deepEqual(splitCategory('สถานที่: ตลาดน้ำ'), { cat: 'สถานที่', rest: 'ตลาดน้ำ' });
    assert.deepEqual(splitCategory('Cody - วัยเด็ก'), { cat: 'Cody', rest: 'วัยเด็ก' });
    assert.equal(splitCategory('Cody'), null);
    assert.equal(splitCategory('12:30 meeting'), null);
    assert.equal(splitCategory('A very long sentence that is clearly not a category at all: x'), null);
});

test('categorize keeps only prefixes shared by several entries', () => {
    const m = categorize([
        { uid: 1, comment: '[NPC] Cody' }, { uid: 2, comment: '[npc] Mira' },
        { uid: 3, comment: 'Cody - childhood' }, { uid: 4, comment: 'Plain' },
    ]);
    assert.deepEqual([...m.keys()], [1, 2]);
    assert.equal(m.get(2).cat, 'NPC');
    assert.equal(m.get(2).rest, 'Mira');
});

test('categorize takes long bracketed book names and one level below them', () => {
    const book = 'Cody Basketball and Northpoint Bears_SillyTavern_Lorebook';
    const m = categorize([
        { uid: 1, comment: `[${book}] Northpoint Bears` }, { uid: 2, comment: `[${book}] EMC` },
        { uid: 3, comment: `[${book}] NPC: Coach` }, { uid: 4, comment: `[${book}] NPC: Rival` },
        { uid: 5, comment: 'A long unbracketed sentence that is no category: at all' },
    ]);
    assert.equal(m.get(1).cat, book);
    assert.equal(m.get(1).rest, 'Northpoint Bears');
    assert.equal(m.get(3).cat, `${book} › NPC`);
    assert.equal(m.get(3).rest, 'Coach');
    assert.equal(m.has(5), false);
});

test('categorize uses a stored category even for a single entry', () => {
    const m = categorize([
        { uid: 1, comment: 'Cody – Childhood', extensions: { [CATEGORY_KEY]: 'ตัวละคร' } },
        { uid: 2, comment: 'Cody – Looks', extensions: { [CATEGORY_KEY]: 'ตัวละคร' } },
        { uid: 3, comment: 'Arena', extensions: { [CATEGORY_KEY]: 'สถานที่' } },
    ]);
    assert.equal(m.get(3).cat, 'สถานที่');
    assert.equal(m.get(1).cat, 'ตัวละคร › Cody');
    assert.equal(m.get(1).rest, 'Childhood');
});

test('organiser replies are parsed and checked', () => {
    assert.deepEqual(parseOrganizePlan('ok {"categories":[{"name":"ตัวละคร","about":"x"},"สถานที่",{"name":"ตัวละคร"}]}').map(c => c.name), ['ตัวละคร', 'สถานที่']);
    assert.throws(() => parseOrganizePlan('{"categories":[]}'));
    const r = parseOrganizeReply('```json\n{"entries":[[1,"ทีม","Northpoint Bears"],["2","ทีม","EMC"],[9,"x","y"]]}\n```', [1, 2]);
    assert.deepEqual([...r.keys()], ['1', '2']);
    assert.equal(r.get('2').name, 'EMC');
    assert.throws(() => parseOrganizeReply('{"entries":[[1,"a","b"]]}', [1, 2, 3]));
    assert.match(organizeRequest([{ uid: 7, comment: '[Book] X', key: ['a', 'b'], content: 'Long\ntext' }]), /^Entries .*\n7 \| \[Book\] X \| a, b \| Long text$/);
});

test('translate: which entries are in another language', () => {
    assert.equal(textLanguage('Kim Minjun is a barista.'), null);
    assert.equal(textLanguage('김민준은 카페 달빛의 바리스타다.').lang, 'ko');
    assert.equal(textLanguage('彼は東京に住んでいる。').lang, 'ja', 'kanji with kana is Japanese');
    assert.equal(textLanguage('他住在北京。').lang, 'zh');
    assert.ok(textLanguage('Kim Minjun (김민준) works at the Moonlight Café near the station every day.').share < 0.3, 'a name in brackets stays English');
    const ko = { uid: 1, comment: '김민준', key: ['김민준', '민준'], content: '카페 달빛의 바리스타. {{user}}의 소꿉친구.' };
    assert.equal(entryLanguage(ko).lang, 'ko');
    assert.ok(wantsTranslation(ko));
    assert.ok(!wantsTranslation({ comment: 'มาร์ก', key: ['มาร์ก'], content: 'มาร์กเป็นนักบาส' }), 'Thai is not ticked for the user');
    assert.ok(!wantsTranslation({ comment: 'Cody', key: ['Cody'], content: 'Cody plays ball.' }));
});

test('translate: request carries keys and the names already spelled', () => {
    const e = { comment: '김민준', key: ['김민준', '/민준|준이/'], keysecondary: ['카페'], content: '김민준은 이서연을 좋아한다.' };
    const req = translateRequest(e, new Map([['이서연', 'Lee Seoyeon'], ['박지호', 'Park Jiho']]));
    assert.match(req, /Known names \(use these spellings\):\n이서연 = Lee Seoyeon\n/);
    assert.doesNotMatch(req, /Park Jiho/, 'only names in this entry');
    assert.doesNotMatch(req, /준이/, 'regex keys are not sent');
    assert.match(req, /Secondary keywords:\n카페/);
    assert.match(req, /<entry>\n김민준은 이서연을 좋아한다.\n<\/entry>/);
    assert.deepEqual(namesFor(e, [['서연', 'Seoyeon'], ['지호', 'Jiho']]), [['서연', 'Seoyeon']]);
});

test('translate: reading the reply, and refusing unusable ones', () => {
    const e = { comment: '김민준', key: ['김민준', '민준'], keysecondary: [], content: '카페 달빛의 바리스타. {{user}}의 소꿉친구이며 커피를 사랑한다.' };
    const good = `<think>ok</think>
<title>Kim Minjun</title>
<keys>
- Kim Minjun
- Minjun
</keys>
<secondary>
</secondary>
<names>
김민준 = Kim Minjun
달빛 = Moonlight Café
Kim = Kim
</names>
<content>
Barista at the Moonlight Café. {{user}}'s childhood friend, and he loves coffee.
</content>`;
    const tr = parseTranslation(good, e);
    assert.equal(tr.comment, 'Kim Minjun');
    assert.deepEqual(tr.key, ['Kim Minjun', 'Minjun']);
    assert.deepEqual(tr.keysecondary, []);
    assert.deepEqual(tr.names, [['김민준', 'Kim Minjun'], ['달빛', 'Moonlight Café']]);
    assert.match(tr.content, /^Barista at the Moonlight Café/);
    assert.throws(() => parseTranslation(good.replace(/\n<\/content>/, ''), e), /ตัดกลางทาง/, 'cut off');
    assert.throws(() => parseTranslation(good.replace("{{user}}'s", 'your'), e), /\{\{user\}\}/, 'lost a macro');
    assert.throws(() => parseTranslation(good.replace(/Barista[^\n]*/, '카페 달빛의 바리스타. {{user}}의 소꿉친구이며 커피를 사랑한다.'), e), /แปลไม่หมด/);
    assert.throws(() => parseTranslation(good.replace(/Barista[^\n]*/, '{{user}}'), e), /สั้นกว่า/);
    assert.throws(() => parseTranslation(good.replace(/<keys>[\s\S]*?<\/keys>/, '<keys>\n</keys>'), e), /คีย์/);
    assert.equal(parseTranslation(good.replace('<title>Kim Minjun</title>', '<title>(none)</title>'), e).comment, '김민준');
});

test('translate: applying swaps keys but keeps Thai, English and regex keys', () => {
    const e = { uid: 3, comment: '김민준', key: ['김민준', 'มินจุน', 'Minjun', '/민준|준이/'], keysecondary: ['카페', 'cafe'], selectiveLogic: 3, content: 'x', order: 7 };
    const tr = { comment: 'Kim Minjun', key: ['Kim Minjun', 'Minjun'], keysecondary: ['Café'], content: 'Barista.' };
    const out = applyTranslation(e, tr);
    assert.equal(out.comment, 'Kim Minjun');
    assert.equal(out.content, 'Barista.');
    assert.deepEqual(out.key, ['Kim Minjun', 'Minjun', 'มินจุน', '/민준|준이/']);
    assert.deepEqual(out.keysecondary, ['Café', 'cafe'], 'old-language secondary keys always go');
    assert.equal(out.order, 7);
    assert.deepEqual(applyTranslation(e, tr, { keepKeys: true }).key, ['Kim Minjun', 'Minjun', '김민준', 'มินจุน', '/민준|준이/']);
    assert.deepEqual(applyTranslation({ ...e, keysecondary: [] }, tr).keysecondary, [], 'no secondary keys added where there were none');
    assert.deepEqual(e.key, ['김민준', 'มินจุน', 'Minjun', '/민준|준이/'], 'the original is not changed');
});

test('normLaunchLook: nothing stored draws the original button', () => {
    assert.deepEqual(normLaunchLook(undefined), { ...LAUNCH_DEFAULT });
    assert.deepEqual(normLaunchLook({}), { ...LAUNCH_DEFAULT });
    assert.deepEqual(normLaunchLook('junk'), { ...LAUNCH_DEFAULT });
});

test('normLaunchLook keeps good values and replaces broken ones', () => {
    const L = normLaunchLook({ shape: 'hexagon', icon: 'fa-gem', size: 500, iconSize: 3, opacity: '50', bg: 'custom2', bgColor: '#ABCDEF', bgColor2: 'red', anim: 'shimmer', border: 0, badge: false, label: 'x'.repeat(40) });
    assert.equal(L.shape, 'hexagon');
    assert.equal(L.icon, 'fa-gem');
    assert.equal(L.size, 140);
    assert.equal(L.iconSize, 20);
    assert.equal(L.opacity, 50);
    assert.equal(L.bgColor, '#abcdef');
    assert.equal(L.bgColor2, LAUNCH_DEFAULT.bgColor2);
    assert.equal(L.anim, 'shimmer');
    assert.equal(L.border, false);
    assert.equal(L.badge, false);
    assert.equal(L.label.length, 16);
    const bad = normLaunchLook({ shape: 'triangle', icon: 'fa-x" onerror="1', bg: 'url(x)', fg: 'nope', anim: 'explode', fit: 'stretch', size: 'big' });
    assert.equal(bad.shape, LAUNCH_DEFAULT.shape);
    assert.equal(bad.icon, LAUNCH_DEFAULT.icon);
    assert.equal(bad.bg, LAUNCH_DEFAULT.bg);
    assert.equal(bad.fg, LAUNCH_DEFAULT.fg);
    assert.equal(bad.anim, LAUNCH_DEFAULT.anim);
    assert.equal(bad.fit, LAUNCH_DEFAULT.fit);
    assert.equal(bad.size, LAUNCH_DEFAULT.size);
});

test('cleanImage takes data: pictures and plain https links only', () => {
    assert.equal(cleanImage('data:image/png;base64,iVBORw0KGgo='), 'data:image/png;base64,iVBORw0KGgo=');
    assert.equal(cleanImage(' https://example.com/a.gif '), 'https://example.com/a.gif');
    assert.equal(cleanImage('javascript:alert(1)'), '');
    assert.equal(cleanImage('https://x.com/a.png") ; background:url("y'), '');
    assert.equal(cleanImage('data:text/html;base64,PHA+'), '');
    assert.equal(cleanImage(null), '');
});

test('cleanEmoji keeps whole characters, at most 8', () => {
    assert.equal(cleanEmoji('  📖 '), '📖');
    assert.equal(Array.from(cleanEmoji('🐱🐱🐱🐱🐱🐱🐱🐱🐱🐱')).length, 8);
    assert.equal(cleanEmoji(undefined), '');
});

test('normTopLook and normMenuLook fill and clamp', () => {
    assert.equal(normTopLook({}).size, 0);
    assert.equal(normTopLook({ size: 200 }).size, 64);
    assert.equal(normTopLook({ size: 5 }).size, 12);
    assert.equal(normTopLook({ color: 'custom', colorHex: '#123456' }).colorHex, '#123456');
    const M = normMenuLook({ label: '   ', wiIcon: 'fa-key', icon: '<b>' });
    assert.equal(M.label, 'Lore Master');
    assert.equal(M.wiIcon, 'fa-key');
    assert.equal(M.icon, 'fa-book-atlas');
});
