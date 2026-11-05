/**
 * Turn raw per-round timings into the medians and quartiles the charts use.
 *
 * Usage: node --experimental-transform-types bench/summarize.ts [--raw path] [--out path]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

interface RawCase {
  id: string
  label: string
  iters: number
  base: number[]
  patched: number[]
}

interface RawRun {
  meta: Record<string, unknown>
  cases: RawCase[]
}

function parseArgs(argv: string[]) {
  const options = {
    raw: join(root, 'results', 'raw', 'run-latest.json'),
    out: join(root, 'results', 'summary.json'),
  }
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--raw') { options.raw = resolve(argv[++index]!); }
    else if (argv[index] === '--out') { options.out = resolve(argv[++index]!); }
  }
  return options
}

/** Linear-interpolated percentile over an unsorted sample. */
function percentile(samples: number[], fraction: number) {
  const sorted = [...samples].sort((left, right) => left - right)
  const position = (sorted.length - 1) * fraction
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]!
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower)
}

function stats(samples: number[]) {
  return {
    median: percentile(samples, 0.5),
    p25: percentile(samples, 0.25),
    p75: percentile(samples, 0.75),
    min: Math.min(...samples),
    max: Math.max(...samples),
    n: samples.length,
  }
}

const options = parseArgs(process.argv.slice(2))
const raw = JSON.parse(readFileSync(options.raw, 'utf8')) as RawRun

const cases = raw.cases.map((entry) => {
  const base = stats(entry.base)
  const patched = stats(entry.patched)
  return {
    id: entry.id,
    label: entry.label,
    iters: entry.iters,
    base,
    patched,
    speedup: base.median / patched.median,
    deltaPct: (patched.median - base.median) / base.median * 100,
  }
})

const summary = {
  meta: {
    ...raw.meta,
    // Repository-relative so published results do not leak the measurement host.
    source: relative(root, options.raw).split('\\').join('/'),
    summarizedAt: new Date().toISOString(),
  },
  cases,
}

mkdirSync(dirname(options.out), { recursive: true })
writeFileSync(options.out, `${JSON.stringify(summary, null, 2)}\n`)

const header = `${'case'.padEnd(22)} ${'base ns'.padStart(10)} ${'patched ns'.padStart(11)} ${'speedup'.padStart(8)}`
console.log(header)
console.log('-'.repeat(header.length))
for (const entry of cases) {
  console.log(
    `${entry.id.padEnd(22)} ${entry.base.median.toFixed(0).padStart(10)} ${entry.patched.median.toFixed(0).padStart(11)} ${(entry.speedup.toFixed(2) + 'x').padStart(8)}`,
  )
}
process.stderr.write(`\nwrote ${options.out}\n`)
