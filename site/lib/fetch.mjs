// Fetch the conformance results history from GitHub at build time.
//
// Lists the commits that touched results/, finds which target JSON files each
// commit changed, fetches those files at that ref from the raw CDN, and scores
// each into a snapshot. The commits API is the only rate-limited surface (one
// call to list, one per commit for its file list); the raw file fetches go
// through the CDN and don't count against the API limit. A GITHUB_TOKEN lifts
// the API limit but isn't required for the handful of calls involved.
//
// DynamoDB is deliberately never fetched: its row is synthesised as a 100%
// baseline per run in lib/history.mjs, so a real dynamodb.json would only
// mislead if scored as an emulator.

import { scoreEmulator, breakdownOf, areaTallies, capabilityTallies } from "./scoring.mjs";
import { findingsOf, unansweredOf } from "./findings.mjs";
import { GROUND_TRUTH_SLUG, isTargetResultFile } from "dynamodb-conformance/scripts/lib/score.mjs";

const OWNER = "paritysuite";
const REPO = "dynamodb-conformance";
const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";

function fetchWithTimeout(url, { headers, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { headers, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader.split(",").find((part) => part.includes('rel="next"'));
  return match ? match.slice(match.indexOf("<") + 1, match.indexOf(">")) : null;
}

// Run fn over items with bounded concurrency, so a long history doesn't fire
// hundreds of GitHub requests at once (which trips secondary rate limits).
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function fetchSnapshots({ token, timeoutMs = 8000, log = () => {}, fallbackManifest = { describes: {} } } = {}) {
  const apiHeaders = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  const api = async (url) => {
    const res = await fetchWithTimeout(url, { headers: apiHeaders, timeoutMs });
    if (!res.ok) throw new Error(`GitHub API ${res.status} for ${url}`);
    return res;
  };

  // 1. Every commit that touched results/ (paginated, capped defensively).
  const commits = [];
  let url = `${API}/repos/${OWNER}/${REPO}/commits?path=results&per_page=100`;
  for (let page = 0; url && page < 10; page++) {
    const res = await api(url);
    commits.push(...(await res.json()));
    url = parseNextLink(res.headers.get("link"));
  }
  log(`listed ${commits.length} commits touching results/`);

  // 2. Per commit, which results/<slug>.json files changed (skip dynamodb).
  // Tolerant per-request: a single failed/transient commit detail is skipped
  // rather than collapsing the whole history to the committed fallback.
  const details = (
    await mapLimit(commits, 8, async (c) => {
      try {
        const res = await api(`${API}/repos/${OWNER}/${REPO}/commits/${c.sha}`);
        return await res.json();
      } catch (err) {
        log(`skipped commit ${c.sha.slice(0, 10)} (${err.message})`);
        return null;
      }
    })
  ).filter(Boolean);

  const tasks = []; // { sha, slug }
  const seen = new Set();
  for (const detail of details) {
    const sha = detail.sha;
    for (const file of detail.files ?? []) {
      if (file.status === "removed") continue;
      const m = /^results\/(.+)\.json$/.exec(file.filename);
      if (!m) continue;
      const slug = m[1];
      // Which files in results/ are a target's run: the suite decides, so the
      // site cannot drift from it. The ground truth is synthesised (above) and
      // One predicate rather than a list of slugs remembered here. The lane
      // documents matter most: they are real Vitest results and would be
      // scored as an emulator holding a fraction of the suite.
      if (!isTargetResultFile(`${slug}.json`) || slug === GROUND_TRUTH_SLUG) continue;
      const key = `${sha}:${slug}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tasks.push({ sha, slug });
    }
  }
  log(`fetching ${tasks.length} target snapshots`);

  // 3. Fetch each changed file (+ its .version) at its ref and score it.
  // raw() never rejects: a network error or timeout yields null (that snapshot
  // is dropped) rather than failing the whole batch.
  const raw = async (sha, file) => {
    try {
      const res = await fetchWithTimeout(`${RAW}/${OWNER}/${REPO}/${sha}/${file}`, { headers: {}, timeoutMs });
      return res.ok ? await res.text() : null;
    } catch {
      return null;
    }
  };

  // The tag manifest groups each target's results by capability. Fetch the
  // current copy from the default branch; fall back to the committed snapshot
  // when offline so the capability grid still renders. The manifest is keyed by
  // (file, describe title), which is stable across runs, so the latest manifest
  // joins cleanly to historical results.
  let manifest = fallbackManifest;
  try {
    const res = await fetchWithTimeout(`${RAW}/${OWNER}/${REPO}/main/results/tag-manifest.json`, { headers: {}, timeoutMs });
    if (res.ok) {
      manifest = JSON.parse(await res.text());
      log("fetched tag-manifest");
    } else {
      log(`tag-manifest ${res.status}; using committed fallback`);
    }
  } catch (err) {
    log(`tag-manifest fetch failed (${err.message}); using committed fallback`);
  }

  const snapshots = await mapLimit(tasks, 8, async ({ sha, slug }) => {
    const body = await raw(sha, `results/${slug}.json`);
    if (!body) return null;
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return null;
    }
    const versionBody = await raw(sha, `results/${slug}.version`);
    const version = versionBody ? versionBody.trim() : "-";
    const scored = scoreEmulator(slug, parsed, version);
    return {
      ...scored,
      startTime: parsed.startTime,
      sha,
      breakdown: breakdownOf(parsed),
      areas: areaTallies(parsed),
      capabilities: capabilityTallies(parsed, manifest),
      // Per-failure records for the per-run target pages: which test, where its
      // source is, and the commit that measured it.
      findings: findingsOf(parsed, { slug, version, sha }),
      // The tests that got no answer, with the reason each one recorded, so a
      // not-scored page can say how many and why rather than print dashes.
      unanswered: unansweredOf(parsed, { slug, version, sha }),
    };
  });

  return snapshots.filter(Boolean);
}
