import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { load as loadYaml } from 'js-yaml'
import { parseChangelog } from '../site/lib/changelog.mjs'
import {
  assertAhead,
  assertChecksGreen,
  assertLockMatches,
  assertNoOpenDraft,
  assertOnMain,
  assertUntagged,
  assertVersionShape,
  bumpManifests,
  cutRelease,
  draftToPublish,
  hasPendingNotes,
  measuredVersionOf,
  nextVersion,
  planRun,
} from './release.mjs'

const PREAMBLE = `# Conformance suite history

A dated log of how the suite has grown. Newest first.

`

const changelog = (...sections) => PREAMBLE + sections.join('\n')

const UNRELEASED = `## Unreleased

A split row is re-characterised against a 34-region capture.

The matching validation-ordering row is retired.

`

const DATED = `## 2026-08-15 (3.1.0)

ExtendDB's SQLite backend joins the run.
`

describe('cutRelease', () => {
  it('dates the Unreleased section and leaves its body untouched', () => {
    const { changelog: out } = cutRelease(changelog(UNRELEASED, DATED), {
      version: '3.2.0',
      date: '2026-08-18',
    })

    expect(out).toContain('## 2026-08-18 (3.2.0)')
    expect(out).toContain('A split row is re-characterised against a 34-region capture.')
    expect(out).toContain('The matching validation-ordering row is retired.')
    // The dated section sits above the previous release, not below it: the file
    // is newest-first and a release that appended would invert it.
    expect(out.indexOf('## 2026-08-18 (3.2.0)')).toBeLessThan(out.indexOf('## 2026-08-15 (3.1.0)'))
    // And the release before it is carried through whole.
    expect(out).toContain(DATED.trim())
  })

  it('leaves exactly one Unreleased heading behind, with no body', () => {
    // site/lib/changelog.mjs documents a bodyless `## Unreleased` as the
    // standing state between releases, and it is where the next branch writes.
    // A second one would be two pending sections; none at all would make the
    // next contributor invent the heading.
    const { changelog: out } = cutRelease(changelog(UNRELEASED, DATED), {
      version: '3.2.0',
      date: '2026-08-18',
    })

    expect(out.match(/^## Unreleased$/gm)).toHaveLength(1)
    expect(parseChangelog(out).unreleased).toBeNull()
  })

  it('produces a file the site parser reads as one more dated entry', () => {
    const { changelog: out } = cutRelease(changelog(UNRELEASED, DATED), {
      version: '3.2.0',
      date: '2026-08-18',
    })
    const parsed = parseChangelog(out)

    expect(parsed.skipped).toEqual([])
    expect(parsed.entries.map((e) => [e.date, e.version])).toEqual([
      ['2026-08-18', '3.2.0'],
      ['2026-08-15', '3.1.0'],
    ])
    expect(parsed.entries[0].bodyHtml).toContain('34-region capture')
  })

  it('returns the notes as the section body, with the heading stripped', () => {
    const { notes } = cutRelease(changelog(UNRELEASED, DATED), {
      version: '3.2.0',
      date: '2026-08-18',
    })

    expect(notes).not.toContain('##')
    expect(notes.trim()).toBe(
      'A split row is re-characterised against a 34-region capture.\n\nThe matching validation-ordering row is retired.',
    )
  })

  it('merges two Unreleased sections into one dated entry', () => {
    // The parser tolerates two because a merge landing two is the expected
    // case, so the release has to fold them rather than date the first and
    // strand the second.
    const second = `## Unreleased

A second branch wrote its note ahead of the cut.

`
    const { changelog: out, notes } = cutRelease(changelog(UNRELEASED, second, DATED), {
      version: '3.2.0',
      date: '2026-08-18',
    })

    expect(out.match(/^## Unreleased$/gm)).toHaveLength(1)
    expect(out.match(/^## 2026-08-18 \(3\.2\.0\)$/gm)).toHaveLength(1)
    expect(notes).toContain('34-region capture')
    expect(notes).toContain('A second branch wrote its note ahead of the cut.')
    expect(parseChangelog(out).unreleased).toBeNull()
  })

  it('accepts the bracketed Keep a Changelog spelling the parser accepts', () => {
    const bracketed = UNRELEASED.replace('## Unreleased', '## [Unreleased]')
    const { changelog: out } = cutRelease(changelog(bracketed, DATED), {
      version: '3.2.0',
      date: '2026-08-18',
    })

    expect(out).toContain('## 2026-08-18 (3.2.0)')
    expect(parseChangelog(out).unreleased).toBeNull()
  })

  it('refuses a changelog with no Unreleased section', () => {
    expect(() => cutRelease(changelog(DATED), { version: '3.2.0', date: '2026-08-18' })).toThrow(
      /no `## Unreleased` section/,
    )
  })

  it('refuses an empty Unreleased section, because there is nothing to release', () => {
    expect(() =>
      cutRelease(changelog('## Unreleased\n\n', DATED), { version: '3.2.0', date: '2026-08-18' }),
    ).toThrow(/nothing to release/)
  })

  it('refuses a version or date it cannot write into a heading', () => {
    const body = changelog(UNRELEASED, DATED)
    expect(() => cutRelease(body, { version: 'v3.2.0', date: '2026-08-18' })).toThrow(/3\.2\.0/)
    expect(() => cutRelease(body, { version: '3.2.0', date: '18-08-2026' })).toThrow(/YYYY-MM-DD/)
  })
})

describe('bumpManifests', () => {
  const pkg = JSON.stringify({ name: 'dynamodb-conformance', version: '3.1.0' }, null, 2) + '\n'
  const lock =
    JSON.stringify(
      {
        name: 'dynamodb-conformance',
        version: '3.1.0',
        lockfileVersion: 3,
        packages: {
          '': { name: 'dynamodb-conformance', version: '3.1.0' },
          'node_modules/junk': { version: '3.1.0', license: 'MIT' },
        },
      },
      null,
      2,
    ) + '\n'

  it('moves both manifests to the new version', () => {
    const out = bumpManifests(pkg, lock, '3.2.0')

    expect(JSON.parse(out.pkg).version).toBe('3.2.0')
    expect(JSON.parse(out.lock).version).toBe('3.2.0')
    expect(JSON.parse(out.lock).packages[''].version).toBe('3.2.0')
  })

  it('does not touch a dependency that happens to share the old version', () => {
    // package-lock.json carries junk@3.1.0 while the suite is at 3.1.0, so a
    // text substitution would rewrite an unrelated dependency's pin and the
    // lockfile would no longer describe what npm resolves.
    const out = bumpManifests(pkg, lock, '3.2.0')

    expect(JSON.parse(out.lock).packages['node_modules/junk'].version).toBe('3.1.0')
  })

  it('keeps the two-space formatting and trailing newline npm writes', () => {
    const out = bumpManifests(pkg, lock, '3.2.0')

    expect(out.pkg.endsWith('\n')).toBe(true)
    expect(out.lock.endsWith('\n')).toBe(true)
    expect(out.pkg).toContain('\n  "version": "3.2.0"')
  })
})

describe('assertLockMatches', () => {
  it('accepts a lockfile that moved with package.json', () => {
    expect(() =>
      assertLockMatches({ version: '3.2.0' }, { version: '3.2.0', packages: { '': { version: '3.2.0' } } }),
    ).not.toThrow()
  })

  it('refuses a lockfile left behind', () => {
    expect(() =>
      assertLockMatches({ version: '3.2.0' }, { version: '3.1.0', packages: { '': { version: '3.1.0' } } }),
    ).toThrow(/package-lock\.json/)
  })

  it('refuses a lockfile whose root package entry was missed', () => {
    expect(() =>
      assertLockMatches({ version: '3.2.0' }, { version: '3.2.0', packages: { '': { version: '3.1.0' } } }),
    ).toThrow(/packages\[""\]/)
  })
})

describe('assertVersionShape', () => {
  it('accepts a bare semver', () => {
    expect(() => assertVersionShape('3.2.0')).not.toThrow()
    expect(() => assertVersionShape('3.10.12')).not.toThrow()
  })

  it('refuses anything the tag and heading conventions cannot carry', () => {
    // The tag is `v` + this, and resolve-measured-ref.mjs only reads exactly
    // vMAJOR.MINOR.PATCH, so a prerelease or a `v`-prefixed input would produce
    // a tag the board can never measure.
    for (const bad of ['v3.2.0', '3.2', '3.2.0-rc1', '3.2.0.1', '']) {
      expect(() => assertVersionShape(bad), bad).toThrow(/MAJOR\.MINOR\.PATCH/)
    }
  })
})

describe('assertAhead', () => {
  it('accepts a version above the current one', () => {
    expect(() => assertAhead('3.2.0', '3.1.0')).not.toThrow()
    expect(() => assertAhead('3.10.0', '3.9.0')).not.toThrow()
    expect(() => assertAhead('4.0.0', '3.9.9')).not.toThrow()
  })

  it('refuses a version equal to or below the current one', () => {
    expect(() => assertAhead('3.1.0', '3.1.0')).toThrow(/3\.1\.0/)
    expect(() => assertAhead('3.0.9', '3.1.0')).toThrow(/3\.1\.0/)
    expect(() => assertAhead('3.9.0', '3.10.0')).toThrow(/3\.10\.0/)
  })
})

describe('assertUntagged', () => {
  it('accepts a version no tag claims', () => {
    expect(() => assertUntagged('3.2.0', ['v3.0.0', 'v3.1.0'])).not.toThrow()
  })

  it('refuses a version already tagged, naming the tag', () => {
    expect(() => assertUntagged('3.1.0', ['v3.0.0', 'v3.1.0'])).toThrow(/v3\.1\.0/)
  })
})

describe('assertOnMain', () => {
  it('accepts main', () => {
    expect(() => assertOnMain('main')).not.toThrow()
  })

  it('refuses any other ref, because a tag cut off a branch measures work no PR gated', () => {
    expect(() => assertOnMain('feat/measured-ref')).toThrow(/main/)
    expect(() => assertOnMain('')).toThrow(/main/)
  })
})

describe('assertChecksGreen', () => {
  it('accepts a commit whose checks all succeeded', () => {
    expect(() =>
      assertChecksGreen([
        { name: 'Cheap gate', status: 'completed', conclusion: 'success' },
        { name: 'Docs', status: 'completed', conclusion: 'skipped' },
      ]),
    ).not.toThrow()
  })

  it('refuses a failing check, naming it', () => {
    expect(() =>
      assertChecksGreen([
        { name: 'Cheap gate', status: 'completed', conclusion: 'success' },
        { name: 'Site tests', status: 'completed', conclusion: 'failure' },
      ]),
    ).toThrow(/Site tests/)
  })

  it('refuses a check still running, so a cut cannot outrun its own gate', () => {
    expect(() =>
      assertChecksGreen([{ name: 'Cheap gate', status: 'in_progress', conclusion: null }]),
    ).toThrow(/Cheap gate/)
  })

  it('refuses a commit with no checks at all', () => {
    expect(() => assertChecksGreen([])).toThrow(/no checks/)
  })
})

describe('assertNoOpenDraft', () => {
  it('accepts a repository whose releases are all published', () => {
    expect(() =>
      assertNoOpenDraft([
        { tag_name: 'v3.1.0', draft: false },
        { tag_name: 'v3.0.0', draft: false },
      ]),
    ).not.toThrow()
  })

  it('refuses a cut while a draft is open, naming it', () => {
    // Every other precondition passes for 3.2.1 while 3.2.0's draft is open and
    // its three-hour measurement is still running, and two measurement runs
    // would then race the board.
    expect(() =>
      assertNoOpenDraft([
        { tag_name: 'v3.2.0', draft: true },
        { tag_name: 'v3.1.0', draft: false },
      ]),
    ).toThrow(/v3\.2\.0/)
  })
})

describe('measuredVersionOf', () => {
  it('reads the version the board says measured it', () => {
    expect(measuredVersionOf({ suite: { version: '3.2.0', ref: 'v3.2.0', kind: 'tag' } })).toBe('3.2.0')
  })

  it('reads nothing from a board with no suite block, rather than throwing', () => {
    // A board written before the block existed, or one a rebuild left alone.
    // The flip is a no-op in that case; it must not take the workflow down.
    expect(measuredVersionOf({})).toBeNull()
    expect(measuredVersionOf({ suite: null })).toBeNull()
    expect(measuredVersionOf({ suite: { ref: 'v3.2.0', kind: 'tag' } })).toBeNull()
    expect(measuredVersionOf({ suite: { version: 42, kind: 'tag' } })).toBeNull()
    expect(measuredVersionOf(null)).toBeNull()
  })

  it('reads nothing from a board that measured something other than a tag', () => {
    // The version is read from package.json at the measured ref, so a board
    // measured at a commit past v3.1.0 reports 3.1.0 while being neither that
    // tag nor a release. summarise.mjs refuses to publish one, so this should
    // never arrive - but flipping on it would publish notes describing a suite
    // the board did not measure.
    expect(measuredVersionOf({ suite: { version: '3.1.0', kind: 'sha', ref: '9aa0337' } })).toBeNull()
    expect(measuredVersionOf({ suite: { version: '3.1.0', kind: 'other', ref: 'main' } })).toBeNull()
  })
})

describe('draftToPublish', () => {
  const releases = [
    { id: 1, tag_name: 'v3.2.0', draft: true },
    { id: 2, tag_name: 'v3.1.0', draft: false },
  ]

  it('finds the open draft for the version the board measured', () => {
    expect(draftToPublish('3.2.0', releases)?.id).toBe(1)
  })

  it('is a no-op when that version is already published, so a re-measure does not churn it', () => {
    expect(draftToPublish('3.1.0', releases)).toBeNull()
  })

  it('is a no-op when no release exists for the version at all', () => {
    expect(draftToPublish('3.3.0', releases)).toBeNull()
  })

  it('is a no-op when the board names no version', () => {
    expect(draftToPublish(null, releases)).toBeNull()
  })
})

describe('hasPendingNotes', () => {
  it('finds notes under `## Unreleased`', () => {
    expect(hasPendingNotes(changelog(UNRELEASED, DATED))).toBe(true)
  })

  it('reads the bodyless heading left between releases as nothing to release', () => {
    expect(hasPendingNotes(changelog('## Unreleased\n', DATED))).toBe(false)
  })

  it('reads a changelog with no pending heading as nothing to release', () => {
    expect(hasPendingNotes(changelog(DATED))).toBe(false)
  })

  it('finds notes in a second pending section when the first is empty', () => {
    expect(hasPendingNotes(changelog('## Unreleased\n', '## Unreleased\n\nA row moves.\n', DATED))).toBe(
      true,
    )
  })

  it('agrees with the cut on what counts as notes', () => {
    // The weekly run cuts exactly when the cut would succeed on the notes.
    const empty = changelog('## Unreleased\n', DATED)
    expect(() => cutRelease(empty, { version: '9.9.9', date: '2026-10-25' })).toThrow(/empty/)
    expect(hasPendingNotes(empty)).toBe(false)
  })
})

describe('nextVersion', () => {
  it('is a patch when only registry rows, docs or tooling changed', () => {
    expect(nextVersion('3.7.0', ['registry/splits.json', 'CHANGELOG.md', 'scripts/release.mjs'])).toBe('3.7.1')
  })

  it('is a minor when the tests, the harness or the run config changed', () => {
    expect(nextVersion('3.7.1', ['tests/tier1/putItem.test.ts'])).toBe('3.8.0')
    expect(nextVersion('3.7.1', ['src/helpers.ts'])).toBe('3.8.0')
    expect(nextVersion('3.7.1', ['vitest.config.ts'])).toBe('3.8.0')
  })

  it('does not mistake a path that merely mentions tests for the suite', () => {
    expect(nextVersion('3.7.0', ['scripts/release.test.mjs', 'site/test/x.mjs'])).toBe('3.7.1')
  })

  it('is a patch when nothing changed path-wise, and never a major', () => {
    expect(nextVersion('3.7.0', [])).toBe('3.7.1')
    expect(nextVersion('3.9.4', ['tests/a.test.ts'])).toBe('3.10.0')
  })

  it('refuses a version it cannot read', () => {
    expect(() => nextVersion('v3.7.0', [])).toThrow()
  })
})

describe('planRun', () => {
  const withNotes = changelog(UNRELEASED, DATED)
  const without = changelog('## Unreleased\n', DATED)

  it('cuts the dispatched version as given, notes or not', () => {
    expect(planRun({ event: 'workflow_dispatch', inputVersion: '4.0.0', changelog: without, packageVersion: '3.7.0' })).toEqual(
      { mode: 'cut', version: '4.0.0' },
    )
  })

  it('measures without cutting on a Sunday with no notes', () => {
    expect(planRun({ event: 'schedule', changelog: without, packageVersion: '3.7.0', changed: ['tests/a.test.ts'] })).toEqual({
      mode: 'measure',
      version: null,
    })
  })

  it('cuts a patch on a Sunday with notes and no suite change', () => {
    expect(
      planRun({ event: 'schedule', changelog: withNotes, packageVersion: '3.7.0', changed: ['registry/splits.json', 'CHANGELOG.md'] }),
    ).toEqual({ mode: 'cut', version: '3.7.1' })
  })

  it('cuts a minor on a Sunday with notes and a suite change', () => {
    expect(planRun({ event: 'schedule', changelog: withNotes, packageVersion: '3.7.1', changed: ['src/helpers.ts'] })).toEqual({
      mode: 'cut',
      version: '3.8.0',
    })
  })
})

describe('release.yml', () => {
  const workflow = loadYaml(readFileSync('.github/workflows/release.yml', 'utf8'))

  it('runs on dispatch and the weekly schedule only, so a release is never a side effect of a merge', () => {
    const on = workflow.true ?? workflow.on
    expect(Object.keys(on).sort()).toEqual(['schedule', 'workflow_dispatch'])
    expect(on.schedule).toEqual([{ cron: '0 4 * * 0' }])
  })

  it('owns the weekly run: conformance.yml no longer schedules its own', () => {
    // Two Sunday crons would measure twice, the thing this design exists to
    // avoid.
    const conformance = loadYaml(readFileSync('.github/workflows/conformance.yml', 'utf8'))
    expect(Object.keys(conformance.true ?? conformance.on)).not.toContain('schedule')
    expect((conformance.true ?? conformance.on).workflow_dispatch.inputs.weekly.type).toBe('boolean')
  })

  it('turns weekly reporting on through the input, so a dispatched weekly red still files an issue', () => {
    const yamlText = readFileSync('.github/workflows/conformance.yml', 'utf8')
    expect(yamlText).not.toMatch(/failure\(\) && github\.event_name == 'schedule'/)
    expect(yamlText.match(/failure\(\) && inputs\.weekly/g)).toHaveLength(3)
  })

  it('plans from the dispatch input, and cuts the version the plan settled on', () => {
    // The plan reads the person's version on a dispatch; every step of the cut
    // reads the plan's, so a scheduled cut and a dispatched one share one path.
    const planStep = workflow.jobs.plan.steps.find((s) => s.id === 'plan')
    expect(planStep.env.INPUT_VERSION).toBe('${{ inputs.version }}')
    const cutEnvs = workflow.jobs.release.steps.filter((s) => s.env?.VERSION !== undefined)
    expect(cutEnvs.length).toBeGreaterThan(0)
    for (const step of cutEnvs) expect(step.env.VERSION).toBe('${{ needs.plan.outputs.version }}')
  })

  it('cuts only when the plan says so', () => {
    expect(workflow.jobs.release.needs).toBe('plan')
    expect(workflow.jobs.release.if).toBe("needs.plan.outputs.mode == 'cut'")
  })

  it('measures the week when the schedule did not cut, and only then', () => {
    // A cut that dispatched is the week's run; measuring again would run real
    // AWS twice. A cut that refused before dispatching must still get the week
    // measured.
    const measure = workflow.jobs.measure
    expect(measure.needs).toEqual(['plan', 'release'])
    // !cancelled(), not always(): a person cancelling the Sunday run must not
    // still start a real-AWS run.
    expect(measure.if.replace(/\s+/g, ' ').trim()).toBe(
      "!cancelled() && github.event_name == 'schedule' && " +
        "(needs.plan.result != 'success' || needs.plan.outputs.mode == 'measure' || " +
        "(needs.release.result != 'success' && needs.release.outputs.dispatched != 'true'))",
    )
    const yamlText = readFileSync('.github/workflows/release.yml', 'utf8')
    expect(yamlText).toMatch(/gh workflow run conformance\.yml -R "\$GITHUB_REPOSITORY" --ref main -f "weekly=true"/)
  })

  it('records the dispatch the moment it happens', () => {
    const yamlText = readFileSync('.github/workflows/release.yml', 'utf8')
    expect(workflow.jobs.release.outputs.dispatched).toBe('${{ steps.measure.outputs.dispatched }}')
    expect(yamlText).toMatch(/gh workflow run conformance\.yml --ref main -f "ref=v\$VERSION" -f "weekly=\$WEEKLY"\n\s*echo "dispatched=true"/)
  })

  it('confirms a dispatch only against dispatched runs, so a push run cannot stand in for it', () => {
    const yamlText = readFileSync('.github/workflows/release.yml', 'utf8')
    const lists = yamlText.match(/gh run list[^\n]*--workflow conformance\.yml[^\n]*/g) ?? []
    expect(lists.length).toBe(4)
    for (const line of lists) expect(line).toContain('--event workflow_dispatch')
  })

  it('reports a refused cut even when the fallback dispatch failed, and says when the tag was already pushed', () => {
    const report = workflow.jobs.measure.steps.find((s) => s.name === 'Report the refused cut')
    expect(report.if).toBe("${{ !cancelled() && needs.plan.outputs.mode != 'measure' }}")
    expect(report.env.PUSHED).toBe('${{ needs.release.outputs.pushed }}')
    expect(workflow.jobs.release.outputs.pushed).toBe('${{ steps.push.outputs.pushed }}')
    const push = workflow.jobs.release.steps.find((s) => s.id === 'push')
    expect(push.run).toMatch(/git push --atomic[\s\S]*echo "pushed=true"/)
  })

  it('dispatches with the App token on both paths', () => {
    expect(workflow.jobs.measure.steps[0].with['permission-actions']).toBe('write')
    expect(workflow.jobs.measure.steps[1].env.GH_TOKEN).toBe('${{ steps.dispatch-token.outputs.token }}')
  })

  it('takes the version as its only input', () => {
    const inputs = (workflow.true ?? workflow.on).workflow_dispatch.inputs
    expect(Object.keys(inputs)).toEqual(['version'])
    expect(inputs.version.required).toBe(true)
  })

  it('mints each App token with only the permission the step it feeds needs', () => {
    // Two tokens, because they are handed to different things. The first is
    // read by actions/checkout and sits beside `npm ci` on a freshly bumped
    // tree, so it stays at contents:write however much the installation
    // grants. The second is read by the dispatch and nothing else.
    //
    // create-github-app-token narrows what an installation was granted, it
    // never adds to it, so asking for a permission the App does not hold fails
    // the mint with a 422 before any other step runs - which is why a cut that
    // also asked for checks:read died at step two of twelve.
    const mints = workflow.jobs.release.steps.filter((s) =>
      (s.uses ?? '').startsWith('actions/create-github-app-token'),
    )
    expect(mints, 'release.yml no longer mints two App tokens').toHaveLength(2)
    expect(mints.map((m) => Object.keys(m.with).filter((k) => k.startsWith('permission-')))).toEqual(
      [['permission-contents'], ['permission-actions']],
    )
  })

  it('mints both tokens before anything is committed, tagged or drafted', () => {
    // A mint of a permission the installation does not hold fails outright.
    // Minted beside the dispatch, that failure would land after the bump, the
    // tag and the draft, leaving a cut only a person can finish.
    const names = workflow.jobs.release.steps.map((s) => s.name ?? s.uses)
    const lastMint = names.findLastIndex((n) => (n ?? '').startsWith('actions/create-github-app-token') || /Mint/.test(n ?? ''))
    const firstSideEffect = names.findIndex((n) => ['Commit the bump', 'Tag and push', 'Create the draft release'].includes(n))
    expect(lastMint, 'release.yml no longer mints App tokens').toBeGreaterThan(-1)
    expect(firstSideEffect, 'release.yml no longer commits, tags or drafts').toBeGreaterThan(-1)
    expect(lastMint).toBeLessThan(firstSideEffect)
  })

  it('takes what the App cannot grant from GITHUB_TOKEN instead', () => {
    // The head commit's check runs. The App has no Checks grant, and asking
    // for one fails the mint outright.
    //
    // actions is read, not write: GITHUB_TOKEN reads this run's own check
    // suite here but no longer starts the measurement. A run dispatched with
    // GITHUB_TOKEN is attributed to github-actions[bot], and a run attributed
    // that way emits no workflow_run event when it completes, so the board
    // never lands and the draft never flips.
    expect(workflow.permissions).toMatchObject({ checks: 'read', actions: 'read' })
  })

  it('confirms the measurement run actually started', () => {
    // The tag and the draft already exist by this point, so a dispatch that
    // produced no run would leave a draft that never flips - the failure this
    // whole design is most anxious about, and the one that takes three hours to
    // notice.
    const yamlText = readFileSync('.github/workflows/release.yml', 'utf8')
    expect(yamlText).toMatch(/gh run list --workflow conformance\.yml/)
    expect(yamlText).toMatch(/::error title=Measurement not started/)
  })

  it('installs against the bumped tree before anything is tagged', () => {
    // The tagged tree is measured for about three hours and no required check
    // has run against it: the checks passed on the commit before the bump, and
    // "both files moved together" is not "the result installs". Without this a
    // bad lockfile yields a tag, a draft and a run that dies at install, whose
    // first visible symptom is a draft that never flips.
    const steps = workflow.jobs.release.steps
    const at = (needle) => {
      const i = steps.findIndex((s) => JSON.stringify(s).includes(needle))
      expect(i, `release.yml has no step containing \`${needle}\``).toBeGreaterThan(-1)
      return i
    }
    // `git tag -a`, not `git tag`: the precondition step runs `git tag --list`
    // and would satisfy a looser needle from above the install.
    expect(at('npm ci')).toBeLessThan(at('git tag -a'))
  })

  it('creates an annotated tag, matching every tag the repo already carries', () => {
    const yamlText = readFileSync('.github/workflows/release.yml', 'utf8')
    expect(yamlText).toMatch(/git tag -a/)
  })

  it('creates the release as a draft and dispatches conformance at the new tag', () => {
    const yamlText = readFileSync('.github/workflows/release.yml', 'utf8')
    expect(yamlText).toMatch(/gh release create[\s\S]{0,400}--draft/)
    expect(yamlText).toMatch(/gh workflow run conformance\.yml/)
  })

  it('dispatches that run on main with the tag as an input, not on the tag ref', () => {
    // results-table.yml publishes only a conformance run whose head_branch is
    // main, and a run dispatched on a tag ref does not report main. Dispatching
    // at the tag would measure the right suite, publish nothing, and leave the
    // draft open with no failure anywhere to say why - three hours later.
    const yamlText = readFileSync('.github/workflows/release.yml', 'utf8')
    expect(yamlText).toMatch(/gh workflow run conformance\.yml --ref main -f "ref=v\$VERSION"/)

    const publisher = readFileSync('.github/workflows/results-table.yml', 'utf8')
    expect(
      publisher,
      'results-table.yml no longer gates on head_branch, so this pairing may be stale',
    ).toContain("workflow_run.head_branch == 'main'")
  })
})

describe('publish-release.yml', () => {
  const yamlText = readFileSync('.github/workflows/publish-release.yml', 'utf8')
  const workflow = loadYaml(yamlText)

  it('triggers on the board changing, not on one of the two workflows that write it', () => {
    // sweep.yml and results-table.yml both commit results/summary.json, so a
    // flip keyed to one caller's workflow_run would miss a board the other
    // wrote. The sweep can only re-land a version results-table.yml already
    // committed, since a rebuild carries the board's identity forward rather
    // than measuring anything - so it is a second chance at a missed flip, not
    // a second way for a new version to arrive.
    const on = workflow.true ?? workflow.on
    expect(Object.keys(on).sort()).toEqual(['push', 'workflow_dispatch'])
    expect(on.push.branches).toEqual(['main'])
    expect(on.push.paths).toEqual(['results/summary.json'])
  })

  it('publishes the draft rather than creating a second release for the tag', () => {
    expect(yamlText).toMatch(/gh release edit/)
    expect(yamlText).not.toMatch(/gh release create/)
  })
})
