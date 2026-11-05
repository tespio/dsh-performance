/**
 * In-process A/B benchmark for the Cordis hot-path patch.
 *
 * Both implementations live in one process and alternate rounds, so machine
 * drift and thermal state hit both sides equally. Results are raw per-round
 * timings; `bench/summarize.ts` turns them into medians and quartiles.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { cpus, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cases, sinkValue, type BenchCase, type Impl } from './cases.ts'

const root = fileURLToPath(new URL('..', import.meta.url))

interface Options {
  rounds: number
  scale: number
  out: string
  only: string[] | undefined
}

function parseArgs(argv: string[]): Options {
  const options: Options = { rounds: 7, scale: 1, out: join(root, 'results', 'raw', 'run.json'), only: undefined }
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === '--rounds') { options.rounds = Number(value); index++ }
    else if (flag === '--scale') { options.scale = Number(value); index++ }
    else if (flag === '--out') { options.out = resolve(value!); index++ }
    else if (flag === '--only') { options.only = value!.split(','); index++ }
  }
  if (!Number.isFinite(options.rounds) || options.rounds < 1) throw new Error('--rounds must be a positive integer')
  if (!Number.isFinite(options.scale) || options.scale <= 0) throw new Error('--scale must be positive')
  return options
}

function timeNs(thunk: () => void, iters: number) {
  const started = process.hrtime.bigint()
  for (let index = 0; index < iters; index++) thunk()
  return Number(process.hrtime.bigint() - started) / iters
}

/** Cost of one stack capture, so results can be read against the host's cost. */
function errorCost(iters = 50_000) {
  const objectStart = process.hrtime.bigint()
  for (let index = 0; index < iters; index++) void { value: index }
  const objectNs = Number(process.hrtime.bigint() - objectStart) / iters

  const errorStart = process.hrtime.bigint()
  for (let index = 0; index < iters; index++) void new Error('x')
  const errorNs = Number(process.hrtime.bigint() - errorStart) / iters
  return { errorNs, objectNs }
}

async function load(name: 'base' | 'patched'): Promise<Impl> {
  const url = new URL(`../.work/${name}/cordis/src/index.ts`, import.meta.url)
  return await import(url.href) as Impl
}

async function measure(benchCase: BenchCase, base: Impl, patched: Impl, rounds: number, scale: number) {
  const iters = Math.max(1, Math.round(benchCase.iters * scale))
  const runBase = await benchCase.prepare(base)
  const runPatched = await benchCase.prepare(patched)

  const warmup = Math.min(iters, 20_000)
  for (let index = 0; index < warmup; index++) { runBase(); runPatched() }

  const baseTimes: number[] = []
  const patchedTimes: number[] = []
  for (let round = 0; round < rounds; round++) {
    // Alternate which side runs first so cache/JIT warmup is not one-sided.
    if (round % 2 === 0) {
      baseTimes.push(timeNs(runBase, iters))
      patchedTimes.push(timeNs(runPatched, iters))
    } else {
      patchedTimes.push(timeNs(runPatched, iters))
      baseTimes.push(timeNs(runBase, iters))
    }
  }

  process.stderr.write(`${benchCase.id.padEnd(20)} ${rounds} rounds x ${iters} iters\n`)
  return { id: benchCase.id, label: benchCase.label, iters, base: baseTimes, patched: patchedTimes }
}

const options = parseArgs(process.argv.slice(2))
const selected = options.only ? cases.filter(benchCase => options.only!.includes(benchCase.id)) : cases
if (selected.length === 0) throw new Error('no cases selected')

const startedAt = new Date().toISOString()
const base = await load('base')
const patched = await load('patched')
const costs = errorCost()

const results: Awaited<ReturnType<typeof measure>>[] = []
for (const benchCase of selected) results.push(await measure(benchCase, base, patched, options.rounds, options.scale))
const cpu = cpus()[0]

const payload = {
  meta: {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    cpu: cpu?.model ?? 'unknown',
    cores: cpus().length,
    memoryGiB: Math.round(totalmem() / 1024 ** 3),
    rounds: options.rounds,
    scale: options.scale,
    startedAt,
    errorCostNs: costs.errorNs,
    objectCostNs: costs.objectNs,
    sink: sinkValue(),
  },
  cases: results,
}

mkdirSync(dirname(options.out), { recursive: true })
writeFileSync(options.out, `${JSON.stringify(payload, null, 2)}\n`)
process.stderr.write(`\nwrote ${options.out}\n`)
