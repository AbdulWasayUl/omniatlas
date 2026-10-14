/**
 * build-stars.mjs — OmniAtlas stellar catalogue ETL.
 *
 * Produces tiered, quantized star data under public/data/stars/ from:
 *   - AT-HYG v4.0 (Astronomy Nexus / David Nash)  — the star catalogue        [CC BY-SA 4.0]
 *   - HYG v4.1 (same author, GitHub)              — variability/multiplicity  [CC BY-SA 4.0]
 *   - Stellarium `modern_iau` skyculture          — constellation figures     [GPL-2.0-or-later / CC BY-SA 4.0]
 *   - NASA Exoplanet Archive `pscomppars` (TAP)   — exoplanet host flags      [public domain]
 *
 * Run:  node scripts/build-stars.mjs            (uses .cache/, offline-safe after first run)
 *       node scripts/build-stars.mjs --refresh  (re-downloads sources)
 *
 * Zero npm dependencies — Node builtins only.
 */

import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createGunzip } from 'node:zlib'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'

// ---------------------------------------------------------------------------
// Configuration — every source pinned to an immutable revision.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE_DIR = join(REPO_ROOT, '.cache')
const OUT_DIR = join(REPO_ROOT, 'public', 'data', 'stars')

const RETRIEVED = '2026-10-14'
const REFRESH = process.argv.includes('--refresh')

/**
 * GOTCHA (verified 2026-10-14): Codeberg serves the AT-HYG data files through Git-LFS.
 * The `/raw/` path and the contents API both return a 133-byte LFS *pointer* file,
 * not the data. Only `/media/` resolves the pointer. Always sanity-check the gzip magic.
 */
const ATHYG = {
  repo: 'https://codeberg.org/astronexus/athyg',
  commit: 'eebe42b3552ae04e67d27ae085a8aad997b42bc0', // branch `main` @ 2026-07-26
  version: 'AT-HYG v4.0',
  licence: 'CC BY-SA 4.0',
  files: {
    // Primary catalogue: all AT-HYG stars to V/VT magnitude 10, plus everything within 100 ly.
    m10: 'data/subsets/athyg_40_reduced_m10.csv.gz',
  },
}
const athygUrl = (p) => `${ATHYG.repo}/media/commit/${ATHYG.commit}/${p}`

/**
 * GOTCHA (verified 2026-10-14): AT-HYG v4.0 has no variability or multiplicity columns, and
 * its own `hyglike_from_athyg_v40.csv.gz` — which carries the HYG column *names*
 * (`var`, `var_min`, `var_max`, `comp`, `comp_primary`, `base`, `lum`) — ships every one of
 * those columns EMPTY in all 119,670 rows. The original HYG database is the only place the
 * values actually live, so is-variable / is-multiple come from HYG v4.1, joined on HIP then HD.
 */
const HYG = {
  repo: 'https://github.com/astronexus/HYG-Database',
  commit: '3bf37f4b2d5460e1278286320d1d62fab9b493c1', // last commit touching the file, 2024-08-17
  path: 'hyg/CURRENT/hygdata_v41.csv',
  version: 'HYG v4.1',
  licence: 'CC BY-SA 4.0',
}
const hygUrl = () => `https://raw.githubusercontent.com/astronexus/HYG-Database/${HYG.commit}/${HYG.path}`

const STELLARIUM = {
  repo: 'https://github.com/Stellarium/stellarium',
  tag: 'v26.3',
  path: 'skycultures/modern_iau/index.json',
  licence: 'GPL-2.0-or-later (code) / CC BY-SA 4.0 (skyculture data)',
}
const stellariumUrl = () =>
  `https://raw.githubusercontent.com/Stellarium/stellarium/${STELLARIUM.tag}/${STELLARIUM.path}`

/**
 * GOTCHA (verified 2026-10-14): the join column is `gaia_dr3_id`, whose values carry a
 * literal "Gaia DR3 " prefix. A column named `gaia_id` does not exist and the TAP service
 * answers with `ORA-00904: 'GAIA_ID': invalid identifier`.
 */
const EXO = {
  tap: 'https://exoplanetarchive.ipac.caltech.edu/TAP/sync',
  table: 'pscomppars',
  columns: 'pl_name,hostname,hd_name,hip_name,gaia_dr3_id,sy_pnum,ra,dec,sy_vmag',
  licence: 'Public domain (NASA Exoplanet Archive, NASA/Caltech)',
}
const exoUrl = () =>
  `${EXO.tap}?query=${encodeURIComponent(`select ${EXO.columns} from ${EXO.table}`)}&format=csv`

// Tier cuts. Chosen to hit the byte budgets in docs/OVERHAUL_PLAN.md "Data plan > Stellar".
const L0_MAG_MAX = 6.5 // naked-eye sky
const L1_MAG_MAX = 8.0 // + everything within 50 pc, + every named / constellation star
const L1_DIST_MAX_PC = 50
const NSIDE = 4 // HEALPix NESTED, 12 * 4^2 = 192 chunks
const CI_DEFAULT = 0.65 // solar B-V, used when AT-HYG has no colour index

// Quantization constants. Dequantization formulae are repeated in every manifest.
const MAG_SCALE = 16 //  magu = round((mag + 2) * 16)   -> mag = magu / 16 - 2
const MAG_OFFSET = 2
const CI_SCALE = 40 //   ciu  = round((ci + 0.5) * 40)   -> ci  = ciu / 40 - 0.5
const CI_OFFSET = 0.5
const I16_MAX = 32767

