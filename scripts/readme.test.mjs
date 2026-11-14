import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The prose files a reader copies commands out of, and the test tree the README
// draws. Both go wrong quietly: a command that fails on paste looks fine on the
// page, and a tree goes stale one new file at a time.

// Named, so a renamed doc fails here rather than dropping out of the scan.
const NAMED_DOCS = ['README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'registry/README.md', 'site/README.md']
const SITE_DOCS = readdirSync('site/src')
  .filter((f) => f.endsWith('.md'))
  .map((f) => `site/src/${f}`)
const DOCS = [...NAMED_DOCS, ...SITE_DOCS]

// Fenced blocks as `{ label, start, lines }`, where start is the 1-based line
// number of the first line inside the fence.
export function fencedBlocks(text) {
  const blocks = []
  let open = null
  text.split('\n').forEach((line, i) => {
    const fence = /^\s*```\s*([\w-]*)/.exec(line)
    if (fence === null) {
      if (open !== null) open.lines.push(line)
      return
    }
    if (open === null) {
      open = { label: fence[1].toLowerCase(), start: i + 2, lines: [] }
    } else {
      blocks.push(open)
      open = null
    }
  })
  return blocks
}

// A block a reader pastes into a shell: labelled as one, or unlabelled. A tree
// or sample output is labelled `text` and is not a command block.
const SHELL = new Set(['', 'bash', 'sh', 'shell', 'zsh', 'console'])

const shellBlocks = (path) =>
  fencedBlocks(readFileSync(path, 'utf8'))
    .filter((b) => SHELL.has(b.label))
    .map((b) => ({ ...b, path }))

const isComment = (line) => line.trim().startsWith('#')

// Interactive zsh, the macOS default, treats `#` as an ordinary word unless
// interactive_comments is set. So a comment after a command passes its words
// to the command as arguments, and a comment on its own line is a command
// named `#` whose arguments the shell still parses.
const TRAILING_COMMENT = /^\s*[^#\s].*\s#/

// What the text of a comment-only line must not contain, measured on zsh 5.9
// by pasting a comment and then `echo ok`. A quote, a backtick or `(` opens a
// construct that swallows every line after it; the rest print an error, `>`
// silently creates a file, a word starting `=` or `~` is expanded as a command
// path or a home directory, and a trailing backslash joins the next line on.
// Bash honours comments in an interactive shell and accepts all of them.
const COMMENT_HAZARD = /['"`()<>;&|*?[}!]|(^|\s)[=~][A-Za-z0-9]|\\\s*$/

/** Every rule a shell block's lines break, as "path:line: reason: text". */
export function shellProblems(path, lines, start = 1) {
  const found = []
  const report = (i, why) => found.push(`${path}:${start + i}: ${why}: ${lines[i].trim()}`)
  lines.forEach((line, i) => {
    const continues = i > 0 && /\\\s*$/.test(lines[i - 1]) && !isComment(lines[i - 1])
    if (!isComment(line)) {
      if (TRAILING_COMMENT.test(line)) report(i, 'comment after a command')
      return
    }
    const text = line.trim()
    // `#word` is a command zsh cannot find, where `# word` is merely one it
    // reports; a comment inside a continued command ends that command early.
    if (!/^#(\s|$)/.test(text)) report(i, 'no space after #')
    if (COMMENT_HAZARD.test(text.slice(1))) report(i, 'character zsh parses in a comment')
    if (continues) report(i, 'comment inside a continued command')
  })
  return found
}

describe('the docs a reader copies commands from', () => {
  it('all exist under the names this test scans', () => {
    expect(NAMED_DOCS.filter((path) => !existsSync(path))).toEqual([])
  })

  const blocks = DOCS.filter(existsSync).flatMap(shellBlocks)

  it('scans some shell lines, so an empty result means something', () => {
    expect(blocks.reduce((n, b) => n + b.lines.length, 0)).toBeGreaterThan(50)
  })

  it('paste cleanly into an interactive zsh', () => {
    const found = blocks.flatMap((b) => shellProblems(b.path, b.lines, b.start))
    expect(found, found.join('\n')).toEqual([])
  })

  const flags = (...lines) => shellProblems('x', lines).map((p) => p.split(': ')[1])

  it('catches a trailing comment however it is spaced, and leaves # inside a word alone', () => {
    for (const line of ['npm run site:dev   # http://localhost:8080', 'cmd #comment', 'export A=1 #comment']) {
      expect(flags(line), line).toEqual(['comment after a command'])
    }
    for (const line of ['echo $#', 'echo ${#var}', 'echo ${var#x}', 'curl https://example.com/#anchor', 'echo \\#']) {
      expect(flags(line), line).toEqual([])
    }
  })

  it('catches a comment zsh would parse, and passes plain prose', () => {
    const caught = [
      "# the site's tests",
      '# a (note)',
      '# one; two',
      '# see =cmd',
      '# see ~user',
      '# a > b',
      '# takes ~5 minutes',
      '# a =5 b',
      '# note \\',
    ]
    for (const line of caught) expect(flags(line), line).toEqual(['character zsh parses in a comment'])
    for (const line of [
      '#',
      '# Writes site/_site/.',
      '# http://127.0.0.1:8003, installs its own browser',
      '# env vars, ~/.aws/credentials, IAM role',
      '# a - b: c, $x and 50% + 1 @ ^2',
    ]) {
      expect(flags(line), line).toEqual([])
    }
  })

  it('catches a comment with no space after #', () => {
    expect(flags('#nospace')).toEqual(['no space after #'])
    expect(flags('# spaced')).toEqual([])
  })

  it('catches a comment inside a continued command, and allows one after it ends', () => {
    expect(flags('docker run \\', '# the image', '  image')).toEqual(['comment inside a continued command'])
    expect(flags('docker run \\', '  image', '# then this')).toEqual([])
  })
})

describe('code blocks on the site', () => {
  // The site's highlighter passes a `text` fence through unescaped, so a
  // placeholder such as `<slug>` is emitted as a tag and vanishes from the
  // page. `plaintext` is escaped. The README is not rendered by the site, so
  // its tree keeps `text`.
  it('never use the `text` label, which renders <placeholders> as tags', () => {
    const found = SITE_DOCS.flatMap((path) =>
      fencedBlocks(readFileSync(path, 'utf8'))
        .filter((b) => b.label === 'text')
        .map((b) => `${path}:${b.start - 1}: label it plaintext`),
    )
    expect(SITE_DOCS.length).toBeGreaterThan(0)
    expect(found, found.join('\n')).toEqual([])
  })
})

// The directories and test files the README's "Test organisation" tree names,
// as a map of "tierN/dir" to the stems annotated beside it.
export function treeEntries(readme) {
  const section = readme.split(/^## Test organisation\s*$/m)[1]?.split(/^## /m)[0] ?? ''
  const tree = fencedBlocks(section)[0]?.lines ?? []
  const entries = new Map()
  let tier = null
  let current = null
  const add = (text) => {
    for (const stem of text.split(',').map((s) => s.trim()).filter(Boolean)) current.push(stem)
  }
  for (const line of tree) {
    const top = /^ {2}(tier\d)\/(\s|$)/.exec(line)
    if (top) {
      tier = top[1]
      current = null
      continue
    }
    const dir = /^ {4}([\w-]+)\/\s*(?:#\s*(.*))?$/.exec(line)
    if (dir && tier) {
      current = []
      entries.set(`${tier}/${dir[1]}`, current)
      if (dir[2]) add(dir[2])
      continue
    }
    const more = /^\s+#\s*(.*)$/.exec(line)
    if (more && current) add(more[1])
  }
  return entries
}

/**
 * Every `*.test.ts` under tests/tierN, as a map of "tierN/dir" to its stems,
 * plus any test file at a depth the tree cannot draw: directly under a tier,
 * or nested below a directory.
 */
export function testFiles(root = 'tests') {
  const entries = new Map()
  const misplaced = []
  const walk = (rel, depth) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (depth === 1) entries.set(path, entries.get(path) ?? [])
        walk(path, depth + 1)
      } else if (e.name.endsWith('.test.ts')) {
        if (depth === 2) entries.get(rel).push(e.name.slice(0, -'.test.ts'.length))
        else misplaced.push(path)
      }
    }
  }
  for (const tier of readdirSync(root, { withFileTypes: true })) {
    if (tier.isDirectory() && /^tier\d$/.test(tier.name)) walk(tier.name, 1)
  }
  return { entries, misplaced }
}

export function treeDrift(drawn, actual) {
  const missing = []
  const invented = []
  for (const [dir, stems] of actual) {
    if (!drawn.has(dir)) missing.push(`${dir}/`)
    else for (const s of stems) if (!drawn.get(dir).includes(s)) missing.push(`${dir}/${s}`)
  }
  for (const [dir, stems] of drawn) {
    if (!actual.has(dir)) invented.push(`${dir}/`)
    else for (const s of stems) if (!actual.get(dir).includes(s)) invented.push(`${dir}/${s}`)
  }
  return { missingFromTree: missing, notOnDisk: invented }
}

describe("the README's test tree", () => {
  it('names every directory and test file under tests/tier*, and nothing that is not there', () => {
    const drawn = treeEntries(readFileSync('README.md', 'utf8'))
    const { entries, misplaced } = testFiles()
    expect(entries.size).toBeGreaterThan(0)
    expect([...entries.values()].flat().length).toBeGreaterThan(100)
    expect({ ...treeDrift(drawn, entries), outsideATierDirectory: misplaced }).toEqual({
      missingFromTree: [],
      notOnDisk: [],
      outsideATierDirectory: [],
    })
  })
})
