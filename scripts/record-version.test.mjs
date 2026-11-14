import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// record-version.sh reads a target's version off whatever the target answers
// with, so each case below runs the real script against a stub that answers
// the way the target does. The stubs sit first on a PATH of system directories
// only, so a real install on the machine running the tests cannot answer for
// them, and an absent stub is the target not being there at all.

const SCRIPT = resolve('scripts/record-version.sh')

/** Run the script for `target` with `stubs` ({ name: shell body }) and `env`. */
function record(target, { stubs = {}, env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'record-version-'))
  try {
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    for (const [name, body] of Object.entries(stubs)) {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
      chmodSync(join(bin, name), 0o755)
    }
    const run = spawnSync('bash', [SCRIPT, target], {
      cwd: dir,
      env: { PATH: `${bin}:/usr/bin:/bin`, ...env },
      encoding: 'utf8',
    })
    expect(run.status, run.stderr).toBe(0)
    return readFileSync(join(dir, 'results', `${target}.version`), 'utf8').trim()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('aws-emulator', () => {
  it('takes the version from the first line of `aws-emulator -v`', () => {
    const stubs = {
      'aws-emulator': 'printf "Version: 1.0.365\\nRelease date: 2026-11-14\\nCommit: 0a1b2c3\\n"',
    }
    expect(record('aws-emulator', { stubs })).toBe('1.0.365')
  })

  it('does not depend on the label in front of it', () => {
    const stubs = { 'aws-emulator': 'echo "aws-emulator 1.0.365"' }
    expect(record('aws-emulator', { stubs })).toBe('1.0.365')
  })

  it('records no version when the emulator is not installed', () => {
    expect(record('aws-emulator')).toBe('-')
  })
})
