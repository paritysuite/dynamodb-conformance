import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  CHANNELS,
  TARGETS,
  configurationOf,
  display,
  distributionOf,
  isVariant,
  label,
  licenceOf,
  projectOf,
  repoUrl,
} from './targets.mjs'
import { GROUND_TRUTH_SLUG, isPublishedTarget, isTargetResultFile } from './score.mjs'

// The registry is hand-maintained, unlike every figure the board publishes, so
// what can be checked about it is checked here: that its relationships are
// coherent, and that a distribution claim always carries the page proving it.

describe('the target registry', () => {
  it('gives every target a display name and a home', () => {
    for (const [slug, t] of Object.entries(TARGETS)) {
      expect(t.display, `${slug} has no display name`).toBeTruthy()
      expect(t.url, `${slug} has no url`).toMatch(/^https:\/\//)
    }
  })

  it('groups every target under a project', () => {
    for (const slug of Object.keys(TARGETS)) {
      expect(projectOf(slug), `${slug} has no project`).toBeTruthy()
    }
  })

  it('gives each project exactly one reference configuration', () => {
    // The parent row carries the reference configuration's figures, so a
    // project with none would have no row and one with two would have the
    // wrong figures on whichever won the tie.
    const byProject = new Map()
    for (const [slug, t] of Object.entries(TARGETS)) {
      const list = byProject.get(t.project) ?? []
      list.push({ slug, reference: Boolean(t.reference) })
      byProject.set(t.project, list)
    }
    const problems = []
    for (const [project, members] of byProject) {
      const refs = members.filter((m) => m.reference)
      if (refs.length !== 1) {
        problems.push(`${project}: ${refs.length} reference configurations`)
      }
    }
    expect(problems, problems.join('\n')).toEqual([])
  })

  it('names the configuration of every project that has more than one', () => {
    // With two builds in play, an unlabelled row cannot say which was measured.
    const counts = {}
    for (const t of Object.values(TARGETS)) counts[t.project] = (counts[t.project] ?? 0) + 1
    const problems = Object.entries(TARGETS)
      .filter(([, t]) => counts[t.project] > 1 && !t.configuration)
      .map(([slug]) => slug)
    expect(problems, `unlabelled members of a multi-build project: ${problems}`).toEqual([])
  })

  it('marks exactly the non-reference configurations as variants', () => {
    expect(isVariant('dynoxide-wasm')).toBe(true)
    expect(isVariant('dynoxide')).toBe(false)
    expect(configurationOf('dynoxide-wasm')).toBe('WebAssembly / OPFS')
  })

  it('has a row for every target the results directory publishes', () => {
    // A results file with no registry entry renders under a hyphen-stripped
    // slug with no link, which is how a new target reaches the board unnamed.
    // Through the shared predicate, which is the criterion the pipeline
    // applies: results/ also holds derived artefacts (the tag manifest, the
    // summary) and the gitignored scratch slug, none of which are targets.
    const published = readdirSync('results')
      .filter(isTargetResultFile)
      .map((f) => f.replace(/\.json$/, ''))
    const missing = published.filter((slug) => !TARGETS[slug])
    expect(missing, `results files with no registry entry: ${missing}`).toEqual([])
  })

  it('keeps the ground truth in the registry, since it heads the table', () => {
    expect(TARGETS[GROUND_TRUTH_SLUG]).toBeTruthy()
  })
})

describe('distribution claims', () => {
  it('sources every channel it claims', () => {
    // Nothing in the suite can observe that a project ships a Docker image, so
    // the claim travels with the page documenting it and the board links there.
    // An unsourced channel is an assertion the reader cannot check.
    const problems = []
    for (const slug of Object.keys(TARGETS)) {
      for (const d of TARGETS[slug].distribution ?? []) {
        if (!d.url || !/^https:\/\//.test(d.url)) {
          problems.push(`${slug}/${d.channel}: no source url`)
        }
      }
    }
    expect(problems, problems.join('\n')).toEqual([])
  })

  it('draws channels from the declared vocabulary', () => {
    const problems = []
    for (const slug of Object.keys(TARGETS)) {
      for (const d of TARGETS[slug].distribution ?? []) {
        if (!CHANNELS[d.channel]) problems.push(`${slug}: unknown channel "${d.channel}"`)
      }
    }
    expect(problems, problems.join('\n')).toEqual([])
  })

  it('labels each channel for display', () => {
    for (const slug of Object.keys(TARGETS)) {
      for (const d of distributionOf(slug)) expect(d.label, `${slug}/${d.channel}`).toBeTruthy()
    }
  })

  it('declares no lineage: a relationship between engines is measured, not typed', () => {
    // scripts/lib/lineage.mjs derives it from shared failures. A typed
    // "built on" would be a claim about someone else's product that nothing
    // checks and that goes stale silently when they re-implement.
    const declared = Object.entries(TARGETS).filter(
      ([, t]) => t.dependsOn || t.builtOn || t.lineage,
    )
    expect(declared.map(([slug]) => slug)).toEqual([])
  })
})

describe('licences', () => {
  // The SPDX identifiers the registry uses, checked so a typo ("Apache 2.0",
  // "MIT-License") cannot pass for an identifier. Widen it when a target that
  // genuinely uses another one is added; a licence with no identifier carries
  // no `spdx` at all rather than a made-up one.
  const SPDX_IDS = new Set(['Apache-2.0', 'CC0-1.0', 'MIT'])
  const SPDX_OPERATORS = new Set(['AND', 'OR'])

  /** Whether `expression` alternates allowed ids and operators, starting and ending on an id. */
  const isAllowedSpdx = (expression) => {
    const tokens = String(expression).replace(/[()]/g, ' ').split(/\s+/).filter(Boolean)
    return (
      tokens.length % 2 === 1 &&
      tokens.every((token, i) => (i % 2 === 0 ? SPDX_IDS.has(token) : SPDX_OPERATORS.has(token)))
    )
  }

  /** Whether `url` is an https URL with a host, not just a scheme. */
  const isHttpsUrl = (url) => {
    try {
      const parsed = new URL(url)
      return parsed.protocol === 'https:' && parsed.hostname.includes('.')
    } catch {
      return false
    }
  }

  // A statement about a target's own licence, as distinct from a note that
  // merely mentions a licence key or an open-source dependency.
  const OWN_LICENCE_STATEMENT =
    /licen[cs]ed under|\bunder (?:its|an?|the)\b[^.;]*\blicen[cs]e\b|source-available|proprietary|\b(?:not|is) open[- ]source\b/i
  // A licence name says which licence, and nothing about what kind it is.
  const CHARACTERISED_NAME = /[()]|open[- ]source|source-available|proprietary|permissive|copyleft/i

  /** Every problem with one target's resolved licence, one line each. */
  const licenceProblems = (slug, licence) => {
    if (!licence) return [`${slug}: no licence`]
    const problems = []
    if (typeof licence.name !== 'string' || !licence.name.trim()) problems.push(`${slug}: no licence name`)
    if (!isHttpsUrl(licence.url)) problems.push(`${slug}: licence url is not an https URL: ${licence.url}`)
    const extra = Object.keys(licence).filter((k) => !['name', 'spdx', 'url'].includes(k))
    if (extra.length) problems.push(`${slug}: unexpected licence fields ${extra.join(', ')}`)
    if (licence.spdx !== undefined) {
      if (!isAllowedSpdx(licence.spdx)) problems.push(`${slug}: not an allowed SPDX expression: ${licence.spdx}`)
      if (licence.name !== licence.spdx) problems.push(`${slug}: name "${licence.name}" is not its SPDX id`)
    } else if (isAllowedSpdx(licence.name)) {
      problems.push(`${slug}: name "${licence.name}" is an SPDX expression but carries no spdx field`)
    }
    if (CHARACTERISED_NAME.test(licence.name ?? '')) problems.push(`${slug}: name "${licence.name}" characterises the licence`)
    return problems
  }

  it('resolves a valid licence for every target in the registry', () => {
    // Every slug, not only the rows on the board, so a target has its licence
    // before its first run puts it on the board.
    const problems = Object.keys(TARGETS).flatMap((slug) => licenceProblems(slug, licenceOf(slug)))
    expect(problems, problems.join('\n')).toEqual([])
  })

  it('rejects each malformed licence the check is there to catch', () => {
    // The check above has to be able to fail, one case per rule.
    const ok = { name: 'MIT', spdx: 'MIT', url: 'https://example.com/LICENSE' }
    expect(licenceProblems('x', ok)).toEqual([])
    expect(licenceProblems('x', { ...ok, name: 'MIT OR Apache-2.0', spdx: 'MIT OR Apache-2.0' })).toEqual([])
    expect(licenceProblems('x', { name: 'Some Vendor Licence', url: ok.url })).toEqual([])
    expect(licenceProblems('x', null)).not.toEqual([])
    expect(licenceProblems('x', { ...ok, name: ' ' })).not.toEqual([])
    expect(licenceProblems('x', { ...ok, url: 'http://example.com/LICENSE' })).not.toEqual([])
    expect(licenceProblems('x', { ...ok, url: 'https://' })).not.toEqual([])
    expect(licenceProblems('x', { ...ok, name: 'Apache 2.0', spdx: 'Apache 2.0' })).not.toEqual([])
    expect(licenceProblems('x', { ...ok, name: 'MIT OR', spdx: 'MIT OR' })).not.toEqual([])
    expect(licenceProblems('x', { ...ok, name: 'MIT WITH Apache-2.0', spdx: 'MIT WITH Apache-2.0' })).not.toEqual([])
    expect(licenceProblems('x', { ...ok, name: 'Apache-2.0' })).not.toEqual([])
    expect(licenceProblems('x', { name: 'MIT', url: ok.url })).not.toEqual([])
    expect(licenceProblems('x', { ...ok, kind: 'permissive' })).not.toEqual([])
    expect(licenceProblems('x', { name: 'Vendor Licence (not open source)', url: ok.url })).not.toEqual([])
    expect(licenceProblems('x', { name: 'Proprietary', url: ok.url })).not.toEqual([])
  })

  it('lets a build inherit its project licence rather than copy it', () => {
    // A copied licence can be updated on the parent and missed on the build. A
    // build declares its own only when its licence differs.
    const problems = []
    for (const [slug, t] of Object.entries(TARGETS)) {
      if (t.reference || !t.licence) continue
      const parent = Object.entries(TARGETS).find(([s, p]) => p.reference && projectOf(s) === projectOf(slug))
      if (parent && JSON.stringify(parent[1].licence) === JSON.stringify(t.licence)) {
        problems.push(`${slug}: repeats ${parent[0]}'s licence`)
      }
    }
    expect(problems, problems.join('\n')).toEqual([])
    expect(licenceOf('dynoxide-wasm')).toBe(licenceOf('dynoxide'))
    expect(licenceOf('some-new-engine')).toBeNull()
  })

  it('keeps statements about a target\'s own licence out of the prose fields', () => {
    // The licence is a field, shown the same way for every target. A sentence
    // about it in one target's note is a caveat the others do not carry.
    const problems = Object.entries(TARGETS)
      .filter(([, t]) => OWN_LICENCE_STATEMENT.test(`${t.note ?? ''} ${t.requires ?? ''} ${t.configuration ?? ''}`))
      .map(([slug]) => slug)
    expect(problems, `licence prose in: ${problems}`).toEqual([])
  })

  it('tells a statement about the licence from a note that only mentions one', () => {
    for (const fine of [
      'a licence key from the vendor, set in the environment',
      'A REST layer over the open-source Apache Phoenix on HBase.',
    ]) {
      expect(OWN_LICENCE_STATEMENT.test(fine), fine).toBe(false)
    }
    for (const remark of [
      'ScyllaDB is source-available under its own licence, not open source.',
      'Licensed under the Business Source License.',
      'Released under its own licence.',
      'The engine is proprietary.',
      'It is not open source.',
      'It is open source.',
    ]) {
      expect(OWN_LICENCE_STATEMENT.test(remark), remark).toBe(true)
    }
  })
})

describe('display helpers', () => {
  it('falls back to a readable name for an unregistered slug', () => {
    expect(display('some-new-engine')).toBe('some new engine')
    expect(repoUrl('some-new-engine')).toBeNull()
  })

  it('links a registered target and leaves an unregistered one bare', () => {
    expect(label('dynoxide')).toBe('[Dynoxide](https://github.com/nubo-db/dynoxide)')
    expect(label('some-new-engine')).toBe('some new engine')
  })
})
