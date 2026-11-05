# Findings

All numbers were produced by `bench/run.ts` on Windows 11, Node 24.21, on a 24-thread i7-13700KF. Full data in `results/summary.json`.

## The host's stack-capture cost is the lens

Everything below is easier to read with one number in hand: on this machine, constructing an `Error` (which captures a stack) costs **~1.9 µs**, while constructing a plain object costs **~10 ns**. Stack capture is roughly 190× more expensive than allocation here, which is high — typical Linux/macOS hardware lands nearer 0.3–0.5 µs. Any code path that captures a stack it does not use pays a tax that is invisible in review and expensive at runtime.

## 1. Diagnostic errors captured on every context read

The context is a Proxy. Every property that is not an own property and not a "special" name (symbols, `then`, `prototype`, `_`-prefixed) goes through `ReflectService.handler.get`, which started with:

```ts
const error = new Error(`cannot get property "${prop}" without inject`)
```

That error was only read in two situations: when resolution failed and the error was thrown, or when a user-declared accessor inspected its diagnostic argument. In the common case — `ctx.on`, `ctx.emit`, `ctx.effect`, `ctx.tool`, every service read — it was allocated and dropped.

Measured: **4.18 µs per accessor read**, of which ~1.9 µs was the error capture and the rest the proxy plumbing around it.

## 2. `dispatch()` allocated three arrays and bound a Proxy per listener

```ts
return (this._hooks[name] || [])
  .filter(hook => hook.global || !filter || filter.call(thisArg, hook.ctx))
  .map(hook => hook.callback.bind(thisArg))
```

`filter()` and `map()` each allocate; the caller (`emit`) then did `.map(cb => cb(...args))`, a third. Worse, `hook.callback` is the tracing wrapper, which used to be a **Proxy**:

```
proxy.bind(null)          ~480 ns
plain function.bind(null)   ~2 ns
calling the bound proxy  ~776 ns
```

`Function.prototype.bind` on a Proxy deoptimizes; the proxy's `apply` trap then allocates a traced argument array per call. Five listeners meant microseconds of pure bookkeeping per emission.

## 3. `internal/dispatch` was emitted even with no observer

```ts
if (!name.startsWith('internal/')) {
  this.emit('internal/dispatch', type, name, args, thisArg)
}
```

The nested `emit` re-enters `dispatch`, shifts the arguments, allocates a filtered/mapped pair, and finds nothing. It ran for every public event.

## 4. Field writes inside service methods built a caller shadow

Reads of a data property already skipped the "shadow" construction:

```ts
const desc = getPropertyDescriptor(target, prop)
if (desc && 'value' in desc) innerValue = desc.value
else { shadow = createShadow(...); innerValue = Reflect.get(target, prop, shadow) }
```

Writes did not:

```ts
const shadow = createShadow(ctx, target, tracker.property, receiver)
return Reflect.set(target, prop, value, shadow)
```

`createShadow` builds `ctx.extend({ [symbols.shadow]: origin })` — a child context — wraps the receiver in an overlay object and a Proxy, then writes through the whole chain. So `this.count++` inside a service method allocated a context, an overlay and a proxy, every time. This is why service calls were ~18 µs even for a method that adds one to a field.

## 5. Two latent bugs in the same code

- `EventsService._hooks` was initialized to `{}`. An event named `constructor`, `toString` or `__proto__` therefore resolved to an inherited `Object.prototype` member instead of an array: `ctx.on('constructor', fn)` threw on `hooks.push`, `ctx.emit('toString')` threw on `.filter`. Plugin-defined event names are just strings, so this was reachable.
- `emit()` invokes listeners with `.map(cb => cb(...args))` and no containment: one throwing listener starves every later listener and the error propagates to the emitter. Fourteen production call sites in DeepSeek Harness work around this by calling `dispatch()` and running their own try/catch loop — evidence that the framework's default is not the shape applications want.

## What remains expensive

`ctx.effect()` still costs ~30 µs after the patch, dominated by two eager stack captures:

- a stack captured at the registration site (`buildOuterStack`), and
- a marker error captured before the effect body runs (`composeError`).

Both exist so that when an *async* effect body rejects, the error's stack can be spliced together with the caller's frames — a genuinely useful diagnostic. They are inert on success but cannot be made lazy without either capturing at the wrong time or degrading the composed stack. That trade-off is why effect registration is the one row in the results table that barely moves.
