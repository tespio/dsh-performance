# The changes

`patch/0001-cordis-hot-paths.patch` touches three files in the vendored Cordis core: `events.ts`, `reflect.ts`, `utils.ts`. None of the changes alter the public API surface; all of them remove work that the framework did not need to do.

## 1. Diagnostic errors only where they are observed (`reflect.ts`)

The context proxy's `get`/`set` traps now build their diagnostic `Error` only on the paths that read it:

- **Accessors** receive `diagnosticError(message)` — an object with `Error.prototype` (so `instanceof Error`, `name`, `message` and `toString` behave), whose `stack` getter captures on first read and replaces itself with a data property.
- **Service resolution** checks whether anything listens to `internal/get` (respectively `internal/set`). If nothing does, the waterfall is skipped and the error is created only if resolution fails. If something does listen, the listener still receives an eagerly captured error with the exact caller frames, as before.

```ts
// fast path: no internal/get observers
if (!target.events._hooks['internal/get']?.length) return resolve()
// observed path: unchanged behavior
error = new Error(`cannot get property "${prop}" without inject`)
return ctx.events.waterfall('internal/get', ctx, prop, error, resolve)
```

**Risk:** accessor hooks that read `.stack` now get a stack captured at read time rather than at call time. No consumer in DeepSeek Harness reads it; the signature and `instanceof` behavior are preserved.

## 2. Direct listener dispatch (`events.ts`)

`emit()` no longer routes through `dispatch()`:

```ts
// before
emit(...args) { this.dispatch('emit', args).map(cb => cb(...args)) }

// after — one snapshot, one loop, no bound callbacks
emit(...args) {
  const { thisArg, name } = this._open('emit', args)
  const hooks = this._hooks[name]
  if (!hooks?.length) return
  const filter = thisArg?.[Context.filter]
  const snapshot = hooks.slice()
  for (const hook of snapshot) {
    if (filter && !hook.global && !filter.call(thisArg, hook.ctx)) continue
    Reflect.apply(hook.callback, thisArg, args)
  }
}
```

`dispatch()` itself keeps its contract (it returns bound callbacks, because DeepSeek Harness relies on that for error-contained emissions) but fills one array in one loop instead of chaining `filter()` and `map()`. `internal/dispatch` is emitted only while it has listeners.

**Risk:** low. `emit` still snapshots registrations (a listener may add or remove listeners mid-dispatch) and still applies the `Context.filter` rule.

## 3. Tracing wrappers are functions, not Proxies (`reflect.ts`)

```ts
// before: new Proxy(callback, { apply, construct })
// after:
return function (this: any, ...args: any[]) {
  const traced = args.map(arg => reflect.trace(arg))
  if (new.target) return Reflect.construct(callback, traced)
  return Reflect.apply(callback, reflect.trace(this), traced)
}
```

The wrapper must know the caller's `this` at call time, so a bound closure is not an option; an ordinary function is. Dispatch binds every callback before every call, and binding a Proxy function costs ~480 ns against ~2 ns for a function.

**Risk:** `bind()` is a public method. `construct` behavior is preserved for constructable callbacks (`new.target` branch). The wrapper is no longer a Proxy, so code that inspects it with `Proxy`-specific tooling would notice — nothing in the ecosystem does.

## 4. Null-prototype hook table (`events.ts`)

`_hooks` is initialized with `Object.create(null)`. Event names are arbitrary strings from plugins; without this, an event named after an `Object.prototype` member either throws or resolves to a non-array.

**Risk:** none; the table is internal.

## 5. Cached traceable wrappers (`utils.ts`)

`getTraceable(ctx, value)` memoizes one wrapper per `(context, value)` pair in a two-level `WeakMap`. Behavior depends only on the normalized context and the value, not on which property read produced it, so reuse is safe; entries die with the context.

**Risk:** wrapper identity becomes stable. That is closer to the service's own identity and no consumer compares two wrapper instances.

## 6. Data-property writes skip the caller shadow (`utils.ts`)

```ts
const desc = getPropertyDescriptor(target, prop)
if (!desc || ('value' in desc && desc.writable !== false)) {
  return Reflect.set(target, prop, value, target)
}
const shadow = createShadow(ctx, target, tracker.property, receiver)
return Reflect.set(target, prop, value, shadow)
```

A data-property write stores the value on the service; the caller shadow exists so that `this.ctx` resolves to the *writing* fiber, which only matters for accessor setters (and for reads, which already skipped it). Accessor descriptors keep the shadow path.

**Risk:** medium-low, and the one behavioral seam worth reviewing. A setter defined on the prototype still observes `this.ctx` as the caller. A data property cannot observe anything. Non-writable properties still take the shadow path and still fail the write.

## Verification

The repository carries the behavior spec used in DeepSeek Harness (`patch/tests/cordis-event-bus.spec.ts`): dispatch order and snapshot semantics, `this` binding, all five dispatch modes, `internal/dispatch` observation, prototype-colliding event names, the diagnostic carrier, unreachable-service errors, `internal/get` gating, and service field mutation with caller-scoped accessor setters.

In the harness repository the patch was validated with `tsc -b vendor/cordis`, 76 test files / 1,754 tests across `scripts/cordis-*` and every `packages/core` suite, and the repository's lint and documentation gates.

## Deliberately unchanged

- **Effect stack captures** (see `docs/findings.md`).
- **Logger facade allocation** — not on the per-frame path.
- **Service resolution caching** — the next lever, but it touches isolation semantics.

## Next levers

- **Contained emit.** `emit()` has no per-listener error containment; 14 DeepSeek Harness call sites hand-roll the same loop over `dispatch()`. A first-class contained mode would delete that duplication.
- **Service resolution cache** keyed by `(context, name)`, invalidated on provide/dispose.
- **Diagnostics mode** that trades long-stack composition for registration cost when no error surfaces.
