// Update checking against the public repository.
//
// The extension CANNOT update itself. An unpacked extension has no write access
// to its own directory, and Chrome offers no API for it -- so what happens here
// is detection and guidance only: read the version this build carries, read the
// version the repository carries, and if they differ, tell the user exactly what
// to run. `update.bat` does the actual pull.
//
// Settings are never at risk during an update. chrome.storage.local belongs to
// the extension ID, not to the files, and `git pull` does not touch it -- so
// credentials, skills and the house style survive on their own. backup.js exists
// for the cases git cannot cover (a fresh machine, a folder someone deleted).

const RAW = "https://raw.githubusercontent.com";
const API = "https://api.github.com";

// A check that blocks the UI for 30s is worse than no check at all.
const TIMEOUT_MS = 8000;

export class UpdateError extends Error {
  constructor(message) { super(message); this.name = "UpdateError"; }
}

/** "1.2.10" -> [1, 2, 10]. Missing parts are 0, junk is 0 -- a malformed
 *  version must not throw in the middle of a background check. */
function parts(v) {
  return String(v || "0").split(".").map((n) => parseInt(n, 10) || 0);
}

/** -1 / 0 / 1, comparing numerically so 1.0.10 beats 1.0.9 (string compare
 *  would say the opposite, which is the classic version-check bug). */
export function compareVersions(a, b) {
  const A = parts(a);
  const B = parts(b);
  const len = Math.max(A.length, B.length);
  for (let i = 0; i < len; i++) {
    const x = A[i] || 0;
    const y = B[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

async function getJson(url, { accept = "application/json" } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctrl.signal, headers: { Accept: accept } });
    if (!resp.ok) {
      // 404 on the raw manifest usually means the repo is private or the branch
      // name is wrong -- both are configuration, not "no update available".
      const hint = resp.status === 404
        ? " (repo je privatan, ili su naziv/grana pogrešni)"
        : resp.status === 403 ? " (GitHub je privremeno odbio zahtev — probaj kasnije)" : "";
      throw new UpdateError(`GitHub -> HTTP ${resp.status}${hint}`);
    }
    return resp.json();
  } catch (e) {
    if (e instanceof UpdateError) throw e;
    throw new UpdateError(
      e.name === "AbortError" ? "provera verzije je istekla" : `provera verzije nije uspela: ${e.name}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** The version this running build carries. Single source of truth: the same
 *  manifest Chrome loaded, so it can never disagree with what is installed. */
export function currentVersion() {
  try {
    return chrome.runtime.getManifest().version || "0";
  } catch {
    return "0";
  }
}

/**
 * Ask the repository what version it is on.
 *
 * @param repo  "owner/name"
 * @param branch default branch to read
 * @returns {current, latest, hasUpdate, behind, commit, compareUrl}
 */
export async function checkForUpdate(repo, branch = "main") {
  const slug = String(repo || "").trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/+$/, "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(slug)) {
    throw new UpdateError('repo mora biti u obliku "korisnik/repozitorijum"');
  }

  const current = currentVersion();
  // Cache-busted: raw.githubusercontent caches aggressively, and a check that
  // keeps reporting the version from five minutes ago is worse than none.
  const manifest = await getJson(`${RAW}/${slug}/${branch}/manifest.json?t=${Date.now()}`, {
    accept: "application/vnd.github.raw",
  });
  const latest = String(manifest?.version || "0");

  let commit = null;
  try {
    const commits = await getJson(`${API}/repos/${slug}/commits?sha=${encodeURIComponent(branch)}&per_page=1`);
    const c = commits?.[0];
    if (c) {
      commit = {
        sha: String(c.sha || "").slice(0, 7),
        message: String(c.commit?.message || "").split("\n")[0],
        date: c.commit?.author?.date || null,
      };
    }
  } catch {
    // The commit line is decoration. A rate-limited API must not turn a
    // successful version check into a failure.
  }

  const cmp = compareVersions(current, latest);
  return {
    current,
    latest,
    hasUpdate: cmp < 0,
    // Newer locally than the repo: normal while developing, and it must NOT be
    // reported as "up to date" -- it means this build is not what is published.
    ahead: cmp > 0,
    commit,
    repoUrl: `https://github.com/${slug}`,
    compareUrl: `https://github.com/${slug}/compare/v${current}...${branch}`,
  };
}
