// Runs a project command (the step's test) in its own process group, so a timeout kills test workers and dev
// servers too, not just the shell. Output is kept as a rolling tail, so verbose suites can't overflow a buffer.

import { spawn } from 'node:child_process'

export type CommandResult = { code: number | null; signal: string | null; timedOut: boolean; output: string }

const KEEP = 256 * 1024

export function runCommand(command: string, opts: { cwd: string; env: Record<string, string>; timeoutMs: number }): Promise<CommandResult> {
  return new Promise(resolve => {
    const child = spawn('sh', ['-c', command], { cwd: opts.cwd, env: opts.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const collect = (chunk: Buffer) => {
      output += chunk.toString('utf8')
      if (output.length > KEEP * 2) output = output.slice(-KEEP)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    let timedOut = false
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal)
      } catch {} // already gone
    }
    const timer = setTimeout(() => {
      timedOut = true
      killGroup('SIGTERM')
      setTimeout(() => killGroup('SIGKILL'), 5000).unref()
    }, opts.timeoutMs)
    child.on('error', error => {
      clearTimeout(timer)
      resolve({ code: null, signal: null, timedOut, output: `${output}\n${String(error)}` })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      killGroup('SIGKILL') // leftovers that detached from the shell
      resolve({ code, signal, timedOut, output: output.slice(-KEEP) })
    })
  })
}
