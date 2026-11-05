/** End-to-end SDK profile run for A/B timing against the vendored Cordis sources. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { PARENT_ID, resultText, WORKLOAD } from './agent-continuation/workload.ts'

const [root, turnArg] = process.argv.slice(2)
if (root === undefined) throw new Error('usage: e2e-profile.ts <root> [turns]')
const turns = Number(turnArg ?? WORKLOAD.profileTurns)

const home = join(root, 'home')
const cwd = join(root, 'workspace')
await mkdir(cwd, { recursive: true })
await mkdir(home, { recursive: true })
await writeFile(join(cwd, 'synthetic.txt'), resultText(0))

const patch = join(root, 'profile.patch.yml')
await writeFile(patch, [
  '- id: llm-deepseek', '  disabled: true',
  '- id: sessions', '  config:', '    root: ' + JSON.stringify(join(root, 'profile-sessions')), '    compression: zstd',
  '- insert:',
  '    - id: fs-local', "      name: '@deepseek-ai/dsh-fs-local'",
  '    - id: str-replace-editor', "      name: '@deepseek-ai/dsh-tool-str-replace-editor'",
  '    - id: benchmark-model', '      name: ' + JSON.stringify(join(import.meta.dirname, 'agent-continuation', 'profile-adapter.ts')),
  '',
].join('\n'))

const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH, HOME: home, USERPROFILE: home,
  DSH_AGENTS_HOME: join(home, 'agents'),
}

const harness = new DeepSeekHarness({
  profile: 'sdk-minimal', dshHome: home, processCwd: cwd, cwd,
  provider: 'bench', model: 'bench', patches: [patch], env,
  initializeTimeoutMs: 180_000, requestTimeoutMs: 180_000,
})

let closing: Promise<void> | undefined
const close = (): Promise<void> => closing ??= harness.close()
const start = performance.now()
let bootMs = 0
let turnsMs = 0
let requests = 0
let toolCalls = 0
const perTurn: number[] = []
try {
  await harness.start()
  bootMs = performance.now() - start
  for (let turn = 0; turn < turns; turn++) {
    const turnStart = performance.now()
    const result = await harness.run('Read the synthetic file ' + String(turn), { sessionId: PARENT_ID })
    perTurn.push(performance.now() - turnStart)
    requests += result.events.filter(event => event.type === 'assistant/message').length
    for (const event of result.events) {
      if (event.type !== 'tool/result') continue
      const message = event.data.message
      if (message.isError) throw new Error('tool result is an error')
      if (!JSON.stringify(message.content).includes('export const synthetic = 42;')) {
        throw new Error('tool result did not read the synthetic file')
      }
      toolCalls++
    }
  }
  turnsMs = performance.now() - start - bootMs
} finally {
  const closeStart = performance.now()
  await close()
  const closeMs = performance.now() - closeStart
  perTurn.sort((left, right) => left - right)
  process.stdout.write(JSON.stringify({
    bootMs,
    turnsMs,
    closeMs,
    totalMs: performance.now() - start,
    turns,
    requests,
    toolCalls,
    turnMedianMs: perTurn[Math.floor(perTurn.length / 2)] ?? 0,
    turnMinMs: perTurn[0] ?? 0,
    turnMaxMs: perTurn[perTurn.length - 1] ?? 0,
  }) + '\n')
}
