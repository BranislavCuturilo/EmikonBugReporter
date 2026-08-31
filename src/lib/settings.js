// One definition of what is configurable, and one place that reads it.
// Credentials live in chrome.storage.local: per-profile, never synced to a
// Google account (chrome.storage.sync would put an API token on Google's
// servers, which is not what "unesi svoj kljuc" is supposed to mean).

import { STARTER_SKILLS } from "./prompts.js";
import { PRIORITY_DEFAULT } from "./constants.js";

export const DEFAULTS = {
  helpdeskUrl: "https://tiket.emikon.rs",
  helpdeskToken: "",
  geminiKey: "",
  geminiModel: "gemini-flash-latest",
  defaultModule: "",
  defaultCategory: "",
  defaultPriority: PRIORITY_DEFAULT,
  assignToMe: true,
  identitySelector: "",
  // "" means "use the shipped DEFAULT_HOUSE_STYLE". Storing the default text
  // itself would freeze it: a later improvement to the baseline would never
  // reach anyone who had merely opened the Options page once.
  houseStyle: "",
  skills: null,   // null = never initialised; [] = user deleted them all

  // Where updates are checked. "owner/name" -- the public repository the
  // installer cloned from. Empty means update checking is simply off, which is
  // a valid state and must never be reported as "you are up to date".
  repo: "BranislavCuturilo/EmikonBugReporter",
  repoBranch: "main",
  autoCheckUpdates: true,
  lastUpdateCheck: 0,
  lastSeenVersion: "",
};

export async function loadSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const s = { ...DEFAULTS, ...stored };
  // Seeded only on the FIRST load. An empty array is a deliberate state and is
  // left alone -- re-seeding it would resurrect skills the user deleted.
  if (s.skills === null || s.skills === undefined) {
    s.skills = STARTER_SKILLS.map((x) => ({ ...x }));
  }
  return s;
}

export async function saveSettings(patch) {
  await chrome.storage.local.set(patch);
}

/** What is still missing before the extension can do its job, as readable
 *  Serbian. Empty array means ready. Every surface asks this before it offers
 *  a button that would fail. */
export function missingSetup(settings) {
  const gaps = [];
  if (!settings.helpdeskUrl) gaps.push("URL helpdesk-a");
  if (!settings.helpdeskToken) gaps.push("API token helpdesk-a");
  if (!settings.geminiKey) gaps.push("Gemini API ključ");
  return gaps;
}
