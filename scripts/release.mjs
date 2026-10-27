// Cut a release: bump the manifests, date the changelog, and hand the workflow
// the notes to tag with.
//
// The board measures the most recent release tag, so a release is what moves
// the published denominator and the dated changelog entry is what explains the
// move. That makes the cut load-bearing rather than ceremonial, and the four
// steps it used to be - bump, date, tag, write the release body - had no
// ordering beyond whatever the person remembered.
//
// The mechanics live here rather than inline in the workflow because the
// changelog rewrite is a text transform on a file whose exact shape is
// load-bearing for site/lib/changelog.mjs, and pinning that in a unit test is
// much cheaper than discovering it from a bad release. The workflow is the thin
// wrapper that runs this with credentials and does the git and GitHub work.
//
// Every precondition refuses loudly. A cut is cheap to retry and expensive to
// undo: a tag is what the board measures for the next three hours, so a warning
// nobody reads would be a warning that publishes.
//
// The two GitHub-side preconditions - the checks on the head commit, and
// whether a draft is already open - are pure functions over data the workflow
// fetches, so the rules are testable without the API.

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { releaseTagParts } from './resolve-measured-ref.mjs'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

// Any `## …` heading is an entry boundary, and the pending spellings the site
// parser accepts. Both are deliberately the same shapes site/lib/changelog.mjs
// reads: a release that dated a heading the site cannot parse would take the
// deploy down on the commit that introduced it, because deploy.yml sets
// FAIL_ON_FALLBACK unconditionally.
const HEADING = /^## +(.+?)\s*$/gm
const UNRELEASED = /^\[?unreleased\]?\b/i

// A version is whatever makes a tag the board can choose to measure, asked of
// the resolver rather than restated here. The two drifting apart would let a
// release cut a tag no measurement run would ever resolve to.
const parts = (version) => releaseTagParts(`v${String(version).trim()}`)

/**
 * The version is a shape the tag convention and the changelog heading can both
 * carry. `v3.2.0` and `3.2.0-rc1` are refused rather than normalised: the tag
 * is `v` plus this string, and scripts/resolve-measured-ref.mjs only reads
 * exactly `vMAJOR.MINOR.PATCH`, so anything else produces a tag the board can
 * never choose to measure.
 */
export function assertVersionShape(version) {
  if (parts(version) === null) {
    throw new Error(
      `refusing to release "${version}": a version is exactly MAJOR.MINOR.PATCH, with no leading v and no prerelease suffix.`,
    )
  }
  return String(version).trim()
}

/** The version is above the one the tree currently carries. */
export function assertAhead(version, current) {
  const a = parts(assertVersionShape(version))
  const b = parts(current)
  if (b === null) throw new Error(`package.json carries no readable version ("${current}")`)
  const ahead = a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
  if (ahead <= 0) {
    throw new Error(
      `refusing to release ${version}: package.json is already at ${current}, and a release only ever moves forward.`,
    )
  }
  return version
}

/** No tag claims this version yet. */
export function assertUntagged(version, tags = []) {
  const tag = `v${assertVersionShape(version)}`
  if (tags.map((t) => String(t).trim()).includes(tag)) {
    throw new Error(
      `refusing to release ${version}: ${tag} already exists. A bad release needs a new version, not a moved tag - the board measures tags by name, and re-cutting one would regrade a board that was published before it moved.`,
    )
  }
  return version
}

/**
 * The cut runs from main.
 *
 * A tag cut off a branch would pin the board to a tree no pull request gated,
 * and the rulesets that make a merge trustworthy all scope to the default
 * branch.
 */
export function assertOnMain(ref) {
  if (String(ref).trim() !== 'main') {
    throw new Error(
      `refusing to release from "${ref}": a release is cut from main, which is the only branch the rulesets gate.`,
    )
  }
  return ref
}

/**
 * Every check on the head commit finished and none failed.
 *
 * A check still running is refused as firmly as a failing one: the tagged tree
 * is what gets measured, and a cut that outruns its own gate tags a tree
 * nothing has vouched for.
 */
