/*
 * Lore Master — this extension's own settings (stored in SillyTavern's extension settings).
 */

export const MODULE = 'lore-master';

export const DEFAULTS = {
    interceptImport: true,       // World Info "Import" opens JanitorAI files here
    replaceWorldInfo: true,      // the top-bar World Info button (and card/chat lore buttons) open Lore Master
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
};

export function settings() {
    const all = SillyTavern.getContext().extensionSettings;
    const cur = all[MODULE] ?? {};
    all[MODULE] = Object.assign({}, structuredClone(DEFAULTS), cur);
    if (!all[MODULE].caps || typeof all[MODULE].caps !== 'object') all[MODULE].caps = {};
    if (!all[MODULE].launcherPos || typeof all[MODULE].launcherPos !== 'object') all[MODULE].launcherPos = { ...DEFAULTS.launcherPos };
    return all[MODULE];
}
export const save = () => SillyTavern.getContext().saveSettingsDebounced();
