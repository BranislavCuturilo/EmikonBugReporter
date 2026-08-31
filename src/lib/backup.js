// Export and import of everything the user typed: credentials, skills, the
// house style, defaults.
//
// An update does not need this -- chrome.storage.local is keyed to the
// extension ID, not to the files on disk, so `git pull` cannot touch it. This
// covers what git cannot: a new machine, a folder someone deleted, a profile
// that was reset, or an extension re-added from a different path (which Chrome
// treats as a different extension unless the manifest pins `key`).
//
// The exported file CONTAINS SECRETS in clear text -- the helpdesk token and
// the Gemini key. Every surface that offers the export says so, because a file
// called "podesavanja.json" does not look like a credential store.

import { DEFAULTS } from "./settings.js";

export const BACKUP_KIND = "emikon-bug-reporter/settings";
export const BACKUP_VERSION = 1;

/** Keys that carry a secret, for the redacted variant. */
const SECRET_KEYS = ["helpdeskToken", "geminiKey"];

/**
 * Everything the user configured, as a plain object ready to be serialised.
 * @param includeSecrets false produces a shareable file with the credentials
 *        removed -- useful for handing the skills to a colleague.
 */
export async function exportSettings({ includeSecrets = true } = {}) {
  const stored = await chrome.storage.local.get(null);
  const data = {};
  for (const key of Object.keys(DEFAULTS)) {
    if (!(key in stored)) continue;
    if (!includeSecrets && SECRET_KEYS.includes(key)) continue;
    data[key] = stored[key];
  }
  return {
    kind: BACKUP_KIND,
    backupVersion: BACKUP_VERSION,
    extensionVersion: chrome.runtime.getManifest().version,
    exportedAt: new Date().toISOString(),
    containsSecrets: includeSecrets && SECRET_KEYS.some((k) => k in data),
    data,
  };
}

/** Hand the browser a file. Extension pages may start their own downloads. */
export async function downloadBackup({ includeSecrets = true } = {}) {
  const payload = await exportSettings({ includeSecrets });
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 10);
  const name = includeSecrets
    ? `bug-reporter-podesavanja-${stamp}.json`
    : `bug-reporter-skillovi-${stamp}.json`;
  try {
    await chrome.downloads.download({ url, filename: name, saveAs: true });
  } catch {
    // downloads permission refused or unavailable: fall back to a link click,
    // which needs no permission at all.
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return name;
}

/**
 * Read a backup file and apply it.
 *
 * Refuses anything that is not recognisably ours. Importing an arbitrary JSON
 * into chrome.storage would half-apply and leave the user with a settings page
 * that looks configured and is not.
 *
 * @param mode "merge" keeps values the file does not carry (so a redacted
 *        export does not wipe the credentials); "replace" restores exactly the
 *        file, clearing anything else.
 */
export async function importSettings(json, { mode = "merge" } = {}) {
  let parsed;
  try {
    parsed = typeof json === "string" ? JSON.parse(json) : json;
  } catch {
    throw new Error("fajl nije ispravan JSON");
  }
  if (!parsed || parsed.kind !== BACKUP_KIND) {
    throw new Error("ovo nije rezervna kopija Bug Reporter podešavanja");
  }
  if (Number(parsed.backupVersion) > BACKUP_VERSION) {
    throw new Error(
      `kopija je iz novije verzije (v${parsed.backupVersion}) — ažuriraj ekstenziju pa pokušaj ponovo`,
    );
  }

  const incoming = parsed.data || {};
  // Only known keys. A file with an extra key is not an error, but that key is
  // not written -- storage is not a dumping ground for whatever was in the file.
  const patch = {};
  const skipped = [];
  for (const [key, value] of Object.entries(incoming)) {
    if (key in DEFAULTS) patch[key] = value;
    else skipped.push(key);
  }
  if (!Object.keys(patch).length) throw new Error("kopija ne sadrži nijedno poznato podešavanje");

  if (mode === "replace") {
    await chrome.storage.local.clear();
  }
  await chrome.storage.local.set(patch);

  return {
    applied: Object.keys(patch),
    skipped,
    restoredSecrets: SECRET_KEYS.filter((k) => k in patch),
  };
}
