/**
 * Materialize the two Cordis source trees the benchmark compares.
 *
 * `.work/base`    the pristine sources vendored under `vendor/`
 * `.work/patched` the same sources with `patch/0001-cordis-hot-paths.patch` applied
 *
 * Both trees get their bare `@deepseek-ai/cosmokit` import rewritten to a
 * relative specifier, so plain Node (type stripping) can run them without a
 * package manager, `node_modules`, or a bundler.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const work = join(root, '.work')
const patch = join(root, 'patch', '0001-cordis-hot-paths.patch')

rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
cpSync(join(root, 'vendor'), join(work, 'base'), { recursive: true })
cpSync(join(work, 'base'), join(work, 'patched'), { recursive: true })

execFileSync('git', ['apply', '-p2', '--directory=.work/patched', patch], {
  cwd: root,
  stdio: 'inherit',
})

const importFrom = "from '@deepseek-ai/cosmokit'"
const importTo = "from '../../cosmokit/src/index.ts'"
let rewritten = 0
for (const tree of ['base', 'patched']) {
  const dir = join(work, tree, 'cordis', 'src')
  for (const file of readdirSync(dir)) {
    const path = join(dir, file)
    const source = readFileSync(path, 'utf8')
    if (!source.includes(importFrom)) continue
    writeFileSync(path, source.split(importFrom).join(importTo))
    rewritten += 1
  }
}

const patched = readFileSync(join(work, 'patched', 'cordis', 'src', 'utils.ts'), 'utf8')
if (!patched.includes('traceableCache')) {
  throw new Error('patched tree does not contain the expected changes; patch did not apply')
}

console.log(`prepared .work/base and .work/patched (${rewritten} import rewrites)`)