const FLAG = {
  PROPER_NAME: 1 << 0,
  EXOPLANET: 1 << 1,
  VARIABLE: 1 << 2,
  MULTIPLE: 1 << 3,
  CI_DEFAULTED: 1 << 4,
  BAYER_FLAMSTEED: 1 << 5,
  ABSMAG_MISSING: 1 << 6,
  CI_FROM_HYG: 1 << 7,
}
const FLAG_DOC = {
  'bit0 (0x01)': 'has-proper-name — AT-HYG `proper` column is non-empty',
  'bit1 (0x02)': 'has-exoplanet — host matched a NASA Exoplanet Archive pscomppars row',
  'bit2 (0x04)': 'is-variable — HYG v4.1 `var` (variable-star designation) is non-empty for the HIP/HD-matched row',
  'bit3 (0x08)': 'is-multiple — HYG v4.1 `base` non-empty or `comp` > 1 for the HIP/HD-matched row',
  'bit4 (0x10)': `ci-was-defaulted — AT-HYG \`ci\` was empty; the stored value is the solar default ${CI_DEFAULT}`,
  'bit5 (0x20)': 'has-bayer-or-flamsteed — AT-HYG `bayer` or `flam` is non-empty',
  'bit6 (0x40)': 'absmag-missing — AT-HYG `absmag` was empty (derive it from mag + distance instead)',
  'bit7 (0x80)': 'ci-from-hyg — AT-HYG had no colour index, so it was back-filled from HYG v4.1 (bit4 is then clear)',
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const log = (s = '') => process.stdout.write(`${s}\n`)
const fmtBytes = (n) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1048576).toFixed(2)} MiB`
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/** Download once into .cache/. Reruns are fast and offline-safe. */
async function cached(name, url, { expectGzip = false } = {}) {
  mkdirSync(CACHE_DIR, { recursive: true })
  const path = join(CACHE_DIR, name)
  if (existsSync(path) && !REFRESH) {
    log(`  cache hit  ${name} (${fmtBytes(statSync(path).size)})`)
    return path
  }
  log(`  fetching   ${url}`)
  const res = await fetch(url, { headers: { 'user-agent': 'OmniAtlas-build/1.0 (+scripts/build-stars.mjs)' } })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())

  // Guard against the Git-LFS pointer trap and against silent HTML/error bodies.
  if (buf.length < 1024 && buf.toString('utf8', 0, Math.min(200, buf.length)).includes('git-lfs')) {
    throw new Error(`${url} returned a ${buf.length}-byte Git-LFS pointer, not the data. Use the /media/ path.`)
  }
  if (expectGzip && !(buf[0] === 0x1f && buf[1] === 0x8b)) {
    throw new Error(`${url} did not return gzip (first bytes ${buf.subarray(0, 4).toString('hex')}, ${buf.length} B)`)
  }
  writeFileSync(path, buf)
  log(`  saved      ${name} (${fmtBytes(buf.length)}, sha256 ${sha256(buf).slice(0, 16)}…)`)
  return path
}

/** Quote-aware CSV field splitter. AT-HYG's `spect` column holds values like "F0I:,F2II:". */
function splitCsv(line) {
  const out = []
  let cur = ''
  let q = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else q = false
      } else cur += c
    } else if (c === '"') q = true
    else if (c === ',') {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out
}

async function* csvRows(path, { gzip = false } = {}) {
  let stream = createReadStream(path)
  if (gzip) stream = stream.pipe(createGunzip())
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  let idx = null
  for await (const line of rl) {
    if (line === '') continue
    const fields = splitCsv(line)
    if (idx === null) {
      idx = Object.fromEntries(fields.map((h, i) => [h.trim().replace(/^"|"$/g, ''), i]))
      continue
    }
    yield { fields, idx }
  }
}

const num = (s) => (s === '' || s === undefined ? NaN : Number(s))

// ---------------------------------------------------------------------------
// HEALPix — ang2pix_nest / pix2ang_nest, NESTED scheme, self-contained.
// Reference: Gorski et al. 2005, ApJ 622, 759 (the healpix_base algorithm).
// ---------------------------------------------------------------------------

const JRLL = [2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4]
const JPLL = [1, 3, 5, 7, 0, 2, 4, 6, 1, 3, 5, 7]

/** Spread the low 16 bits of v into the even bit positions of a 32-bit word. */
function spreadBits(v) {
  let x = v & 0xffff
  x = (x | (x << 8)) & 0x00ff00ff
  x = (x | (x << 4)) & 0x0f0f0f0f
  x = (x | (x << 2)) & 0x33333333
  x = (x | (x << 1)) & 0x55555555
  return x >>> 0
}

/** Inverse of spreadBits: gather the even bits of x into the low bits. */
function compressBits(x) {
  let v = x & 0x55555555
  v = (v | (v >>> 1)) & 0x33333333
  v = (v | (v >>> 2)) & 0x0f0f0f0f
  v = (v | (v >>> 4)) & 0x00ff00ff
  v = (v | (v >>> 8)) & 0x0000ffff
  return v >>> 0
}

/** theta: colatitude in [0, pi]; phi: longitude in radians (any real). Returns a NESTED pixel index. */
function ang2pixNest(nside, theta, phi) {
  const order = Math.log2(nside) | 0
  const z = Math.cos(theta)
  const za = Math.abs(z)
  let tt = (phi / (Math.PI / 2)) % 4
  if (tt < 0) tt += 4

  let face, ix, iy
  if (za <= 2 / 3) {
    // Equatorial region: intersect the two families of 45-degree lines.
    const temp1 = nside * (0.5 + tt)
    const temp2 = nside * (z * 0.75)
    const jp = Math.floor(temp1 - temp2) // ascending edge line index
    const jm = Math.floor(temp1 + temp2) // descending edge line index
    const ifp = jp >> order // in {0, 4}
    const ifm = jm >> order
    if (ifp === ifm) face = (ifp & 3) + 4
    else if (ifp < ifm) face = ifp & 3
    else face = (ifm & 3) + 8
    ix = jm & (nside - 1)
    iy = nside - (jp & (nside - 1)) - 1
  } else {
    // Polar caps.
    const ntt = Math.min(3, Math.floor(tt))
    const tp = tt - ntt
    const tmp = nside * Math.sqrt(3 * (1 - za))
    let jp = Math.floor(tp * tmp)
    let jm = Math.floor((1 - tp) * tmp)
    if (jp >= nside) jp = nside - 1
    if (jm >= nside) jm = nside - 1
    if (z >= 0) {
      face = ntt
      ix = nside - jm - 1
      iy = nside - jp - 1
    } else {
      face = ntt + 8
      ix = jp
      iy = jm
    }
  }
  return face * nside * nside + (spreadBits(ix) | (spreadBits(iy) << 1))
}

/** Inverse: the centre of NESTED pixel `pix` as [theta, phi]. */
function pix2angNest(nside, pix) {
  const npface = nside * nside
  const npix = 12 * npface
  const fact2 = 4 / npix
  const fact1 = (nside << 1) * fact2
  const face = Math.floor(pix / npface)
  const p = pix - face * npface
  const ix = compressBits(p)
  const iy = compressBits(p >>> 1)

  const jr = JRLL[face] * nside - ix - iy - 1
  let nr, z, kshift
  if (jr < nside) {
    nr = jr
    z = 1 - nr * nr * fact2
    kshift = 0
  } else if (jr > 3 * nside) {
    nr = nside * 4 - jr
    z = nr * nr * fact2 - 1
    kshift = 0
  } else {
    nr = nside
    z = (2 * nside - jr) * fact1
    kshift = (jr - nside) & 1
  }

  let jp = Math.floor((JPLL[face] * nr + ix - iy + 1 + kshift) / 2)
  if (jp > 4 * nside) jp -= 4 * nside
  if (jp < 1) jp += 4 * nside
  return [Math.acos(z), (jp - (kshift + 1) * 0.5) * (Math.PI / 2 / nr)]
}

/**
 * Self-test for the HEALPix implementation — four independent checks:
 *
 *  1. Published nside=1 pixel centres. Pixels 0 / 4 / 8 must sit at (acos(2/3), pi/4),
 *     (pi/2, 0) and (acos(-2/3), pi/4) — the values healpy's pix2ang returns.
 *  2. Exhaustive round trip: ang2pix_nest(pix2ang_nest(p)) === p for every pixel at
 *     nside 1, 2, 4, 8 and 16 (16,524 pixels). Catches any face/bit-interleave error
 *     that is not an exact self-inverse.
 *  3. Hierarchy: ang2pix_nest(4, d) >>> 4 === ang2pix_nest(1, d) for 200,000 random
 *     directions. This is NESTED's defining property and is independent of check 2 —
 *     it ties two different nside values of the forward transform together.
 *  4. Equal area: 1,000,000 uniform random directions binned at nside=4 must fill all
 *     192 pixels with every count within 5 sigma of N/192. HEALPix pixels are equal-area
 *     by construction, so any geometric distortion shows up here immediately.
 */
function healpixSelfTest() {
  const results = []
  const approx = (a, b, tol) => Math.abs(a - b) <= tol

  // 1. Published nside=1 centres.
  const known = [
    [0, Math.acos(2 / 3), Math.PI / 4],
    [4, Math.PI / 2, 0],
    [8, Math.acos(-2 / 3), Math.PI / 4],
  ]
  let ok1 = true
  for (const [p, th, ph] of known) {
    const [t, f] = pix2angNest(1, p)
    if (!approx(t, th, 1e-12) || !approx(f, ph, 1e-12)) ok1 = false
    if (ang2pixNest(1, th, ph) !== p) ok1 = false
  }
  results.push([ok1, 'nside=1 pixel centres 0/4/8 match the published HEALPix values (acos(+-2/3), pi/4) and (pi/2, 0)'])

  // 2. Exhaustive round trip.
  let ok2 = true
  let pixTested = 0
  for (const ns of [1, 2, 4, 8, 16]) {
    for (let p = 0; p < 12 * ns * ns; p++) {
      pixTested++
      const [t, f] = pix2angNest(ns, p)
      if (ang2pixNest(ns, t, f) !== p) {
        ok2 = false
        break
      }
    }
  }
  results.push([ok2, `ang2pix_nest(pix2ang_nest(p)) === p for all ${pixTested.toLocaleString()} pixels at nside 1,2,4,8,16`])

  // Deterministic PRNG so the test is reproducible run to run.
  let seed = 0x02f6e2b1 >>> 0
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296)

  // 3. Hierarchy.
  let ok3 = true
  for (let i = 0; i < 200000; i++) {
    const t = Math.acos(2 * rnd() - 1)
    const f = 2 * Math.PI * rnd()
    if (ang2pixNest(4, t, f) >>> 4 !== ang2pixNest(1, t, f)) {
      ok3 = false
      break
    }
  }
  results.push([ok3, 'ang2pix_nest(4, d) >>> 4 === ang2pix_nest(1, d) for 200,000 random directions'])

  // 4. Equal area.
  const N = 1000000
  const hist = new Int32Array(192)
  for (let i = 0; i < N; i++) {
    const t = Math.acos(2 * rnd() - 1)
    const f = 2 * Math.PI * rnd()
    hist[ang2pixNest(4, t, f)]++
  }
  const mean = N / 192
  const sigma = Math.sqrt(mean * (1 - 1 / 192))
  let worst = 0
  let empty = 0
  for (const c of hist) {
    if (c === 0) empty++
    worst = Math.max(worst, Math.abs(c - mean) / sigma)
  }
  const ok4 = empty === 0 && worst < 5
  results.push([
    ok4,
    `equal-area: 1,000,000 uniform directions at nside=4 fill all 192 pixels, worst deviation ${worst.toFixed(2)} sigma (expect < 5)`,
  ])

  for (const [ok, msg] of results) log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`)
  if (results.some(([ok]) => !ok)) throw new Error('HEALPix self-test failed — refusing to emit data')
  return results.map(([ok, msg]) => `${ok ? 'PASS' : 'FAIL'}: ${msg}`)
}

