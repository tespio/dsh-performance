# Applying the patch

## To DeepSeek Harness

The patch is cut against `vendor/cordis` in
[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
at `vendor/cordis/src/events.ts`, `reflect.ts` and `utils.ts`.

```sh
git clone https://github.com/deepseek-ai/deepseek-harness
cd deepseek-harness
git apply -p1 /path/to/0001-cordis-hot-paths.patch
cp /path/to/patch/tests/cordis-event-bus.spec.ts scripts/
```

The `-p1` prefix matches the patch's `a/vendor/cordis/...` headers. From the
repository root that is the only flag you need; `git apply --check -p1` confirms
it applies cleanly against `0.2.2-alpha.2`.

Then:

```sh
pnpm install
node node_modules/typescript/bin/tsc -b vendor/cordis/tsconfig.json
pnpm exec vitest run scripts/cordis-event-bus.spec.ts packages/core
pnpm run verify-export-jsdoc
pnpm run verify-cordis-api
pnpm run lint
```

DeepSeek Harness requires every divergence from vendored upstream to be recorded
in `vendor/README.md`'s local-modification log. Add an entry describing this
patch (the repository's convention is one numbered paragraph: what changed, why,
and which tests cover it) before shipping.

## To upstream Cordis

The hunks assume the DeepSeek Harness fork, which adds JSDoc and a lazy-config
layer on top of Cordis 4.0.6. The `events.ts`, `reflect.ts` and `utils.ts` regions
this patch touches exist upstream, but context lines differ, so expect to apply
with `git apply -3` or by hand. The changes are independent of the fork's local
modifications; each hunk is self-contained.

## Verifying behavior

`patch/tests/cordis-event-bus.spec.ts` is written for the DeepSeek Harness
workspace (it imports `@deepseek-ai/cordis` and uses Vitest). It covers:

- dispatch order and the registration snapshot taken at dispatch start;
- `this` binding and argument tracing;
- `serial` bail, `waterfall` composition and veto semantics;
- `internal/dispatch` observation (and that internal events are not reported);
- event names that collide with `Object.prototype` members;
- the accessor diagnostic carrier and its lazy `stack`;
- unreachable-service errors;
- `internal/get` listeners running only while registered;
- service field mutation with caller-scoped accessor setters.

## Rolling back

The patch changes no public API and touches no persisted data. `git checkout --
vendor/cordis/src` reverts it.
