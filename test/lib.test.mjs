import test from 'node:test';
import assert from 'node:assert/strict';
import {
    detectFormat, readLorebook, mergeBooks, toWorld, cleanKeys, titleParts, keyMatches, firingKey,
    simulate, diagnose, applyChanges, overCap, estTokens, LOGIC, POSITION,
    entryStatus, entriesOf, freeUid, newEntry, keyWarnings, entryWarnings, entryMatches, positionShort, bookStats, SORTS,
    parseJsonLoose, thaiKeyRequest, parseThaiKeys, vetThaiKey, glossaryLines, glossaryContent, parseGlossary, upsertGlossaryList,
    isGlossary, pickGlossary, condenseRequest, cleanCondensed, LONG_TOKENS,
    keyScanner, trimToLimits, wouldFire, cardFromPng,
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

test('thaiKeyRequest lists every entry with its id', () => {
    const t = thaiKeyRequest([{ uid: 3, comment: 'Weld', key: ['Weld'], content: 'x '.repeat(400) }], { maxContent: 20 });
    assert.match(t, /^id: 3\ntitle: Weld\nkeywords: Weld\ncontent: /);
    assert.ok(t.length < 80);
});

test('parseThaiKeys keeps only new Thai keys, by entry', () => {
    const es = [{ uid: 1, comment: 'Cody', key: ['Cody', 'โคดี้'] }, { uid: 2, comment: 'Library', key: ['Library'] }];
    const reply = '{"entries":[{"id":1,"translit":["โคดี้","โคดี","Cody"],"nick":["โค"],"translated":[]},{"id":2,"translit":[],"translated":["ห้องสมุด, ห้องสมุดฮาลเพิร์น"]},{"id":9,"translit":["x"]}]}';
    const m = parseThaiKeys(reply, es);
    assert.deepEqual(m.get(1), { translit: ['โคดี'], nick: ['โค'], translated: [] });
    assert.deepEqual(m.get(2).translated, ['ห้องสมุด', 'ห้องสมุดฮาลเพิร์น']);
    assert.ok(!m.has(9));
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
