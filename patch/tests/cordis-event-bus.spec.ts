/** Event dispatch and context-proxy behavior of the vendored Cordis core. */
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'

declare module '@deepseek-ai/cordis' {
  interface Context {
    probe: string
    echo: string
    store: Store
  }

  interface Events {
    'test/plain'(this: { tag: string }, value: number): void
    'test/serial'(value: number): number | undefined
    'test/waterfall'(value: number, next: (value: number) => number): number
    'test/traced'(value: unknown): void
    'constructor'(value: number): void
    toString(value: number): void
    __proto__(value: number): void
    valueOf(value: number): void
  }
}

interface Store {
  value: number
  current: number
  bump(): number
}

const contexts: Context[] = []

function createContext() {
  const ctx = new Context()
  contexts.push(ctx)
  return ctx
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

describe('Cordis event dispatch', () => {
  it('runs every listener registered when the dispatch started, in order', () => {
    const ctx = createContext()
    const calls: string[] = []
    const removeSecond = ctx.on('test/plain', () => { calls.push('second') })
    ctx.on('test/plain', () => {
      calls.push('first')
      removeSecond()
    }, true)
    ctx.emit({ tag: 'carrier' }, 'test/plain', 1)
    expect(calls).toEqual(['first', 'second'])
    ctx.emit({ tag: 'carrier' }, 'test/plain', 1)
    expect(calls).toEqual(['first', 'second', 'first'])
  })

  it('binds listeners to the dispatch this and traces arguments', () => {
    const ctx = createContext()
    const carrier = { tag: 'carrier' }
    const seen: unknown[] = []
    ctx.on('test/plain', function (this: unknown, value) {
      seen.push(this, value)
    })
    ctx.emit(carrier, 'test/plain', 7)
    expect(seen).toEqual([carrier, 7])
  })

  it('dispatches event names that collide with Object.prototype members', () => {
    const ctx = createContext()
    const listeners = {
      constructor: vi.fn(),
      toString: vi.fn(),
      __proto__: vi.fn(),
    }
    for (const name of ['constructor', 'toString', '__proto__'] as const) {
      ctx.on(name, listeners[name])
    }
    ctx.emit('constructor', 1)
    ctx.emit('toString', 2)
    ctx.emit('__proto__', 3)
    expect(listeners.constructor).toHaveBeenCalledExactlyOnceWith(1)
    expect(listeners.toString).toHaveBeenCalledExactlyOnceWith(2)
    expect(listeners.__proto__).toHaveBeenCalledExactlyOnceWith(3)
    // An event with no listeners must stay inert even when the name is inherited.
    ctx.emit('valueOf', 0)
  })

  it('reports public dispatches to internal/dispatch observers only', () => {
    const ctx = createContext()
    const reported: string[] = []
    ctx.on('internal/dispatch', (mode, name) => { reported.push(`${mode}:${name}`) })
    ctx.emit({ tag: 'carrier' }, 'test/plain', 1)
    ctx.events.emit('internal/listener', 'ignored')
    expect(reported).toEqual(['emit:test/plain'])
  })

  it('exposes dispatch callbacks bound to the dispatch this', () => {
    const ctx = createContext()
    const carrier = { tag: 'carrier' }
    const seen: unknown[] = []
    ctx.on('test/plain', function (this: unknown, value) {
      seen.push(this, value)
    })
    const args: unknown[] = [carrier, 'test/plain', 4]
    const callbacks = ctx.events.dispatch('emit', args)
    expect(callbacks).toHaveLength(1)
    callbacks[0]?.(...args)
    expect(seen).toEqual([carrier, 4])
  })

  it('keeps serial bail, waterfall composition, and veto semantics', async () => {
    const ctx = createContext()
    ctx.on('test/serial', value => value > 0 ? value * 2 : undefined)
    expect(await ctx.serial('test/serial', 2)).toBe(4)
    expect(await ctx.serial('test/serial', -1)).toBeUndefined()

    // A waterfall listener wraps the inner result; `next()` delegates with the
    // dispatch arguments, and the listener's own return value is what composes.
    ctx.on('test/waterfall', (value, next) => next(value) + value)
    const inner = (value: number) => value * 10
    expect(ctx.waterfall('test/waterfall', 1, inner)).toBe(11)

    const vetoed = createContext()
    vetoed.on('test/waterfall', () => 99)
    expect(vetoed.waterfall('test/waterfall', 1, inner)).toBe(99)
  })
})

describe('Cordis context proxy', () => {
  it('hands accessors an Error-shaped diagnostic without capturing on success', () => {
    const ctx = createContext()
    let diagnostic: Error | undefined
    ctx.accessor('probe', {
      get(receiver, error) {
        expect(receiver).toBeUndefined()
        diagnostic = error
        return 'value'
      },
    })
    expect(ctx.probe).toBe('value')
    expect(diagnostic).toBeInstanceOf(Error)
    expect(diagnostic!.message).toBe('cannot get property "probe" without inject')
    expect(typeof diagnostic!.stack).toBe('string')
  })

  it('still throws for services that the current fiber cannot reach', async () => {
    const ctx = createContext()
    let thrown: unknown
    await ctx.plugin((fiberCtx: Context) => {
      try {
        void (fiberCtx as Context & { absent: string }).absent
      } catch (error) {
        thrown = error
      }
    })
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe('cannot get property "absent" without inject')
  })

  it('runs internal/get listeners only while they are registered', () => {
    const ctx = createContext()
    ctx.provide('echo', 'value')
    const seen: string[] = []
    const off = ctx.on('internal/get', (target, name, error, next: () => unknown) => {
      expect(target).toBe(ctx)
      seen.push(name)
      expect(error).toBeInstanceOf(Error)
      return next()
    })
    expect(ctx.echo).toBe('value')
    expect(seen).toEqual(['echo'])
    off()
    expect(ctx.echo).toBe('value')
    expect(seen).toEqual(['echo'])
  })

  it('mutates service fields and resolves the caller context in accessor setters', async () => {
    const setters: Context[] = []
    class StoreService extends Service implements Store {
      constructor(ctx: Context) {
        super(ctx, 'store')
      }

      value = 0
      get current() { return this.value }
      set current(next: number) {
        setters.push(this.ctx)
        this.value = next
      }

      bump() { return ++this.value }
    }

    const ctx = createContext()
    await ctx.plugin(StoreService)
    expect(ctx.store.bump()).toBe(1)
    expect(ctx.store.value).toBe(1)
    ctx.store.current = 5
    expect(ctx.store.current).toBe(5)
    // The setter runs on the caller's tracing shadow, so `this.ctx` resolves
    // through the caller's scope rather than the service's own fiber.
    expect(setters).toHaveLength(1)
    expect(Context.is(setters[0])).toBe(true)
    expect(setters[0]!.store.value).toBe(5)
  })
})
