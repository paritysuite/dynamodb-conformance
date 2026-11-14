import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { it } from 'vitest'

// When SWEEP_ORPHAN_PID_FILE is set, loading this file starts a process that
// outlives vitest, the way a stray server or worker would, and records its
// pid. It gives up after half a minute, so even a leaked one cannot linger.
const pidFile = process.env.SWEEP_ORPHAN_PID_FILE
if (pidFile) {
  const stray = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], { stdio: 'ignore' })
  appendFileSync(pidFile, `${stray.pid}\n`)
  stray.unref()
}

it('leaves a process behind', () => {})