// ---------------------------------------------------------------------------
// 1. Sources
// ---------------------------------------------------------------------------

log('OmniAtlas — build-stars.mjs')
log('')
log('[1/8] HEALPix self-test')
const healpixChecks = healpixSelfTest()

log('')
log('[2/8] Sources')
const m10Path = await cached('athyg_40_reduced_m10.csv.gz', athygUrl(ATHYG.files.m10), { expectGzip: true })
const hygPath = await cached('hyg_v41.csv', hygUrl())
const conPath = await cached('stellarium_modern_iau_index.json', stellariumUrl())
const exoPath = await cached('nasa_exoplanet_pscomppars.csv', exoUrl())

mkdirSync(join(OUT_DIR, 'l2'), { recursive: true })

// ---------------------------------------------------------------------------
// 2. Constellation figures (loaded first — their stars are force-promoted into L1)
// ---------------------------------------------------------------------------

log('')
log('[3/8] Constellation figures (Stellarium modern_iau)')
const skyculture = JSON.parse(readFileSync(conPath, 'utf8'))
const conFigures = []
const conHipWanted = new Set()
for (const c of skyculture.constellations) {
  const abbr = String(c.id).replace(/^CON\s+\S+\s+/, '')
  const pairs = []
  for (const polyline of c.lines ?? []) {
    for (let i = 0; i + 1 < polyline.length; i++) {
      pairs.push([polyline[i], polyline[i + 1]])
      conHipWanted.add(polyline[i])
      conHipWanted.add(polyline[i + 1])
    }
  }
  conFigures.push({
    id: abbr,
    name: c.common_name?.native ?? c.common_name?.english ?? abbr,
    english: c.common_name?.english ?? abbr,
    byname: c.common_name?.byname ?? null,
    pairs,
  })
}
const conSegmentsRaw = conFigures.reduce((acc, c) => acc + c.pairs.length, 0)
log(`  ${conFigures.length} constellations, ${conSegmentsRaw} raw segments, ${conHipWanted.size} distinct HIP ids referenced`)

// ---------------------------------------------------------------------------
// 3. AT-HYG primary catalogue
// ---------------------------------------------------------------------------

log('')
log('[4/8] AT-HYG v4.0 reduced_m10')

const CAP = 400000
const sx = new Float64Array(CAP)
const sy = new Float64Array(CAP)
const sz = new Float64Array(CAP)
const sdist = new Float64Array(CAP)
const smag = new Float32Array(CAP)
const sci = new Float32Array(CAP)
const sflags = new Uint8Array(CAP)
const scon = new Uint8Array(CAP).fill(255)
const ship = new Int32Array(CAP)
const shd = new Int32Array(CAP)
const shr = new Int32Array(CAP)
const shyg = new Int32Array(CAP)
const sproper = new Array(CAP).fill(null)
const sbayer = new Array(CAP).fill(null)
const sflam = new Array(CAP).fill(null)
const sgl = new Array(CAP).fill(null)
const sspect = new Array(CAP).fill(null)

const conAbbrIndex = new Map()
const conAbbrList = []
const hipToStar = new Map()
const hdToStar = new Map()
const hygToStar = new Map()
const gaiaToStar = new Map()

let rows = 0
let n = 0
let droppedNoPosition = 0
let droppedSol = 0
let droppedNoMag = 0
let ciDefaulted = 0
let absmagMissing = 0
let maxDistPc = 0

{
  let expected = -1
  for await (const { fields: f, idx } of csvRows(m10Path, { gzip: true })) {
    if (expected < 0) {
      expected = Object.keys(idx).length
      for (const col of ['id', 'hip', 'hd', 'hr', 'gl', 'bayer', 'flam', 'con', 'proper', 'x0', 'y0', 'z0', 'mag', 'absmag', 'ci', 'gaia', 'hyg', 'spect', 'dist', 'ra', 'dec']) {
        if (!(col in idx)) throw new Error(`AT-HYG header is missing the expected column \`${col}\``)
      }
    }
    rows++
    if (f.length !== expected) throw new Error(`AT-HYG row ${rows}: ${f.length} fields, expected ${expected}`)
    if (n >= CAP) throw new Error(`more than ${CAP} stars — raise CAP`)

    // Row id=1 is Sol itself; the solar-system module renders the Sun.
    if (Number(f[idx.id]) === 1) {
      droppedSol++
      continue
    }

    const x = num(f[idx.x0])
    const y = num(f[idx.y0])
    const z = num(f[idx.z0])
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      droppedNoPosition++
      continue
    }
    const mag = num(f[idx.mag])
    if (!Number.isFinite(mag)) {
      droppedNoMag++
      continue
    }

    let flags = 0
    let ci = num(f[idx.ci])
    if (!Number.isFinite(ci)) {
      ci = CI_DEFAULT
      flags |= FLAG.CI_DEFAULTED
      ciDefaulted++
    }
    if (f[idx.absmag] === '') {
      flags |= FLAG.ABSMAG_MISSING
      absmagMissing++
    }

    const proper = f[idx.proper] || null
    const bayer = f[idx.bayer] || null
    const flam = f[idx.flam] || null
    if (proper) flags |= FLAG.PROPER_NAME
    if (bayer || flam) flags |= FLAG.BAYER_FLAMSTEED

    const i = n++
    sx[i] = x
    sy[i] = y
    sz[i] = z
    const d = Math.hypot(x, y, z)
    sdist[i] = d
    if (d > maxDistPc) maxDistPc = d
    smag[i] = mag
    sci[i] = ci
    sflags[i] = flags

    const con = f[idx.con]
    if (con) {
      let ci2 = conAbbrIndex.get(con)
      if (ci2 === undefined) {
        ci2 = conAbbrList.length
        conAbbrIndex.set(con, ci2)
        conAbbrList.push(con)
      }
      scon[i] = ci2
    }

    const hip = num(f[idx.hip])
    const hd = num(f[idx.hd])
    const hr = num(f[idx.hr])
    const hyg = num(f[idx.hyg])
    ship[i] = Number.isFinite(hip) ? hip : 0
    shd[i] = Number.isFinite(hd) ? hd : 0
    shr[i] = Number.isFinite(hr) ? hr : 0
    shyg[i] = Number.isFinite(hyg) ? hyg : 0
    if (ship[i] && !hipToStar.has(ship[i])) hipToStar.set(ship[i], i)
    if (shd[i] && !hdToStar.has(shd[i])) hdToStar.set(shd[i], i)
    if (shyg[i] && !hygToStar.has(shyg[i])) hygToStar.set(shyg[i], i)
    // Gaia DR3 source_ids exceed 2^53 — keep them as strings.
    const gaia = f[idx.gaia] || null
    if (gaia && !gaiaToStar.has(gaia)) gaiaToStar.set(gaia, i)

    sproper[i] = proper
    sbayer[i] = bayer
    sflam[i] = flam
    sgl[i] = f[idx.gl] || null
    sspect[i] = f[idx.spect] || null
  }
}
log(`  ${rows.toLocaleString()} CSV rows -> ${n.toLocaleString()} usable stars`)
log(`  dropped: Sol ${droppedSol}, no position ${droppedNoPosition}, no magnitude ${droppedNoMag}`)
log(`  ci defaulted to ${CI_DEFAULT}: ${ciDefaulted.toLocaleString()} | absmag missing: ${absmagMissing.toLocaleString()}`)
log(`  max distance ${maxDistPc.toFixed(0)} pc | ${conAbbrList.length} constellation abbreviations`)

