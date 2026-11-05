# Methodology

## The problem with benchmarking this change

The patch removes allocations. Allocation and GC behavior depend on process history, CPU frequency, and what ran before. Running "before" and "after" in separate processes — or worse, minutes apart — produced swings of up to 2× for identical code on this machine. A naive before/after table would have been mostly noise.

## The design: one process, two implementations, alternating rounds

`bench/run.ts` imports both source trees into the same Node process:

```ts
const base = await import('../.work/base/cordis/src/index.ts')
const patched = await import('../.work/patched/cordis/src/index.ts')
```

Each case builds one thunk per implementation from the same case definition, then:

1. warms both thunks for `min(iters, 20 000)` iterations each;
2. runs `rounds` (default 7) timed rounds, alternating which side goes first;
3. records ns/op per round for each side.

The result is a paired sample: every base round has a patched round measured under nearly identical conditions. `bench/summarize.ts` reports the **median** of each side's rounds, with p25/p75 available in `results/summary.json`.

Units: nanoseconds per operation, computed as `elapsed_ns / iterations` from `process.hrtime.bigint()`.

## What is measured

| Case | Thunk |
|---|---|
| `accessor-read` | `ctx.on` property read only |
| `service-call` | `ctx.counter.next()` — resolution plus method call |
| `emit-0/1/5/20` | `ctx.emit('tick', 1)` with N registered listeners |
| `events-emit-5` | `ctx.events.emit(...)` — the service method without the mixin accessor |
| `dispatch-5` | `ctx.events.dispatch('emit', ['tick', 1])` |
| `waterfall-5` | `ctx.waterfall('chain', 1, inner)` |
| `effect-noop` | `ctx.effect(() => () => {})` |
| `logger-suppressed` | `ctx.logger.info('hello %s', 'world')` with the exporter threshold disabled |

Listeners are registered once, outside the timed region. Every thunk mutates a module-level sink so the engine cannot elide the call.

## Host calibration

Each run measures `new Error('x')` and `{ value: index }` in isolation and records both in `meta`. They explain cross-machine differences on paths that used to capture stacks, and they make the comparison honest: a machine where `Error` costs 0.4 µs will show smaller ratios for those rows even though the same work was removed.

## Threats to validity

- **JIT and GC interference.** Two implementations in one isolate share inline caches and GC pressure. Alternating rounds reduces ordering bias but cannot eliminate interference. Numbers should be read as "relative cost under a shared workload", not as isolated microarchitecture measurements.
- **Single machine, single run.** The committed results are one 7-round run on one host. Re-running moves absolute values by tens of percent; the direction and rough magnitude of every row have been stable across our runs.
- **Framework surface, not product path.** These are per-operation costs, not per-turn costs. A turn's wall clock is dominated by model latency and tool execution; this work buys CPU headroom and lower GC churn, not a proportional end-to-end speedup.
- **The baseline is the DeepSeek Harness vendored fork** (Cordis 4.0.6-alpha.1 plus that repo's local modifications), not upstream Cordis. The patch is written against that fork; `docs/applying.md` explains how to adapt it.
- **`logger-suppressed` is incidental.** It was not a target; it improved because the proxy layer under it got cheaper. It is reported for completeness, not as a claim.

## Reproducing

```sh
npm run bench        # 7 rounds, full iterations → results/raw/run-latest.json + results/summary.json
npm run bench:quick  # 1 round, 2% iterations → smoke only
```

`scripts/prepare.mjs` rebuilds `.work/base` from `vendor/` and `.work/patched` by applying `patch/0001-cordis-hot-paths.patch`, then rewrites the bare `@deepseek-ai/cosmokit` import to a relative path so Node's type stripping can load both trees without a package manager.