export function assertChecksGreen(checkRuns = []) {
  if (checkRuns.length === 0) {
    throw new Error(
      'refusing to release: the head commit reports no checks at all. Either the gate has not started or it is not wired to this commit; neither is a tree to tag.',
    )
  }
  const pending = checkRuns.filter((c) => c.status !== 'completed').map((c) => c.name)
  // `skipped` and `neutral` are outcomes a green gate legitimately produces -
  // conformance.yml itself skips its target jobs on a merge that touched
  // nothing in tests/ - so only an actual bad conclusion counts as red.
  const failed = checkRuns
    .filter((c) => c.status === 'completed' && !['success', 'skipped', 'neutral'].includes(c.conclusion))
    .map((c) => `${c.name} (${c.conclusion})`)

  if (pending.length > 0 || failed.length > 0) {
    const detail = [
      failed.length > 0 ? `failing: ${failed.join(', ')}` : null,
      pending.length > 0 ? `still running: ${pending.join(', ')}` : null,
    ]
      .filter(Boolean)
      .join('; ')
    throw new Error(`refusing to release: the head commit's checks are not green - ${detail}.`)
  }
  return checkRuns
}

/**
 * No draft release is open.
 *
 * Every other precondition passes for 3.2.1 while 3.2.0's draft is still open
 * and its measurement still running: 3.2.1 is untagged, and it is ahead of
 * package.json, which this workflow itself just set to 3.2.0. Two measurement
 * runs would then finish in an order nothing guarantees, both committing
 * results/ from jobs on main, and the board would carry whichever landed last.
 * The failure is confusing rather than destructive, which is the kind that goes
 * undiagnosed.
 */
export function assertNoOpenDraft(releases = []) {
  const open = releases.filter((r) => r.draft).map((r) => r.tag_name)
  if (open.length > 0) {
    throw new Error(
      `refusing to release: ${open.join(', ')} ${open.length === 1 ? 'is' : 'are'} still a draft, so a measurement is in flight. Wait for its board to land - a full run takes about three hours - or delete the draft and its tag if that cut is being abandoned.`,
    )
  }
  return releases
}

/**
 * Date the pending changelog section, and hand back the notes to release with.
 *
 * Returns `{ changelog, notes }`. A bodyless `## Unreleased` is left at the top:
 * site/lib/changelog.mjs documents that as the standing state between releases,
 * it reads as no pending section, and it is where the next branch writes.
 */
export function cutRelease(text, { version, date } = {}) {
  assertVersionShape(version)
  if (!ISO_DATE.test(String(date))) {
    throw new Error(`refusing to release: "${date}" is not a YYYY-MM-DD date.`)
  }

  const { pending, blockEnd } = pendingSections(text)
  if (pending.length === 0) {
    throw new Error(
      'refusing to release: CHANGELOG.md has no `## Unreleased` section, so there are no notes this release would date.',
    )
  }

  // Two pending sections is the expected case, not a malformed file: branches
  // write their notes as they merge, so a release week can land several. The
  // site parser appends them for the same reason, and a release that dated the
  // first and stranded the second would lose a note nothing else records.
  const notes = notesOf(text, pending, blockEnd)
  if (notes === '') {
    throw new Error(
      'refusing to release: the `## Unreleased` section is empty, so there is nothing to release. A release dates notes; it does not invent them.',
    )
  }

  const [first] = pending
  let out = text.slice(0, first.start)
  out += `## Unreleased\n\n## ${date} (${version})\n\n${notes}\n\n`
  let cursor = blockEnd(first.i)
  for (const h of pending.slice(1)) {
    out += text.slice(cursor, h.start)
    cursor = blockEnd(h.i)
  }
  out += text.slice(cursor)

  return { changelog: out.replace(/\n+$/, '\n'), notes }
}

// The `## Unreleased` sections and where each one ends. Shared by the cut and
// by the weekly decision, so "there is something to release" means exactly
// what the cut will date.
function pendingSections(text) {
  const headings = []
  let m
  HEADING.lastIndex = 0
  while ((m = HEADING.exec(text)) !== null) {
    headings.push({ text: m[1], start: m.index, end: HEADING.lastIndex })
  }
  const blockEnd = (i) => (i + 1 < headings.length ? headings[i + 1].start : text.length)
  const pending = headings
    .map((h, i) => ({ ...h, i }))
    .filter((h) => UNRELEASED.test(h.text))
  return { pending, blockEnd }
}

function notesOf(text, pending, blockEnd) {
  return pending
    .map((h) => text.slice(h.end, blockEnd(h.i)).trim())
    .filter((body) => body !== '')
    .join('\n\n')
}

/**
 * Whether the changelog holds notes a cut would date. The bodyless
 * `## Unreleased` left between releases is no notes, so a week with nothing
 * merged is measured without cutting anything.
 */