// Verify the documented frame assumption against the real data rather than trusting it:
// x0/y0/z0 must equal dist * (cos dec cos ra, cos dec sin ra, sin dec) with ra in HOURS.
{
  let worst = 0
  let checked = 0
  for await (const { fields: f, idx } of csvRows(m10Path, { gzip: true })) {
    const ra = num(f[idx.ra])
    const dec = num(f[idx.dec])
    const d = num(f[idx.dist])
    const x = num(f[idx.x0])
    const y = num(f[idx.y0])
    const z = num(f[idx.z0])
    if (![ra, dec, d, x, y, z].every(Number.isFinite) || d < 1) continue
    const rr = (ra * 15 * Math.PI) / 180 // ra is in HOURS, not degrees
    const dd = (dec * Math.PI) / 180
    const ex = d * Math.cos(dd) * Math.cos(rr)
    const ey = d * Math.cos(dd) * Math.sin(rr)
    const ez = d * Math.sin(dd)
    worst = Math.max(worst, Math.hypot(ex - x, ey - y, ez - z) / d)
    if (++checked >= 20000) break
  }
  log(`  frame check: x0/y0/z0 == dist * unit(ra[HOURS], dec) to ${worst.toExponential(2)} relative error over ${checked.toLocaleString()} rows`)
  if (worst > 1e-3) throw new Error('x0/y0/z0 disagree with ra/dec/dist — the frame assumption is wrong')
}

// ---------------------------------------------------------------------------
// 4. Variability / multiplicity / missing colour index, from HYG v4.1 joined on HIP then HD
// ---------------------------------------------------------------------------

log('')
log('[5/8] Variability, multiplicity & colour back-fill (HYG v4.1)')
let variableSet = 0
let multipleSet = 0
let ciBackfilled = 0
let hygRows = 0
let hygJoined = 0
let hygUnjoined = 0
for await (const { fields: f, idx } of csvRows(hygPath)) {
  hygRows++
  const hip = num(f[idx.hip])
  const hd = num(f[idx.hd])
  let i
  if (Number.isFinite(hip) && hip > 0) i = hipToStar.get(hip)
  if (i === undefined && Number.isFinite(hd) && hd > 0) i = hdToStar.get(hd)
  if (i === undefined) {
    hygUnjoined++
    continue
  }
  hygJoined++
  if ((f[idx.var] ?? '') !== '') {
    sflags[i] |= FLAG.VARIABLE
    variableSet++
  }
  const comp = num(f[idx.comp])
  if ((f[idx.base] ?? '') !== '' || (Number.isFinite(comp) && comp > 1)) {
    sflags[i] |= FLAG.MULTIPLE
    multipleSet++
  }
  // AT-HYG drops the B-V of a number of very bright stars (Sirius, Vega and Arcturus among
  // them). HYG v4.1 still carries it, so back-fill rather than leaving them at the solar
  // default — otherwise the brightest stars in the sky all render the same colour.
  if (sflags[i] & FLAG.CI_DEFAULTED) {
    const hygCi = num(f[idx.ci])
    if (Number.isFinite(hygCi)) {
      sci[i] = hygCi
      sflags[i] = (sflags[i] & ~FLAG.CI_DEFAULTED) | FLAG.CI_FROM_HYG
      ciBackfilled++
    }
  }
}
log(
  `  ${hygRows.toLocaleString()} HYG v4.1 rows: ${hygJoined.toLocaleString()} joined on HIP/HD, ${hygUnjoined.toLocaleString()} unjoined`,
)
log(
  `  variable ${variableSet.toLocaleString()}, multiple ${multipleSet.toLocaleString()}, colour index back-filled ${ciBackfilled.toLocaleString()} (${(ciDefaulted - ciBackfilled).toLocaleString()} still at the ${CI_DEFAULT} default)`,
)

// ---------------------------------------------------------------------------
// 5. Exoplanet hosts
// ---------------------------------------------------------------------------

log('')
log('[6/8] NASA Exoplanet Archive pscomppars')

// Coarse 1-degree RA/Dec grid for the positional fallback match.
const raDecGrid = new Map()
const starRa = new Float64Array(n)
const starDec = new Float64Array(n)
for (let i = 0; i < n; i++) {
  const d = sdist[i]
  if (d <= 0) continue
  const dec = Math.asin(Math.max(-1, Math.min(1, sz[i] / d))) * (180 / Math.PI)
  let ra = Math.atan2(sy[i], sx[i]) * (180 / Math.PI)
  if (ra < 0) ra += 360
  starRa[i] = ra
  starDec[i] = dec
  const key = `${Math.floor(ra)}|${Math.floor(dec + 90)}`
  let bucket = raDecGrid.get(key)
  if (!bucket) raDecGrid.set(key, (bucket = []))
  bucket.push(i)
}
const MATCH_TOL_ARCSEC = 10
function matchByRaDec(raDeg, decDeg) {
  const tol = MATCH_TOL_ARCSEC / 3600
  const cd = Math.cos((decDeg * Math.PI) / 180)
  let best = -1
  let bestSep = Infinity
  for (let dr = -1; dr <= 1; dr++) {
    for (let dd = -1; dd <= 1; dd++) {
      const key = `${(Math.floor(raDeg) + dr + 360) % 360}|${Math.floor(decDeg + 90) + dd}`
      const bucket = raDecGrid.get(key)
      if (!bucket) continue
      for (const i of bucket) {
        let dra = starRa[i] - raDeg
        if (dra > 180) dra -= 360
        if (dra < -180) dra += 360
        const sep = Math.hypot(dra * cd, starDec[i] - decDeg)
        if (sep < bestSep) {
          bestSep = sep
          best = i
        }
      }
    }
  }
  return bestSep <= tol ? best : -1
}

const hosts = new Map()
let exoRows = 0
for await (const { fields: f, idx } of csvRows(exoPath)) {
  exoRows++
  const hostname = f[idx.hostname]
  if (!hostname) continue
  let h = hosts.get(hostname)
  if (!h) {
    const gaiaRaw = f[idx.gaia_dr3_id] || ''
    hosts.set(
      hostname,
      (h = {
        host: hostname,
        planets: 0,
        // GOTCHA: values look like "Gaia DR3 4919009555730599936" — strip the prefix before joining.
        gaia: gaiaRaw.replace(/^Gaia\s+DR3\s*/i, '').trim() || null,
        hip: /(\d+)/.exec(f[idx.hip_name] || '')?.[1] ?? null,
        hd: /HD\s*(\d+)/i.exec(f[idx.hd_name] || '')?.[1] ?? null,
        ra: num(f[idx.ra]),
        dec: num(f[idx.dec]),
        vmag: Number.isFinite(num(f[idx.sy_vmag])) ? num(f[idx.sy_vmag]) : null,
        star: -1,
        via: null,
      }),
    )
  }
  h.planets++
}

const matchCounts = { gaia_dr3: 0, hip: 0, hd: 0, radec: 0, none: 0 }
for (const h of hosts.values()) {
  let i = -1
  let via = null
  if (h.gaia && gaiaToStar.has(h.gaia)) {
    i = gaiaToStar.get(h.gaia)
    via = 'gaia_dr3'
  }
  if (i < 0 && h.hip && hipToStar.has(Number(h.hip))) {
    i = hipToStar.get(Number(h.hip))
    via = 'hip'
  }
  if (i < 0 && h.hd && hdToStar.has(Number(h.hd))) {
    i = hdToStar.get(Number(h.hd))
    via = 'hd'
  }
  if (i < 0 && Number.isFinite(h.ra) && Number.isFinite(h.dec)) {
    const j = matchByRaDec(h.ra, h.dec)
    if (j >= 0) {
      i = j
      via = `radec<=${MATCH_TOL_ARCSEC}arcsec`
    }
  }
  h.star = i
  h.via = via
  if (i >= 0) {
    sflags[i] |= FLAG.EXOPLANET
    matchCounts[via.startsWith('radec') ? 'radec' : via]++
  } else matchCounts.none++
}
const matchedHosts = hosts.size - matchCounts.none
log(`  ${exoRows.toLocaleString()} planet rows, ${hosts.size.toLocaleString()} distinct hosts`)
log(
  `  matched ${matchedHosts.toLocaleString()}/${hosts.size.toLocaleString()} (${((100 * matchedHosts) / hosts.size).toFixed(1)}%) — gaia_dr3 ${matchCounts.gaia_dr3}, hip ${matchCounts.hip}, hd ${matchCounts.hd}, ra/dec ${matchCounts.radec}, unmatched ${matchCounts.none}`,
)

