import { readFileSync, writeFileSync } from 'node:fs'

// Usage: node e2e/analyze.mjs [runs.jsonl] [stats.json]

const rows = readFileSync(process.argv[2] ?? 'results/end-to-end/runs.jsonl', 'utf8').trim().split('\n').map(line => JSON.parse(line))
const runs = new Map()
for (const row of rows) {
  if (!runs.has(row.run)) runs.set(row.run, {})
  runs.get(row.run)[row.side] = row
}
const pairs = [...runs.values()].filter(pair => pair.base && pair.patched)

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function bootstrapMedianCI(values, iterations = 20000) {
  const estimates = []
  for (let i = 0; i < iterations; i++) {
    const sample = Array.from({ length: values.length }, () => values[Math.floor(Math.random() * values.length)])
    estimates.push(median(sample))
  }
  estimates.sort((a, b) => a - b)
  return [estimates[Math.floor(iterations * 0.025)], estimates[Math.floor(iterations * 0.975)]]
}

function binomTwoSided(k, n) {
  const logFact = (m) => { let s = 0; for (let i = 2; i <= m; i++) s += Math.log(i); return s }
  const pmf = (i) => Math.exp(logFact(n) - logFact(i) - logFact(n - i) - n * Math.log(2))
  const tail = Math.min(k, n - k)
  let sum = 0
  for (let i = 0; i <= tail; i++) sum += pmf(i)
  return Math.min(1, 2 * sum)
}

const summary = { pairs: pairs.length, metrics: {} }
for (const metric of ['turnsMs', 'totalMs', 'bootMs', 'turnMedianMs']) {
  const base = pairs.map(pair => pair.base[metric])
  const patched = pairs.map(pair => pair.patched[metric])
  const diffs = pairs.map(pair => pair.patched[metric] - pair.base[metric])
  const relative = diffs.map((diff, index) => diff / base[index] * 100)
  const faster = diffs.filter(diff => diff < 0).length
  const [low, high] = bootstrapMedianCI(diffs)
  const [relLow, relHigh] = bootstrapMedianCI(relative)
  summary.metrics[metric] = {
    baseMedian: median(base),
    patchedMedian: median(patched),
    medianDiff: median(diffs),
    medianRelativePct: median(relative),
    meanDiff: diffs.reduce((a, b) => a + b, 0) / diffs.length,
    ci95: [low, high],
    ci95RelativePct: [relLow, relHigh],
    fasterPairs: faster,
    pairs: diffs.length,
    signTestP: binomTwoSided(faster, diffs.length),
  }
  console.log(metric, JSON.stringify(summary.metrics[metric], null, 2))
}
writeFileSync(process.argv[3] ?? 'results/end-to-end/stats.json', JSON.stringify(summary, null, 2) + '\n')
