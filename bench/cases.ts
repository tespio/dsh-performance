/**
 * The measured operations.
 *
 * Each case builds one thunk per implementation. The thunk must do the same
 * work for both sides; only the Cordis implementation differs. Thunks mutate
 * `sink` so the engine cannot elide the calls.
 */

/** The two module namespaces under comparison. */
export interface Impl {
  Context: new () => any
  Service: new (ctx: any, name: string) => any
}

/** One benchmark case. */
export interface BenchCase {
  /** Stable id used in results and charts. */
  id: string
  /** Human-readable label for charts. */
  label: string
  /** Iterations per round at scale 1. */
  iters: number
  /** Build the measured thunk for one implementation. */
  prepare(impl: Impl): Promise<() => void>
}

let sink = 0

/** Report the accumulated sink so callers can keep the results observable. */
export function sinkValue() {
  return sink
}

function listeners(impl: Impl, count: number) {
  const ctx = new impl.Context()
  for (let index = 0; index < count; index++) ctx.on('tick', (value: number) => { sink += value })
  return ctx
}

async function service(impl: Impl) {
  class Counter extends impl.Service {
    value = 0
    constructor(ctx: any) {
      super(ctx, 'counter')
    }
    next() {
      return ++this.value
    }
  }
  const ctx = new impl.Context()
  await ctx.plugin(Counter)
  return ctx
}

export const cases: BenchCase[] = [
  {
    id: 'accessor-read',
    label: 'context accessor read (ctx.on)',
    iters: 300_000,
    prepare: async (impl) => {
      const ctx = new impl.Context()
      return () => { sink += ctx.on ? 1 : 0 }
    },
  },
  {
    id: 'service-call',
    label: 'service call (ctx.svc.method())',
    iters: 200_000,
    prepare: async (impl) => {
      const ctx = await service(impl)
      return () => { sink += ctx.counter.next() }
    },
  },
  {
    id: 'emit-0',
    label: 'emit, 0 listeners',
    iters: 200_000,
    prepare: async (impl) => {
      const ctx = listeners(impl, 0)
      return () => { ctx.emit('tick', 1) }
    },
  },
  {
    id: 'emit-1',
    label: 'emit, 1 listener',
    iters: 200_000,
    prepare: async (impl) => {
      const ctx = listeners(impl, 1)
      return () => { ctx.emit('tick', 1) }
    },
  },
  {
    id: 'emit-5',
    label: 'emit, 5 listeners',
    iters: 200_000,
    prepare: async (impl) => {
      const ctx = listeners(impl, 5)
      return () => { ctx.emit('tick', 1) }
    },
  },
  {
    id: 'emit-20',
    label: 'emit, 20 listeners',
    iters: 120_000,
    prepare: async (impl) => {
      const ctx = listeners(impl, 20)
      return () => { ctx.emit('tick', 1) }
    },
  },
  {
    id: 'events-emit-5',
    label: 'events service emit, 5 listeners',
    iters: 200_000,
    prepare: async (impl) => {
      const ctx = listeners(impl, 5)
      return () => { ctx.events.emit('tick', 1) }
    },
  },
  {
    id: 'dispatch-5',
    label: 'dispatch, 5 listeners',
    iters: 200_000,
    prepare: async (impl) => {
      const ctx = listeners(impl, 5)
      return () => { sink += ctx.events.dispatch('emit', ['tick', 1]).length }
    },
  },
  {
    id: 'waterfall-5',
    label: 'waterfall, 5 listeners',
    iters: 100_000,
    prepare: async (impl) => {
      const ctx = listeners(impl, 5)
      const inner = (value: number) => { sink += value }
      return () => { ctx.waterfall('chain', 1, inner) }
    },
  },
  {
    id: 'effect-noop',
    label: 'effect registration',
    iters: 30_000,
    prepare: async (impl) => {
      const ctx = new impl.Context()
      return () => { ctx.effect(() => () => {}) }
    },
  },
  {
    id: 'logger-suppressed',
    label: 'logger call (suppressed)',
    iters: 50_000,
    prepare: async (impl) => {
      const ctx = new impl.Context()
      ctx.logger.exporter({ levels: { default: -1 }, export: () => {} })
      return () => { ctx.logger.info('hello %s', 'world') }
    },
  },
]

/** Cases whose `emit` listener count feeds the scaling chart. */
export const scalingCases = ['emit-0', 'emit-1', 'emit-5', 'emit-20']