// ---------------------------------------------------------------------------
// 6. Tier assignment
// ---------------------------------------------------------------------------

log('')
log('[7/8] Tiering & quantization')

// Force constellation-figure stars and named stars into L1 so figure lines and labels
// always resolve against the two tiers that are resident before L2 streaming begins.
const promote = new Uint8Array(n)
let promotedCon = 0
let promotedNamed = 0
for (const hip of conHipWanted) {
  const i = hipToStar.get(hip)
  if (i !== undefined && smag[i] > L1_MAG_MAX && sdist[i] > L1_DIST_MAX_PC) {
    promote[i] = 1
    promotedCon++
  }
}
for (let i = 0; i < n; i++) {
  if (promote[i]) continue
  if (!(sflags[i] & (FLAG.PROPER_NAME | FLAG.BAYER_FLAMSTEED))) continue
  if (smag[i] <= L1_MAG_MAX || sdist[i] <= L1_DIST_MAX_PC) continue
  promote[i] = 1
  promotedNamed++
}

const l0src = []
const l1src = []
const l2src = []
for (let i = 0; i < n; i++) {
  if (smag[i] <= L0_MAG_MAX) l0src.push(i)
  else if (smag[i] <= L1_MAG_MAX || sdist[i] <= L1_DIST_MAX_PC || promote[i]) l1src.push(i)
  else l2src.push(i)
}
l0src.sort((a, b) => smag[a] - smag[b])
l1src.sort((a, b) => smag[a] - smag[b])

// Global index space is the concatenation L0 ++ L1. The three tiers are disjoint.
const globalIndex = new Int32Array(n).fill(-1)
l0src.forEach((s, k) => {
  globalIndex[s] = k
})
l1src.forEach((s, k) => {
  globalIndex[s] = l0src.length + k
})

log(`  L0  mag <= ${L0_MAG_MAX}                                        ${l0src.length.toLocaleString().padStart(9)} stars`)
log(`  L1  mag <= ${L1_MAG_MAX} | d <= ${L1_DIST_MAX_PC} pc | +${promotedCon} figure +${promotedNamed} named    ${l1src.length.toLocaleString().padStart(9)} stars`)
log(`  L2  remainder, HEALPix NESTED nside=${NSIDE}                    ${l2src.length.toLocaleString().padStart(9)} stars`)

// ---------------------------------------------------------------------------
// 7. Encode
// ---------------------------------------------------------------------------

const quantMag = (m) => Math.max(0, Math.min(255, Math.round((m + MAG_OFFSET) * MAG_SCALE)))
const quantCi = (c) => Math.max(0, Math.min(255, Math.round((c + CI_OFFSET) * CI_SCALE)))

let magClamped = 0
let ciClamped = 0
for (let i = 0; i < n; i++) {
  const mv = (smag[i] + MAG_OFFSET) * MAG_SCALE
  const cv = (sci[i] + CI_OFFSET) * CI_SCALE
  if (mv < 0 || mv > 255) magClamped++
  if (cv < 0 || cv > 255) ciClamped++
}

/** Layout A (L0/L1): f32 x[] y[] z[] | u8 magu[] ciu[] flags[] con[]  = 16 B/record. */
function encodeTierA(src) {
  const m = src.length
  const buf = Buffer.alloc(16 * m)
  for (let k = 0; k < m; k++) {
    const i = src[k]
    buf.writeFloatLE(sx[i], 4 * k)
    buf.writeFloatLE(sy[i], 4 * m + 4 * k)
    buf.writeFloatLE(sz[i], 8 * m + 4 * k)
    buf[12 * m + k] = quantMag(smag[i])
    buf[13 * m + k] = quantCi(sci[i])
    buf[14 * m + k] = sflags[i]
    buf[15 * m + k] = scon[i]
  }
  return buf
}
const tierAFields = (m) => [
  { name: 'x', dtype: 'float32', count: m, byteOffset: 0, units: 'pc' },
  { name: 'y', dtype: 'float32', count: m, byteOffset: 4 * m, units: 'pc' },
  { name: 'z', dtype: 'float32', count: m, byteOffset: 8 * m, units: 'pc' },
  { name: 'magu', dtype: 'uint8', count: m, byteOffset: 12 * m, units: 'quantized apparent magnitude' },
  { name: 'ciu', dtype: 'uint8', count: m, byteOffset: 13 * m, units: 'quantized Johnson B-V colour index' },
  { name: 'flags', dtype: 'uint8', count: m, byteOffset: 14 * m, units: 'bitfield' },
  { name: 'con', dtype: 'uint8', count: m, byteOffset: 15 * m, units: 'index into `constellations`; 255 = none' },
]

/**
 * Layout B (L2 chunks): i16 x[] y[] z[] | u8 magu[] ciu[] flags[]  = 9 B/record.
 *
 * Positions are int16-quantized PER DISTANCE SHELL inside each HEALPix chunk. A single
 * scale per chunk would be set by that chunk's most distant star and would wreck the near
 * shells — one 300 kpc bad-parallax outlier gives ~16 pc of error at 20 pc. Shells are
 * octaves: shell k covers r in (2^(k-1), 2^k] pc, scale_k = 2^k / 32767. Stars inside a
 * chunk are ordered by shell, so shell membership is a byte range in the manifest and
 * costs nothing in the payload.
 */
const shellOf = (r) => (r <= 1 ? 0 : Math.ceil(Math.log2(r)))

const NPIX = 12 * NSIDE * NSIDE
const l2ByPix = Array.from({ length: NPIX }, () => [])
for (const i of l2src) {
  const d = sdist[i]
  const theta = Math.acos(Math.max(-1, Math.min(1, sz[i] / d)))
  const phi = Math.atan2(sy[i], sx[i])
  l2ByPix[ang2pixNest(NSIDE, theta, phi)].push(i)
}

let worstAbsErrPc = 0
let worstRelErr = 0
let worstAbsErrWithin1kpc = 0
let quantBoundaryCrossings = 0
let maxShell = 0
const l2Chunks = []
let l2Bytes = 0

for (let pix = 0; pix < NPIX; pix++) {
  const list = l2ByPix[pix]
  if (list.length === 0) {
    l2Chunks.push({ pix, count: 0, bytes: 0, shells: [] })
    continue
  }
  list.sort((a, b) => shellOf(sdist[a]) - shellOf(sdist[b]) || smag[a] - smag[b])

  const m = list.length
  const buf = Buffer.alloc(9 * m)
  const shells = []
  let run = null
  for (let k = 0; k < m; k++) {
    const i = list[k]
    const sh = shellOf(sdist[i])
    if (sh > maxShell) maxShell = sh
    if (!run || run.shell !== sh) {
      run = { shell: sh, start: k, count: 0, radiusPc: 2 ** sh, scale: 2 ** sh / I16_MAX }
      shells.push(run)
    }
    run.count++
    const s = run.scale
    const qx = Math.max(-I16_MAX, Math.min(I16_MAX, Math.round(sx[i] / s)))
    const qy = Math.max(-I16_MAX, Math.min(I16_MAX, Math.round(sy[i] / s)))
    const qz = Math.max(-I16_MAX, Math.min(I16_MAX, Math.round(sz[i] / s)))
    buf.writeInt16LE(qx, 2 * k)
    buf.writeInt16LE(qy, 2 * m + 2 * k)
    buf.writeInt16LE(qz, 4 * m + 2 * k)
    buf[6 * m + k] = quantMag(smag[i])
    buf[7 * m + k] = quantCi(sci[i])
    buf[8 * m + k] = sflags[i]
    const err = Math.hypot(qx * s - sx[i], qy * s - sy[i], qz * s - sz[i])
    if (err > worstAbsErrPc) worstAbsErrPc = err
    if (err / sdist[i] > worstRelErr) worstRelErr = err / sdist[i]
    if (sdist[i] <= 1000 && err > worstAbsErrWithin1kpc) worstAbsErrWithin1kpc = err
    // Does the DEQUANTIZED point still fall inside this chunk? A star sitting within a
    // rounding step of a pixel boundary can cross it. Counted and reported, not hidden.
    const rq = Math.hypot(qx * s, qy * s, qz * s)
    if (ang2pixNest(NSIDE, Math.acos(Math.max(-1, Math.min(1, (qz * s) / rq))), Math.atan2(qy * s, qx * s)) !== pix) {
      quantBoundaryCrossings++
    }
  }
  writeFileSync(join(OUT_DIR, 'l2', `${pix}.bin`), buf)
  l2Bytes += buf.length
  // Compact shell encoding: [shell, start, count]. radiusPc = 2^shell, scale = radiusPc / 32767.
  l2Chunks.push({ pix, count: m, bytes: buf.length, shells: shells.map((s) => [s.shell, s.start, s.count]) })
}

