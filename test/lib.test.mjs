import test from 'node:test';
import assert from 'node:assert/strict';
import {
    detectFormat, readLorebook, mergeBooks, toWorld, cleanKeys, titleParts, keyMatches, firingKey,
    simulate, diagnose, applyChanges, overCap, estTokens, LOGIC, POSITION,
    entryStatus, entriesOf, freeUid, newEntry, keyWarnings, entryWarnings, entryMatches, positionShort, bookStats, SORTS,
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