export function hasPendingNotes(text) {
  const { pending, blockEnd } = pendingSections(text)
  return notesOf(text, pending, blockEnd) !== ''
}

// The paths whose change moves a measurement: the assertions, the harness that
// drives them, and the config a run is made under. The same set conformance.yml
// keys its push-time refresh on.
const SUITE_PATH = /^(tests|src)\/|^vitest\.config\.ts$/

/**
 * The version a scheduled cut takes. A change to the suite moves the
 * denominator, so it is a minor; anything else (registry rows, docs, tooling)
 * is a patch. A major is never picked here: it is a person's call, made by
 * dispatching with a version.
 */
export function nextVersion(current, changedPaths = []) {
  const [major, minor, patch] = parts(assertVersionShape(current))
  return changedPaths.some((path) => SUITE_PATH.test(path))
    ? `${major}.${minor + 1}.0`
    : `${major}.${minor}.${patch + 1}`
}

/**
 * Move both manifests to the new version.
 *
 * Structurally, on the two fields that describe this package, rather than by
 * substituting the old version string: package-lock.json currently pins
 * junk@3.1.0 while the suite is at 3.1.0, so a text replace would rewrite an
 * unrelated dependency and leave a lockfile that no longer describes what npm
 * resolves. Re-serialised at npm's two-space indent with a trailing newline, so
 * the diff is the two lines that moved.
 */
export function bumpManifests(pkgText, lockText, version) {
  assertVersionShape(version)
  const pkg = JSON.parse(pkgText)
  const lock = JSON.parse(lockText)

  pkg.version = version
  lock.version = version
  if (lock.packages?.['']) lock.packages[''].version = version

  return {
    pkg: JSON.stringify(pkg, null, 2) + '\n',
    lock: JSON.stringify(lock, null, 2) + '\n',
  }
}

/**
 * The lockfile moved with package.json.
 *
 * Read back off disk after the write rather than trusted from the transform,
 * because the tagged tree is what gets measured and a lockfile left behind
 * surfaces three hours later as a draft that never flips.
 */
export function assertLockMatches(pkg, lock) {
  if (lock.version !== pkg.version) {
    throw new Error(
      `refusing to release: package-lock.json is at ${lock.version} while package.json is at ${pkg.version}. The two move together or the tagged tree does not install.`,
    )
  }
  const root = lock.packages?.['']?.version
  if (root !== pkg.version) {
    throw new Error(
      `refusing to release: package-lock.json's packages[""] entry is at ${root} while package.json is at ${pkg.version}.`,
    )
  }
  return lock
}

/**
 * The suite version a committed board says measured it, or null when it says
 * nothing readable.
 *
 * Null rather than a throw on every unreadable shape. A board written before
 * the block existed is a real state between deploys, and so is a board whose
 * block a future change gets wrong; neither is a reason to take down the
 * workflow that flips a draft, because a flip that does not happen leaves a
 * legible state and a crash leaves a red run nobody reads.
 *
 * Only a tag-measured board names a release. summarise.mjs already refuses to
 * publish anything else, so this should never see one - but the version stamp
 * is read from package.json at the measured ref, so a board measured at a
 * commit past v3.1.0 reports 3.1.0 while being neither that tag nor a release.
 * Flipping a draft on that would publish notes describing a suite the board
 * did not measure.
 */
export function measuredVersionOf(summary) {
  const suite = summary?.suite
  if (suite?.kind !== 'tag') return null
  const version = suite.version
  return typeof version === 'string' && parts(version) !== null ? version.trim() : null
}

/**
 * The open draft to publish for a measured version, or null when there is
 * nothing to do.
 *
 * Nothing to do is the normal case, not an error: a scheduled re-measure of an
 * already-published release lands a board every week, and the flip has to pass
 * over it silently rather than churn the release or fail.
 */
export function draftToPublish(version, releases = []) {
  if (version === null || version === undefined) return null
  return releases.find((r) => r.tag_name === `v${version}` && r.draft) ?? null
}