const l0Buf = encodeTierA(l0src)
const l1Buf = encodeTierA(l1src)
writeFileSync(join(OUT_DIR, 'l0.bin'), l0Buf)
writeFileSync(join(OUT_DIR, 'l1.bin'), l1Buf)

// ---------------------------------------------------------------------------
// 8. Manifests, names, constellations, exoplanets, licence
// ---------------------------------------------------------------------------

const provenance = {
  source: `${ATHYG.version} — AT-HYG database, Astronomy Nexus (David Nash)`,
  sourceUrl: ATHYG.repo,
  sourceFile: ATHYG.files.m10,
  downloadUrl: athygUrl(ATHYG.files.m10),
  sourceVersion: `${ATHYG.version} @ commit ${ATHYG.commit}`,
  retrieved: RETRIEVED,
  licence: ATHYG.licence,
  attribution: 'Star data: AT-HYG v4.0 database, Astronomy Nexus (David Nash), CC BY-SA 4.0',
  frame: 'ICRS equatorial, right-handed cartesian; +x towards (RA 0h, Dec 0), +z towards Dec +90',
  epoch: 'J2000.0 — positions are AT-HYG x0/y0/z0, the epoch-2000 cartesian columns, used verbatim',
  units: 'parsecs',
  secondarySources: [
    { name: `${HYG.version} — variability and multiplicity flags, joined on HIP then HD`, url: hygUrl(), licence: HYG.licence },
    { name: `Stellarium ${STELLARIUM.tag} skycultures/modern_iau — constellation figures`, url: stellariumUrl(), licence: STELLARIUM.licence },
    { name: 'NASA Exoplanet Archive pscomppars (TAP sync) — exoplanet host flag', url: exoUrl(), licence: EXO.licence },
  ],
}

const dequantization = {
  magnitude:
    'mag = magu / 16 - 2    (apparent V/VT magnitude; magu = round((mag + 2) * 16); step 0.0625 mag; representable range -2.000 .. +13.938)',
  colourIndex:
    'ci = ciu / 40 - 0.5    (Johnson B-V; ciu = round((ci + 0.5) * 40); step 0.025; representable range -0.500 .. +5.875)',
  absoluteMagnitude:
    'absmag = mag - 5 * (log10(sqrt(x*x + y*y + z*z)) - 1)   — not stored; derive it from the dequantized mag and the position',
  positionL0L1: 'float32 parsecs, stored verbatim — no quantization applied',
  positionL2:
    'x_pc = x_i16 * shell.scale, where shell.scale = shell.radiusPc / 32767 and a star`s shell is the manifest entry whose [start, start + count) index range contains it',
  flags: FLAG_DOC,
}

function tierManifest(name, src, buf) {
  const m = src.length
  return {
    format:
      'OmniAtlas star tier. Little-endian, tightly packed struct-of-arrays: all of field A, then all of field B, and so on. No header inside the .bin.',
    file: `${name}.bin`,
    recordCount: m,
    bytesPerRecord: 16,
    byteLength: buf.length,
    sha256: sha256(buf),
    fieldOrder: ['x', 'y', 'z', 'magu', 'ciu', 'flags', 'con'],
    fields: tierAFields(m),
    globalIndexBase: name === 'l0' ? 0 : l0src.length,
    globalIndexNote:
      'Global star index = the concatenation of l0 then l1. names.json and constellations.bin index into that space. L2 chunks are a disjoint remainder and carry no global index.',
    selection:
      name === 'l0'
        ? `apparent magnitude <= ${L0_MAG_MAX}`
        : `apparent magnitude <= ${L1_MAG_MAX}, or distance <= ${L1_DIST_MAX_PC} pc, or a Stellarium modern_iau figure star, or a star carrying a proper name / Bayer letter / Flamsteed number — minus everything already in l0`,
    ordering: 'ascending apparent magnitude (brightest first)',
    constellations: conAbbrList,
    dequantization,
    ...provenance,
  }
}
writeFileSync(join(OUT_DIR, 'l0.json'), JSON.stringify(tierManifest('l0', l0src, l0Buf), null, 2))
writeFileSync(join(OUT_DIR, 'l1.json'), JSON.stringify(tierManifest('l1', l1src, l1Buf), null, 2))

const nonEmptyChunks = l2Chunks.filter((c) => c.count > 0)
const l2Index = {
  format:
    'OmniAtlas star tier L2 — one little-endian, tightly packed struct-of-arrays chunk per HEALPix pixel. No header inside the .bin.',
  files: 'l2/<pix>.bin, pix in [0, 192)',
  scheme: { kind: 'HEALPix', ordering: 'NESTED', nside: NSIDE, npix: NPIX },
  angles: 'theta = acos(z / r), phi = atan2(y, x), from the ICRS cartesian parsec columns',
  recordCount: l2src.length,
  bytesPerRecord: 9,
  byteLength: l2Bytes,
  fieldOrder: ['x', 'y', 'z', 'magu', 'ciu', 'flags'],
  fieldLayout: [
    { name: 'x', dtype: 'int16', byteOffset: '0', units: 'quantized pc' },
    { name: 'y', dtype: 'int16', byteOffset: '2 * count', units: 'quantized pc' },
    { name: 'z', dtype: 'int16', byteOffset: '4 * count', units: 'quantized pc' },
    { name: 'magu', dtype: 'uint8', byteOffset: '6 * count', units: 'quantized apparent magnitude' },
    { name: 'ciu', dtype: 'uint8', byteOffset: '7 * count', units: 'quantized Johnson B-V colour index' },
    { name: 'flags', dtype: 'uint8', byteOffset: '8 * count', units: 'bitfield' },
  ],
  ordering: 'by distance shell, then ascending apparent magnitude within each shell',
  shellEncoding: 'chunks[].shells is a list of [shell, start, count] triples: records [start, start + count) of that chunk belong to distance shell `shell`, whose radiusPc = 2^shell and scale = radiusPc / 32767.',
  quantization: {
    scheme: 'int16 per octave distance shell inside each HEALPix chunk',
    shellRule: 'shell k covers r in (2^(k-1), 2^k] pc; radiusPc = 2^k; scale_k = radiusPc / 32767',
    dequantize: 'x_pc = x_i16 * scale',
    maxShell,
    worstCaseAbsoluteErrorPc: worstAbsErrPc,
    worstCaseAbsoluteErrorPcWithin1kpc: worstAbsErrWithin1kpc,
    worstCaseRelativeError: worstRelErr,
    quantizationBoundaryCrossings: quantBoundaryCrossings,
    quantizationBoundaryNote:
      'Number of stars whose DEQUANTIZED position re-bins into a neighbouring HEALPix pixel because they sit within one rounding step of a chunk boundary. They are stored in the chunk their exact position belongs to. A renderer that loads a chunk and its neighbours sees no gap; one that culls strictly by pixel may draw such a star a rounding step outside its tile.',
    worstCaseErrorNote:
      'Per-axis rounding error is at most scale/2 = radiusPc/65534, so the 3D error is at most sqrt(3)*radiusPc/65534. A star in shell k has r > radiusPc/2, hence the positional error is bounded by sqrt(3)/32767 = 5.29e-5 of the star`s own distance. The absolute worst case reported here is driven by the handful of AT-HYG rows with very poor parallax solutions hundreds of kpc out; see worstCaseAbsoluteErrorPcWithin1kpc for the figure that matters at rendering scales.',
  },
  chunks: nonEmptyChunks,
  emptyChunks: l2Chunks.filter((c) => c.count === 0).map((c) => c.pix),
  healpixVerification: healpixChecks,
  dequantization,
  ...provenance,
}
writeFileSync(join(OUT_DIR, 'l2', 'index.json'), JSON.stringify(l2Index))

