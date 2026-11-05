# End-to-end harness

This directory holds the harness used for the end-to-end measurement in
[`docs/end-to-end.md`](../docs/end-to-end.md). It runs **inside a DeepSeek
Harness checkout** — it imports that repository's SDK client, workload constants
and shipped `sdk-minimal` profile, so it cannot run from this repository alone.

## What it does

`e2e-profile.ts` starts the real `dsh` executable through
`@deepseek-ai/dsh-sdk-client` with the `sdk-minimal` profile, a synthetic
provider (no API key, no network), 100 turns, 8 real file-read tool calls per
turn, and prints one JSON line:

```json
{"bootMs":672.2,"turnsMs":4485.0,"closeMs":17.8,"totalMs":5179.1,"turns":100,"requests":200,"toolCalls":800,"turnMedianMs":42.4,...}
```

The synthetic provider is the same one DeepSeek Harness uses for its own
`profile-continuation` benchmark (`benchmarks/agent-continuation/profile-adapter.ts`).

## Reproducing the A/B

From a DeepSeek Harness checkout at `0.2.2-alpha.2`:

```sh
cp /path/to/dsh-performance/e2e/e2e-profile.ts benchmarks/
pnpm install

# 1. Baseline build
git checkout -- vendor/cordis/src
pnpm run build:artifacts
rm -rf /tmp/cordis-lib-base && cp -r vendor/cordis/lib /tmp/cordis-lib-base

# 2. Patched build
git apply -p1 /path/to/dsh-performance/patch/0001-cordis-hot-paths.patch
pnpm run build:artifacts
rm -rf /tmp/cordis-lib-patched && cp -r vendor/cordis/lib /tmp/cordis-lib-patched

# 3. Alternate arms; each run gets a fresh home and workspace
for i in $(seq 1 26); do
  for side in base patched; do
    rm -rf vendor/cordis/lib && cp -r /tmp/cordis-lib-$side vendor/cordis/lib
    rm -rf /tmp/e2e-$side-$i && mkdir -p /tmp/e2e-$side-$i
    node --import tsx/esm benchmarks/e2e-profile.ts /tmp/e2e-$side-$i 100
  done
done > runs.jsonl
```

Only `vendor/cordis/lib` changes between arms; the rest of the built
application is identical. Alternate the arm order per iteration (as the script
above does) so machine drift does not favor one side.

## Analysis

```sh
node e2e/analyze.mjs results/end-to-end/runs.jsonl results/end-to-end/stats.json
```

It pairs runs by index and reports per-metric medians, the median paired
difference with a bootstrap 95% confidence interval, and a two-sided sign test.