function cut() {
  const version = assertVersionShape(process.env.VERSION ?? '')
  assertOnMain(process.env.GITHUB_REF_NAME ?? '')

  // Fetched by the workflow, which holds the token. Read as files so the rules
  // above stay pure and the API shapes stay pinned in one place.
  const json = (path) => JSON.parse(readFileSync(path, 'utf8'))
  assertChecksGreen(json(process.env.CHECKS_JSON).check_runs ?? [])
  assertNoOpenDraft(json(process.env.RELEASES_JSON))

  const pkgText = readFileSync('package.json', 'utf8')
  assertAhead(version, JSON.parse(pkgText).version)
  assertUntagged(
    version,
    (process.env.TAGS ?? '').split('\n').filter((t) => t.trim() !== ''),
  )

  const { changelog, notes } = cutRelease(readFileSync('CHANGELOG.md', 'utf8'), {
    version,
    // The date the cut runs, in UTC, matching every other date this repo
    // publishes. A runner's local zone is UTC anyway; saying so keeps it true
    // if that ever stops being the case.
    date: new Date().toISOString().slice(0, 10),
  })

  const bumped = bumpManifests(pkgText, readFileSync('package-lock.json', 'utf8'), version)
  writeFileSync('package.json', bumped.pkg)
  writeFileSync('package-lock.json', bumped.lock)
  writeFileSync('CHANGELOG.md', changelog)
  assertLockMatches(JSON.parse(readFileSync('package.json', 'utf8')), JSON.parse(readFileSync('package-lock.json', 'utf8')))

  // The body the release is created with, cut from the changelog in the state
  // the tag captures rather than reassembled later from a file that has moved
  // on during the three hours the measurement takes.
  writeFileSync(process.env.NOTES_OUT ?? 'release-notes.md', notes.trim() + '\n')

  console.log(`Cut ${version}: manifests bumped, changelog dated, notes written.`)
  return 0
}

/**
 * Decide whether the board just committed finishes a release, and name the tag
 * if it does.
 *
 * Keyed off the board rather than off the workflow that wrote it, because two
 * workflows commit results/summary.json: results-table.yml and the sweep's
 * rebuild. Watching one caller's workflow_run would miss a board the other
 * wrote.
 *
 * The sweep's rebuild carries the committed board's identity forward and never
 * re-measures, so it can only re-land a version results-table.yml has already
 * committed. That makes it a second chance at a flip that did not happen, not a
 * second way for a new version to arrive.
 */
function flip() {
  const version = measuredVersionOf(JSON.parse(readFileSync('results/summary.json', 'utf8')))
  if (version === null) {
    console.log('The committed board names no suite version. Nothing to publish.')
    return 0
  }

  const draft = draftToPublish(version, JSON.parse(readFileSync(process.env.RELEASES_JSON, 'utf8')))
  if (draft === null) {
    console.log(`No open draft for v${version}. Nothing to publish.`)
    return 0
  }

  const out = process.env.GITHUB_OUTPUT
  if (out) appendFileSync(out, `tag=v${version}\n`)
  console.log(`v${version} has an open draft and its board has landed. Publishing.`)
  return 0
}

/**
 * What this run of release.yml does. A dispatch cuts the version it was given,
 * as it always has. The weekly schedule cuts only when `## Unreleased` holds
 * notes, picking the version by nextVersion() from what changed since the tag
 * the tree carries; otherwise it hands the week to a plain measurement of the
 * latest release.
 *
 * Returns `{ mode: 'cut' | 'measure', version }`, with version null when
 * measuring.
 */
export function planRun({ event, inputVersion, changelog, packageVersion, changed = [] }) {
  if (event !== 'schedule') return { mode: 'cut', version: inputVersion ?? '' }
  if (!hasPendingNotes(changelog)) return { mode: 'measure', version: null }
  return { mode: 'cut', version: nextVersion(packageVersion, changed) }
}

function plan() {
  const decision = planRun({
    event: process.env.EVENT,
    inputVersion: process.env.INPUT_VERSION,
    changelog: readFileSync('CHANGELOG.md', 'utf8'),
    packageVersion: JSON.parse(readFileSync('package.json', 'utf8')).version,
    changed: (process.env.CHANGED ?? '').split('\n').filter((p) => p.trim() !== ''),
  })

  const out = process.env.GITHUB_OUTPUT
  if (out) {
    appendFileSync(out, `mode=${decision.mode}\n`)
    if (decision.version !== null) appendFileSync(out, `version=${decision.version}\n`)
  }
  console.log(
    decision.mode === 'measure'
      ? 'No notes under `## Unreleased`: measuring the latest release without cutting one.'
      : `Cutting ${decision.version}.`,
  )
  return 0
}

const MODES = { cut, flip, plan }

function main() {
  const mode = MODES[process.argv[2]]
  if (mode === undefined) {
    console.error(`usage: node scripts/release.mjs <${Object.keys(MODES).join('|')}>`)
    return 2
  }
  return mode()
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main())