// --- names.json -------------------------------------------------------------
const names = []
for (const i of [...l0src, ...l1src]) {
  if (!sproper[i] && !sbayer[i] && !sflam[i]) continue
  const e = { i: globalIndex[i], m: Math.round(smag[i] * 100) / 100 }
  if (sproper[i]) e.proper = sproper[i]
  if (sbayer[i]) e.bayer = sbayer[i]
  if (sflam[i]) e.flam = Number(sflam[i])
  if (scon[i] !== 255) e.con = conAbbrList[scon[i]]
  if (ship[i]) e.hip = ship[i]
  if (shd[i]) e.hd = shd[i]
  if (shr[i]) e.hr = shr[i]
  if (sgl[i]) e.gl = sgl[i]
  if (sspect[i]) e.spect = sspect[i]
  names.push(e)
}
names.sort((a, b) => a.m - b.m)
writeFileSync(
  join(OUT_DIR, 'names.json'),
  JSON.stringify({
    ...provenance,
    description:
      'Searchable and labellable stars: every star in l0 + l1 carrying an IAU proper name, a Bayer Greek letter or a Flamsteed number. `i` is the global index into the l0 ++ l1 concatenation.',
    fields: {
      i: 'global star index into the l0 ++ l1 concatenation',
      m: 'apparent magnitude, full precision (not the quantized uint8)',
      proper: 'IAU proper name',
      bayer: 'Bayer designation (Greek letter abbreviation)',
      flam: 'Flamsteed number',
      con: 'IAU constellation abbreviation',
      hip: 'Hipparcos number',
      hd: 'Henry Draper number',
      hr: 'Yale Bright Star (HR) number',
      gl: 'Gliese / Jahreiss identifier',
      spect: 'spectral type',
    },
    count: names.length,
    stars: names,
  }),
)

// --- constellations ---------------------------------------------------------
const conOut = []
const segA = []
const segB = []
const unresolvedHip = new Set()
let droppedSegments = 0
for (const c of conFigures) {
  const start = segA.length
  for (const [a, b] of c.pairs) {
    const ia = hipToStar.get(a)
    const ib = hipToStar.get(b)
    if (ia === undefined) unresolvedHip.add(a)
    if (ib === undefined) unresolvedHip.add(b)
    if (ia === undefined || ib === undefined || globalIndex[ia] < 0 || globalIndex[ib] < 0) {
      droppedSegments++
      continue
    }
    segA.push(globalIndex[ia])
    segB.push(globalIndex[ib])
  }
  conOut.push({ id: c.id, name: c.name, english: c.english, byname: c.byname, start, count: segA.length - start })
}
const segCount = segA.length
const conBuf = Buffer.alloc(8 * segCount)
for (let k = 0; k < segCount; k++) {
  conBuf.writeUInt32LE(segA[k], 4 * k)
  conBuf.writeUInt32LE(segB[k], 4 * segCount + 4 * k)
}
writeFileSync(join(OUT_DIR, 'constellations.bin'), conBuf)
writeFileSync(
  join(OUT_DIR, 'constellations.json'),
  JSON.stringify(
    {
      format: 'Little-endian, tightly packed struct-of-arrays: uint32 a[recordCount], then uint32 b[recordCount].',
      file: 'constellations.bin',
      recordCount: segCount,
      bytesPerRecord: 8,
      byteLength: conBuf.length,
      sha256: sha256(conBuf),
      fieldOrder: ['a', 'b'],
      fields: [
        { name: 'a', dtype: 'uint32', count: segCount, byteOffset: 0, units: 'global star index (l0 ++ l1)' },
        { name: 'b', dtype: 'uint32', count: segCount, byteOffset: 4 * segCount, units: 'global star index (l0 ++ l1)' },
      ],
      frame: provenance.frame,
      epoch: provenance.epoch,
      units: 'index (dimensionless)',
      source: `Stellarium ${STELLARIUM.tag} skycultures/modern_iau/index.json — HIP id sequences, resolved against the AT-HYG \`hip\` column`,
      sourceUrl: stellariumUrl(),
      sourceVersion: `Stellarium ${STELLARIUM.tag}`,
      retrieved: RETRIEVED,
      licence: `${STELLARIUM.licence}; the resolved indices derive from ${ATHYG.version} (${ATHYG.licence})`,
      attribution:
        'Constellation figures: Stellarium modern_iau skyculture (IAU), CC BY-SA 4.0 — star positions: AT-HYG v4.0, Astronomy Nexus (David Nash), CC BY-SA 4.0',
      rawSegments: conSegmentsRaw,
      droppedSegments,
      unresolvedHip: [...unresolvedHip].sort((a, b) => a - b),
      constellations: conOut,
    },
    null,
    2,
  ),
)

// --- exoplanets.json --------------------------------------------------------
const sorted = [...hosts.values()].sort((a, b) => b.planets - a.planets || a.host.localeCompare(b.host))
const exoMatched = sorted
  .filter((h) => h.star >= 0)
  .map((h) => {
    const gi = globalIndex[h.star]
    const o = { host: h.host, planets: h.planets, star: gi >= 0 ? gi : null, tier: gi >= 0 ? (gi < l0src.length ? 'l0' : 'l1') : 'l2', via: h.via }
    if (h.hip) o.hip = Number(h.hip)
    if (h.hd) o.hd = Number(h.hd)
    if (h.vmag !== null) o.vmag = h.vmag
    return o
  })
// Unmatched hosts are kept so the UI can still list them, but compactly: [name, planetCount].
const exoUnmatched = sorted.filter((h) => h.star < 0).map((h) => [h.host, h.planets])
writeFileSync(
  join(OUT_DIR, 'exoplanets.json'),
  JSON.stringify({
    source: 'NASA Exoplanet Archive, `pscomppars` (Planetary Systems Composite Parameters), public TAP sync endpoint',
    sourceUrl: EXO.tap,
    downloadUrl: exoUrl(),
    sourceVersion: `pscomppars as served on ${RETRIEVED}`,
    retrieved: RETRIEVED,
    licence: EXO.licence,
    attribution:
      'This research has made use of the NASA Exoplanet Archive, which is operated by the California Institute of Technology, under contract with the National Aeronautics and Space Administration under the Exoplanet Exploration Program.',
    frame: 'ICRS',
    epoch: 'J2000.0',
    units: 'vmag in magnitudes; planets is a count',
    notes: [
      'The join column is `gaia_dr3_id`; its values carry a literal "Gaia DR3 " prefix which is stripped before matching. A column named `gaia_id` does not exist and raises ORA-00904.',
      `Match order: Gaia DR3 source_id -> HIP -> HD -> nearest AT-HYG star within ${MATCH_TOL_ARCSEC} arcsec.`,
      '`star` is the global index into the l0 ++ l1 concatenation. A host whose star fell into L2 reports tier "l2" and star null, because L2 carries no global index — its has-exoplanet flag bit is still set inside the L2 chunk.',
      'Unmatched hosts are overwhelmingly fainter than V = 10 and therefore outside the AT-HYG m10 subset entirely. They are listed in `unmatchedHosts` as [name, planetCount] so the UI can still show them honestly rather than pretending they do not exist.',
    ],
    schema: {
      matchedHosts: 'array of { host, planets, star, tier, via, hip?, hd?, vmag? }',
      unmatchedHosts: 'array of [hostName, planetCount] — no counterpart in the AT-HYG m10 subset',
    },
    planetRows: exoRows,
    hostCount: hosts.size,
    matchedHostCount: matchedHosts,
    matchRatePercent: Number(((100 * matchedHosts) / hosts.size).toFixed(2)),
    matchBreakdown: matchCounts,
    matchedHosts: exoMatched,
    unmatchedHosts: exoUnmatched,
  }),
)

