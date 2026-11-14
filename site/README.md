# Parity Suite (paritysuite.org)

The site behind [paritysuite.org](https://paritysuite.org): how faithfully each DynamoDB emulator matches the real thing, scored against live AWS DynamoDB and tracked run over run. The site is branded **Parity Suite**; the test suite it renders lives in the same repository, one directory up.

The suite publishes its latest results as a markdown table in the root README, which is fine for a single snapshot but can't show history, movement, or per-target detail. This site reads the results out of the repository's git history and tells the fuller story: current standings with up/down movement, a page per target with its score over time, and a browsable archive of every past run.

One rule holds the whole thing together: **every figure is derived from `results/*.json` at build time, never hand-authored.** Hardcoding the same numbers in more than one place is exactly how conformance figures drift apart, so there's a single data seam and everything renders from it.

The scoring is shared with the suite rather than copied from it. The target maps, display names, project links, tier classification, pass-rate arithmetic and the tallying itself are imported from `scripts/summarise.mjs` and `scripts/lib/score.mjs`, so adding a target happens once and a test the suite counts one way can't be counted another way here. `AGENTS.md` at the repository root covers the architecture in full, including the invariants worth reading before changing anything.

## Stack

Eleventy v3 with WebC, Tailwind v4 via the standalone CLI, no client-side framework. Charts are inline SVG generated at build time. It deploys as a fully static site to S3 + CloudFront. Node 24.

## Develop

Run these from the repository root, not from `site/`:

```bash
npm install
# Serves at http://localhost:8080 with CSS + 11ty watching.
npm run site:dev
# Writes the static site to site/_site/.
npm run site:build
# The scoring, history and rendering unit tests.
npm run site:test
# Build with the network stubbed, then assert on the built HTML.
npm run site:check-build
```

## How the data gets here

At build time, `src/_data/conformance.js` reconstructs the full timeline:

1. List the commits that touched `results/` (GitHub commits API).
2. Fetch each target's `results/<target>.json` and `.version` at the commits where it changed (raw GitHub, no API limit).
3. Score each snapshot with `lib/scoring.mjs`, which tallies through the suite's own classifier and maps.
4. Group the snapshots into runs by their `startTime` (a single commit often refreshes only some targets, and one commit can carry targets from different runs, so grouping by commit would invent runs that never happened), then derive per-target series, the latest standings, and run-over-run movement.

Those fetches still go over the network even though the files now sit in the same tree. Replacing them with local `git log` reads is follow-up work rather than an oversight, and it will retire the fallbacks below along with it.

If a fetch fails or runs unauthenticated, the build falls back to the committed snapshot at `data/conformance-history.json` and still renders. That keeps builds green offline and in CI without a token, at the cost of the data being as fresh as the last refresh. Setting `FAIL_ON_FALLBACK=1` turns that fallback into an error instead, which is what the deploy does: both S3 syncs carry `--delete`, so shipping a fallback-derived build would quietly remove the newest per-run pages from the bucket.

### Refreshing the fallback snapshot

The committed fallback is the derived model, not raw API responses. Regenerate it whenever the upstream history has meaningfully moved:

```bash
# Re-fetches the history and rewrites data/conformance-history.json.
npm run site:snapshot
```

A `GITHUB_TOKEN` in the environment lifts the commits-API rate limit; it's optional locally and supplied automatically in CI.

## Deploy

`.github/workflows/deploy.yml` builds and deploys to S3 + CloudFront over OIDC (no static keys) on a push to `main` that touches `site/`, `results/`, `registry/` or `CHANGELOG.md`. A daily scheduled run re-fetches the latest results and skips the sync entirely when the derived history hasn't moved, and `workflow_dispatch` triggers a build on demand. The infrastructure is a separate CDK stack, not in this repository.
