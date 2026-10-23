/**
 * Fail the build on a text colour that cannot clear WCAG AA.
 *
 * `src/styles/tokens.css` has always carried contrast ratios in its comments, and the
 * overhaul plan listed this script as CI-enforced. It did not exist. The ratios were
 * therefore whatever they were when someone last worked them out by hand, and `--text-4`
 * had drifted onto section headings and the command palette's labels at 3.1:1 against
 * the surface they sit on — which is what cost the Accessibility score a point, and
 * which no amount of reading the comment would have caught.
 *
 * It checks the tokens against the surfaces, not the rendered page. That is deliberately
 * the smaller claim: a token that fails here fails everywhere it is used, so this is a
 * floor rather than a substitute for an audit of the real DOM.
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const css = readFileSync(join(ROOT, 'src/styles/tokens.css'), 'utf8')

/** WCAG 2.1 relative luminance, sRGB. */
function luminance(hex) {
  const n = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(n.slice(i, i + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function ratio(a, b) {
  const [x, y] = [luminance(a), luminance(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

/**
 * `--name: #rrggbb` from the DEFAULT `:root` block only.
 *
 * The scoping is the whole correctness of this script. `tokens.css` redefines `--text-3`
 * and `--text-4` under `prefers-contrast: more`, so a regex over the whole file keeps
 * whichever declaration comes last and silently measures the high-contrast overrides —
 * which pass trivially, so the gate reports success while the defaults fail. The first
 * `:root { ... }` block is the one that ships to almost everybody.
 */
function defaultRoot() {
  const start = css.indexOf(':root {')
  const end = css.indexOf('\n}', start)
  if (start < 0 || end < 0) throw new Error('check-contrast: no :root block in tokens.css')
  return css.slice(start, end)
}

const root = defaultRoot()

function tokens(prefix) {
  const out = {}
  for (const m of root.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\b/g)) {
    if (m[1].startsWith(prefix)) out[m[1]] = m[2]
  }
  return out
}

const texts = tokens('text-')

/**
 * The backgrounds text actually sits on.
 *
 * `--surface-4` is deliberately absent: it is the scrollbar thumb and the ladder's
 * unshipped tick, never a text background, and including it would fail the gate on a
 * pairing the product never renders. A floor that flags combinations nobody ships is a
 * floor people learn to ignore.
 */
const surfaces = {
  bg: (root.match(/--bg:\s*(#[0-9a-fA-F]{6})/) ?? [])[1],
  'surface-0': texts ? tokens('surface-')['surface-0'] : undefined,
  'surface-1': tokens('surface-')['surface-1'],
  'surface-2': tokens('surface-')['surface-2'],
  'surface-3': tokens('surface-')['surface-3'],
}

/**
 * AA: 4.5 for body text, 3.0 for large text.
 *
 * `text-4` is exempt by policy rather than by arithmetic: it is reserved for genuinely
 * `:disabled` controls, which WCAG does not require to meet contrast, and for icon
 * strokes, which are non-text and need 3.0. That exemption is the whole reason this
 * script has to exist — it is a rule about USE, and a rule about use is exactly the kind
 * that decays silently unless something checks it.
 */
const BODY_AA = 4.5
const NON_TEXT_AA = 3.0
const EXEMPT = { 'text-4': NON_TEXT_AA }

let failed = false
const rows = []

for (const [name, hex] of Object.entries(texts)) {
  const floor = EXEMPT[name] ?? BODY_AA
  for (const [surfaceName, surfaceHex] of Object.entries(surfaces)) {
    if (!surfaceHex) continue
    const r = ratio(hex, surfaceHex)
    const ok = r >= floor
    if (!ok) failed = true
    rows.push({ name, surfaceName, r, floor, ok })
  }
}

const worst = new Map()
for (const row of rows) {
  const held = worst.get(row.name)
  if (!held || row.r < held.r) worst.set(row.name, row)
}

for (const [name, row] of worst) {
  const mark = row.ok ? 'ok  ' : 'FAIL'
  console.log(
    `  ${mark} --${name.padEnd(8)} worst ${row.r.toFixed(2)}:1 against --${row.surfaceName} ` +
      `(floor ${row.floor})${EXEMPT[name] ? '  [non-text / disabled only]' : ''}`,
  )
}

if (failed) {
  console.error('\n[check-contrast] a text token cannot clear its floor. Raise it, or restrict its use.')
  process.exit(1)
}
console.log('\n[check-contrast] every text token clears WCAG AA against every surface.')