// --- top-level manifest -----------------------------------------------------
const sizeOf = (p) => statSync(join(OUT_DIR, p)).size
writeFileSync(
  join(OUT_DIR, 'manifest.json'),
  JSON.stringify(
    {
      generatedBy: 'scripts/build-stars.mjs',
      generated: RETRIEVED,
      ...provenance,
      starCount: { l0: l0src.length, l1: l1src.length, l2: l2src.length, total: n },
      globalIndexSpace: {
        description:
          'l0 occupies [0, l0Count); l1 occupies [l0Count, l0Count + l1Count). L2 chunks are disjoint from both and are not part of this space.',
        l0Count: l0src.length,
        l1Count: l1src.length,
      },
      dequantization,
      flags: FLAG_DOC,
      constellationAbbreviations: conAbbrList,
      ingestStats: {
        csvRows: rows,
        droppedSol,
        droppedNoPosition,
        droppedNoMagnitude: droppedNoMag,
        ciMissingInAtHyg: ciDefaulted,
        ciBackfilledFromHyg: ciBackfilled,
        ciStillAtSolarDefault: ciDefaulted - ciBackfilled,
        absmagMissing,
        magnitudeClampedToUint8Range: magClamped,
        colourIndexClampedToUint8Range: ciClamped,
        variableFlagged: variableSet,
        multipleFlagged: multipleSet,
        constellationStarsPromotedToL1: promotedCon,
        namedStarsPromotedToL1: promotedNamed,
        maxDistancePc: maxDistPc,
      },
      files: [
        { path: 'l0.bin', manifest: 'l0.json', bytes: sizeOf('l0.bin'), records: l0src.length },
        { path: 'l1.bin', manifest: 'l1.json', bytes: sizeOf('l1.bin'), records: l1src.length },
        { path: 'l2/<pix>.bin', manifest: 'l2/index.json', bytes: l2Bytes, records: l2src.length },
        { path: 'constellations.bin', manifest: 'constellations.json', bytes: conBuf.length, records: segCount },
        { path: 'names.json', manifest: 'self-describing', bytes: sizeOf('names.json'), records: names.length },
        { path: 'exoplanets.json', manifest: 'self-describing', bytes: sizeOf('exoplanets.json'), records: hosts.size },
      ],
      healpixVerification: healpixChecks,
    },
    null,
    2,
  ),
)

// --- licence ----------------------------------------------------------------
writeFileSync(
  join(OUT_DIR, 'LICENSE-DATA.md'),
  `# Licensing and attribution — \`public/data/stars/\`

Every file in this directory is generated by \`scripts/build-stars.mjs\` (sources retrieved
${RETRIEVED}). Nothing here is hand-authored, and no value in it is synthetic.

## AT-HYG v4.0 — star positions, magnitudes, colours and identifiers

- Source: AT-HYG database, Astronomy Nexus (David Nash) — <${ATHYG.repo}>
- Pinned to commit \`${ATHYG.commit}\`
- File: \`${ATHYG.files.m10}\`
- Licence: **Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)** —
  <https://creativecommons.org/licenses/by-sa/4.0/>

\`l0.bin\`, \`l1.bin\`, \`l2/*.bin\`, \`names.json\` and \`constellations.bin\` are an **adaptation** of
the AT-HYG database. CC BY-SA 4.0's ShareAlike condition therefore applies to those files: they
are redistributed under CC BY-SA 4.0, and \`scripts/build-stars.mjs\` is kept in the repository so
the derivation stays reproducible. OmniAtlas's application code is unaffected — it is not a
derivative of the database.

### Attribution string the UI must display, verbatim

> Star data: AT-HYG v4.0 database, Astronomy Nexus (David Nash), CC BY-SA 4.0

Short form, where space is tight:

> AT-HYG v4.0 · CC BY-SA 4.0

## HYG v4.1 — the is-variable and is-multiple flag bits

AT-HYG v4.0 has no variability or multiplicity columns, and its \`hyglike_from_athyg_v40.csv.gz\`
ships the HYG column *names* with every value empty. The original HYG database is used instead,
joined on HIP then HD.

- Source: HYG database, Astronomy Nexus (David Nash) — <${HYG.repo}>
- Pinned to commit \`${HYG.commit}\`, file \`${HYG.path}\`
- Licence: **CC BY-SA 4.0**

### Attribution string the UI must display, verbatim

> Variability and multiplicity: HYG v4.1 database, Astronomy Nexus (David Nash), CC BY-SA 4.0

## Stellarium \`modern_iau\` skyculture — constellation figures

- Source: <${STELLARIUM.repo}>, \`${STELLARIUM.path}\`, tag \`${STELLARIUM.tag}\`
- Licence: ${STELLARIUM.licence}

### Attribution string the UI must display, verbatim

> Constellation figures: Stellarium \`modern_iau\` skyculture (IAU), CC BY-SA 4.0

\`constellations.bin\` also derives its indices from AT-HYG and so carries the CC BY-SA 4.0
obligation above as well.

## NASA Exoplanet Archive — exoplanet host flags

- Source: <${EXO.tap}>, table \`${EXO.table}\`
- Licence: public domain (work of the U.S. Government)

### Attribution string the UI must display, verbatim

> This research has made use of the NASA Exoplanet Archive, which is operated by the California
> Institute of Technology, under contract with the National Aeronautics and Space Administration
> under the Exoplanet Exploration Program.

Short form:

> Exoplanets: NASA Exoplanet Archive (Caltech/IPAC-NExScI)

## Combined credit line for the loading screen and the Sources panel

> Star data: AT-HYG v4.0 and HYG v4.1 (Astronomy Nexus, David Nash) · Constellation figures:
> Stellarium \`modern_iau\` (IAU) — all CC BY-SA 4.0 · Exoplanets: NASA Exoplanet Archive
> (Caltech/IPAC-NExScI)
`,
)

// ---------------------------------------------------------------------------
// 9. Summary
// ---------------------------------------------------------------------------

log('')
log('[8/8] Output')
const emitted = [
  ['l0.bin', sizeOf('l0.bin'), l0src.length],
  ['l0.json', sizeOf('l0.json'), 1],
  ['l1.bin', sizeOf('l1.bin'), l1src.length],
  ['l1.json', sizeOf('l1.json'), 1],
  [`l2/*.bin (${nonEmptyChunks.length} chunks)`, l2Bytes, l2src.length],
  ['l2/index.json', sizeOf(join('l2', 'index.json')), nonEmptyChunks.length],
  ['constellations.bin', sizeOf('constellations.bin'), segCount],
  ['constellations.json', sizeOf('constellations.json'), conOut.length],
  ['names.json', sizeOf('names.json'), names.length],
  ['exoplanets.json', sizeOf('exoplanets.json'), hosts.size],
  ['manifest.json', sizeOf('manifest.json'), 1],
  ['LICENSE-DATA.md', sizeOf('LICENSE-DATA.md'), 1],
]
let total = 0
for (const [name, bytes, records] of emitted) {
  total += bytes
  log(`  ${name.padEnd(32)} ${String(records).padStart(9)} rec ${fmtBytes(bytes).padStart(11)}`)
}
log(`  ${'TOTAL'.padEnd(32)} ${''.padStart(9)}     ${fmtBytes(total).padStart(11)}`)
log('')
log(`  output dir       ${OUT_DIR}`)
log(
  `  L2 chunk sizes   min ${fmtBytes(Math.min(...nonEmptyChunks.map((c) => c.bytes)))}, mean ${fmtBytes(Math.round(l2Bytes / nonEmptyChunks.length))}, max ${fmtBytes(Math.max(...nonEmptyChunks.map((c) => c.bytes)))}`,
)
log(
  `  L2 quantization  worst-case absolute error ${worstAbsErrPc.toFixed(4)} pc overall, ${worstAbsErrWithin1kpc.toFixed(4)} pc within 1 kpc; worst-case relative error ${worstRelErr.toExponential(2)}`,
)
log(
  `  constellations   ${segCount} segments emitted, ${droppedSegments} dropped, ${unresolvedHip.size} HIP ids unresolved${unresolvedHip.size ? ` (${[...unresolvedHip].join(', ')})` : ''}`,
)
log(`  exoplanet hosts  ${matchedHosts}/${hosts.size} matched (${((100 * matchedHosts) / hosts.size).toFixed(1)}%)`)
log(`  licence          ${ATHYG.licence} — see LICENSE-DATA.md`)
log('')
