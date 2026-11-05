/*
 * Lore Master — this extension's own settings (stored in SillyTavern's extension settings).
 */

export const MODULE = 'lore-master';

export const DEFAULTS = {
    interceptImport: true,       // World Info "Import" opens JanitorAI files here
    // Off (default): SillyTavern's own World Info buttons keep opening ST's panel, and Lore Master
    // opens only from its own entry points. On: those buttons open Lore Master instead.
    replaceWorldInfo: false,     // the top-bar World Info button (and card/chat lore buttons) open Lore Master
    stPanelButton: true,         // a small "open in Lore Master" button inside ST's World Info panel
    launcher: true,              // floating button
    launcherPos: { x: 1, y: 0.62, edge: 'right' },
    topbar: false,               // icon in the top bar (off: the World Info button already opens Lore Master)
    wand: true,                  // item in the Extensions (wand) menu
    scheme: 'theme',             // theme | light | dark
    /** @type {Record<string, number>} book -> max entries per turn */
    caps: {},
    defaultCap: 10,
    position: 0,                 // where entries from other sites go
    glossarySmart: true,         // send only the glossary names that matter this turn
    condenseRatio: 0.5,          // AI condense: target share of the original length
    ai: { sources: ['main'], timeoutSec: 90 },
    // emergency brake against lorebooks that pull in hundreds of entries in one turn
    guard: true,
    guardMaxEntries: 40,
    guardMaxTokens: 25000,
    warnBigBooks: true,
    entryView: 'card',           // book screen: card | row (one line per entry)
    groupBy: 'title',            // book screen: title (sections from "[NPC] Cody"-style prefixes) | none
};

/** Bumped when a default changes in a way existing installs should pick up once. */
const PREFS_VERSION = 2;
/** Set when this load moved an existing install to the new default, so the UI can say so once. */
export const migrated = { replaceWorldInfo: false };

export function settings() {
    const all = SillyTavern.getContext().extensionSettings;
    const cur = all[MODULE] ?? {};
    // v2: replacing ST's World Info buttons is now opt-in. Older installs saved the old default
    // (true) without anyone choosing it, so move them to the new default once.
    if (Object.keys(cur).length && !(Number(cur.prefsVersion) >= 2)) {
        if (cur.replaceWorldInfo) migrated.replaceWorldInfo = true;
        cur.replaceWorldInfo = false;
    }
    cur.prefsVersion = PREFS_VERSION;
    all[MODULE] = Object.assign({}, structuredClone(DEFAULTS), cur);
    if (!all[MODULE].caps || typeof all[MODULE].caps !== 'object') all[MODULE].caps = {};
    if (!all[MODULE].launcherPos || typeof all[MODULE].launcherPos !== 'object') all[MODULE].launcherPos = { ...DEFAULTS.launcherPos };
    return all[MODULE];
}
export const save = () => SillyTavern.getContext().saveSettingsDebounced();
