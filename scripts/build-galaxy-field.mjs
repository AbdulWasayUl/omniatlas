/**
 * build-galaxy-field.mjs — OmniAtlas build-time ETL for the `galactic` render layer.
 *
 *   node scripts/build-galaxy-field.mjs
 *
 * Emits into public/data/galaxy/:
 *   masers.json      MEASURED   Reid+2019 (ApJ 885, 131) VLBI maser parallaxes, VizieR J/ApJ/885/131
 *   arms.json        DERIVED    Reid+2019 Table 2 log-periodic spiral-arm fits
 *   field.bin/.json  DERIVED    deterministic statistical realisation of the arm model
 *   localgroup.json  MEASURED   UNGC (Karachentsev+2013) VizieR J/AJ/145/101, Local Group subset
 *   LICENSE.md                  mandatory attribution strings
 *
 * Zero npm dependencies. Node builtins only. Sources are downloaded once into .cache/.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE_DIR = join(REPO_ROOT, '.cache')
const OUT_DIR = join(REPO_ROOT, 'public', 'data', 'galaxy')

/** Frozen retrieval date for every manifest in this build. */
const RETRIEVED = '2026-10-14'

/** Deterministic PRNG seed for field.bin. Changing this changes every shared permalink. */
const FIELD_SEED = 20190885 // Reid et al. 2019, ApJ *885*

// --------------------------------------------------------------------------------------------
// Galactic constants
// --------------------------------------------------------------------------------------------

/**
 * R0 decision: we use **Reid+2019 R0 = 8.15 kpc** everywhere in this layer, NOT the
 * GRAVITY 2019 value of 8.178 kpc. Reason: the spiral-arm fits in arms.json were themselves
 * derived assuming R0 = 8.15 ("The models assume R0 = 8.15 kpc", Reid+2019 Table 2 notes), so
 * mixing in 8.178 would put the maser positions a few tens of pc off their own arm fits.
 */
const R0_KPC = 8.15 // Reid+2019, ApJ 885, 131 (8.15 +/- 0.15 kpc)
const THETA0_KMS = 236 // Reid+2019 (236 +/- 7 km/s)
const ZSUN_PC = 5.5 // Reid+2019: Sun offset toward the NGP, +5.5 +/- 5.8 pc
const DW_DR_PC_PER_KPC = 42 // Reid+2014/2019 arm-width gradient

// IAU 1958 galactic pole in ICRS, same constants the engine's src/core/world.ts uses.
const NGP_RA_DEG = 192.85948
const NGP_DEC_DEG = 27.12825
const L_NCP_DEG = 122.93192

const DEG = Math.PI / 180

// --------------------------------------------------------------------------------------------
// Tiny helpers
// --------------------------------------------------------------------------------------------

const round = (v, n) => (Number.isFinite(v) ? Number(v.toFixed(n)) : null)

function fmtBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  return `${(n / 1024 / 1024).toFixed(2)} MiB`
}

async function cachedFetch(url, cacheName) {
  mkdirSync(CACHE_DIR, { recursive: true })
  const path = join(CACHE_DIR, cacheName)
  if (existsSync(path) && statSync(path).size > 0) {
    process.stdout.write(`  cache hit   ${cacheName} (${fmtBytes(statSync(path).size)})\n`)
    return readFileSync(path, 'utf8')
  }
  process.stdout.write(`  downloading ${url}\n`)
  const response = await fetch(url, {
    headers: { 'User-Agent': 'OmniAtlas-ETL/1.0 (build-time data ingest; contact: repo maintainer)' },
  })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`)
  const text = await response.text()
  if (text.length === 0) throw new Error(`empty body for ${url}`)
  writeFileSync(path, text)
  process.stdout.write(`  cached      ${cacheName} (${fmtBytes(Buffer.byteLength(text))})\n`)
  return text
}

/**
 * Parse a VizieR `asu-tsv` response: '#'-comment lines, then header / units / '---' rule / rows.
 */
function parseVizierTsv(text) {
  const lines = text
    .split(/\r?\n/u)
    .filter((line) => !line.startsWith('#') && line.trim().length > 0)
  const ruleIndex = lines.findIndex((line) => /^-{3,}/u.test(line))
  if (ruleIndex < 1) throw new Error('VizieR TSV: could not locate the "---" rule line')
  const header = lines[ruleIndex - 2].split('\t').map((s) => s.trim())
  const rows = []
  for (const line of lines.slice(ruleIndex + 1)) {
    const cells = line.split('\t')
    const row = {}
    for (let i = 0; i < header.length; i += 1) row[header[i]] = (cells[i] ?? '').trim()
    rows.push(row)
  }
  return rows
}

const num = (s) => {
  if (s === undefined || s === null) return null
  const t = String(s).trim()
  if (t === '' || t === '---') return null
  const v = Number(t)
  return Number.isFinite(v) ? v : null
}

/** "13 11 16.8912" -> degrees (RA, hours) ; "-62 45 55.008" -> degrees (Dec). */
function sexagesimalToDeg(text, isHours) {
  const parts = String(text).trim().split(/\s+/u)
  if (parts.length < 2) return null
  const sign = parts[0].trim().startsWith('-') ? -1 : 1
  const a = Math.abs(Number(parts[0]))
  const b = Number(parts[1] ?? 0)
  const c = Number(parts[2] ?? 0)
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) return null
  const deg = sign * (a + b / 60 + c / 3600)
  return isHours ? deg * 15 : deg
}

/** ICRS (J2000) equatorial degrees -> galactic (l, b) degrees. */
function equatorialToGalactic(raDeg, decDeg) {
  const ra = raDeg * DEG
  const dec = decDeg * DEG
  const agp = NGP_RA_DEG * DEG
  const dgp = NGP_DEC_DEG * DEG
  const sinb = Math.sin(dec) * Math.sin(dgp) + Math.cos(dec) * Math.cos(dgp) * Math.cos(ra - agp)
  const b = Math.asin(Math.max(-1, Math.min(1, sinb)))
  const y = Math.cos(dec) * Math.sin(ra - agp)
  const x = Math.sin(dec) * Math.cos(dgp) - Math.cos(dec) * Math.sin(dgp) * Math.cos(ra - agp)
  let l = L_NCP_DEG - Math.atan2(y, x) / DEG
  l = ((l % 360) + 360) % 360
  return { l, b: b / DEG }
}

/**
 * Heliocentric galactic spherical -> Galactocentric Cartesian, in the frame this whole layer uses.
 *
 *   origin  Galactic centre
 *   +X      direction of galactic rotation at the Sun (i.e. toward l = 90 deg as seen from the Sun)
 *   +Y      from the Galactic centre toward the Sun     (Sun sits at (0, +R0, +Zsun))
 *   +Z      North Galactic Pole
 *
 * Right-handed; the Galaxy's angular-momentum vector points toward -Z (the SGP), which is correct.
 * Galactocentric azimuth beta = atan2(X, Y): 0 toward the Sun, increasing with galactic rotation —
 * exactly the convention Reid+2019 uses for its spiral fits.
 */
function galacticToGalactocentricKpc(lDeg, bDeg, distKpc) {
  const l = lDeg * DEG
  const b = bDeg * DEG
  const xh = distKpc * Math.cos(b) * Math.cos(l) // toward the Galactic centre
  const yh = distKpc * Math.cos(b) * Math.sin(l) // toward l = 90 deg
  const zh = distKpc * Math.sin(b)
  const X = yh
  const Y = R0_KPC - xh
  const Z = zh + ZSUN_PC / 1000
  return { X, Y, Z, R: Math.hypot(X, Y), beta: Math.atan2(X, Y) / DEG }
}

// --------------------------------------------------------------------------------------------
// Deterministic PRNG — mulberry32. NEVER Math.random(): permalinks must reproduce exactly.
// --------------------------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Box–Muller on a supplied uniform stream; cached second deviate kept in a closure. */
function makeGaussian(rand) {
  let spare = null
  return function gauss() {
    if (spare !== null) {
      const v = spare
      spare = null
      return v
    }
    let u = 0
    while (u <= 1e-12) u = rand()
    const r = Math.sqrt(-2 * Math.log(u))
    const theta = 2 * Math.PI * rand()
    spare = r * Math.sin(theta)
    return r * Math.cos(theta)
  }
}

// --------------------------------------------------------------------------------------------
// Blackbody -> sRGB colour LUT (Planck x CIE 1931, Wyman/Sloan/Shirley 2013 analytic fits)
// --------------------------------------------------------------------------------------------

const PALETTE_SIZE = 256
const PALETTE_T_MIN = 2000 // K  -> colour index 0
const PALETTE_T_MAX = 20000 // K -> colour index 255

function cieGaussian(x, mu, s1, s2) {
  const t = (x - mu) * (x < mu ? 1 / s1 : 1 / s2)
  return Math.exp(-0.5 * t * t)
}

function cieXyzBar(lambdaNm) {
  const x =
    1.056 * cieGaussian(lambdaNm, 599.8, 37.9, 31.0) +
    0.362 * cieGaussian(lambdaNm, 442.0, 16.0, 26.7) -
    0.065 * cieGaussian(lambdaNm, 501.1, 20.4, 26.2)
  const y =
    0.821 * cieGaussian(lambdaNm, 568.8, 46.9, 40.5) + 0.286 * cieGaussian(lambdaNm, 530.9, 16.3, 31.1)
  const z =
    1.217 * cieGaussian(lambdaNm, 437.0, 11.8, 36.0) + 0.681 * cieGaussian(lambdaNm, 459.0, 26.0, 13.8)
  return [x, y, z]
}

function planck(lambdaNm, tempK) {
  const h = 6.62607015e-34
  const c = 2.99792458e8
  const kB = 1.380649e-23
  const lam = lambdaNm * 1e-9
  return (2 * h * c * c) / (lam ** 5 * (Math.exp((h * c) / (lam * kB * tempK)) - 1))
}

function srgbEncode(u) {
  const v = Math.max(0, Math.min(1, u))
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055
}

/** Chromaticity of a blackbody at T, max-component-normalised then sRGB-encoded to 0..255. */
function blackbodyRgb255(tempK) {
  let X = 0
  let Y = 0
  let Z = 0
  for (let lam = 360; lam <= 830; lam += 1) {
    const s = planck(lam, tempK)
    const [bx, by, bz] = cieXyzBar(lam)
    X += s * bx
    Y += s * by
    Z += s * bz
  }
  const sum = X + Y + Z
  X /= sum
  Y /= sum
  Z /= sum
  let r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z
  let g = -0.9689 * X + 1.8758 * Y + 0.0415 * Z
  let b = 0.0557 * X - 0.204 * Y + 1.057 * Z
  r = Math.max(0, r)
  g = Math.max(0, g)
  b = Math.max(0, b)
  const peak = Math.max(r, g, b, 1e-9)
  return [
    Math.round(255 * srgbEncode(r / peak)),
    Math.round(255 * srgbEncode(g / peak)),
    Math.round(255 * srgbEncode(b / peak)),
  ]
}

const LOG_PALETTE_SPAN = Math.log10(PALETTE_T_MAX / PALETTE_T_MIN) // exactly 1.0

function temperatureToColourIndex(tempK) {
  const t = Math.max(PALETTE_T_MIN, Math.min(PALETTE_T_MAX, tempK))
  const idx = Math.round(((PALETTE_SIZE - 1) * Math.log10(t / PALETTE_T_MIN)) / LOG_PALETTE_SPAN)
  return Math.max(0, Math.min(PALETTE_SIZE - 1, idx))
}

function buildPalette() {
  const palette = []
  for (let i = 0; i < PALETTE_SIZE; i += 1) {
    const t = PALETTE_T_MIN * 10 ** ((i / (PALETTE_SIZE - 1)) * LOG_PALETTE_SPAN)
    palette.push(blackbodyRgb255(t))
  }
  return palette
}

// --------------------------------------------------------------------------------------------
// 1. masers.json — MEASURED
// --------------------------------------------------------------------------------------------

const REID_VIZIER_ID = 'J/ApJ/885/131'
const REID_TABLE1_URL =
  'https://vizier.cds.unistra.fr/viz-bin/asu-tsv?-source=J/ApJ/885/131/table1&-out.max=unlimited' +
  '&-out=Name,OName,RAJ2000,DEJ2000,plx,e_plx,pmE,e_pmE,pmN,e_pmN,VLSR,e_VLSR,Arm'
const REID_README_URL = 'https://cdsarc.cds.unistra.fr/ftp/J/ApJ/885/131/ReadMe'

/** Reid+2019 table1 note (4): three-letter arm designators. */
const ARM_CODE_NAMES = {
  GC: 'Galactic Center region',
  Con: 'Connecting arm',
  '3kN': '3-kpc arm (near)',
  '3kF': '3-kpc arm (far)',
  Nor: 'Norma arm',
  Out: 'Outer arm',
  ScF: 'Scutum arm (far)',
  ScN: 'Scutum arm (near)',
  CtN: 'Centaurus arm (near)',
  OSC: 'Outer Scutum-Centaurus arm',
  SgN: 'Sagittarius arm (near)',
  SgF: 'Sagittarius arm (far)',
  CrN: 'Carina arm (near)',
  Loc: 'Local arm',
  Per: 'Perseus arm',
  LoS: 'Local arm spur',
  AqS: 'Aquarius spur',
  '???': 'Unassigned',
}

/** Which arms.json fit each table1 arm code belongs to (null = no fitted spiral in Table 2). */
const ARM_CODE_TO_FIT = {
  '3kN': '3kpc-near',
  '3kF': null,
  Nor: 'norma',
  Out: 'outer',
  ScF: 'scutum-centaurus',
  ScN: 'scutum-centaurus',
  CtN: 'scutum-centaurus',
  OSC: 'scutum-centaurus',
  SgN: 'sagittarius-carina',
  SgF: 'sagittarius-carina',
  CrN: 'sagittarius-carina',
  Loc: 'local',
  LoS: 'local',
  Per: 'perseus',
  AqS: null,
  GC: null,
  Con: null,
  '???': null,
}

async function buildMasers() {
  process.stdout.write('\n[1/4] masers.json  (MEASURED)\n')
  const tsv = await cachedFetch(REID_TABLE1_URL, 'reid2019_table1.tsv')
  await cachedFetch(REID_README_URL, 'reid2019_ReadMe.txt') // kept for provenance / offline rebuilds
  const rows = parseVizierTsv(tsv).filter((r) => r.Name && r.Name.length > 0)

  let nameCheckMax = 0
  let nameChecked = 0
  const masers = []

  for (const row of rows) {
    const ra = sexagesimalToDeg(row.RAJ2000, true)
    const dec = sexagesimalToDeg(row.DEJ2000, false)
    const plx = num(row.plx)
    const ePlx = num(row.e_plx)
    if (ra === null || dec === null || plx === null || plx <= 0) continue

    const { l, b } = equatorialToGalactic(ra, dec)

    // Self-check: Reid source names encode galactic coordinates, e.g. G305.20+00.01.
    const nameMatch = /^G(\d{3}\.\d{2})([+-]\d{2}\.\d{2})/u.exec(row.Name)
    if (nameMatch) {
      const dl = Math.abs(((l - Number(nameMatch[1]) + 540) % 360) - 180)
      const db = Math.abs(b - Number(nameMatch[2]))
      nameCheckMax = Math.max(nameCheckMax, dl, db)
      nameChecked += 1
    }

    const distKpc = 1 / plx
    const eDistKpc = ePlx ? ePlx / (plx * plx) : null
    const gc = galacticToGalactocentricKpc(l, b, distKpc)
    const armCode = row.Arm && row.Arm !== '---' ? row.Arm : '???'

    masers.push({
      name: row.Name,
      otherName: row.OName || null,
      raDeg: round(ra, 6),
      decDeg: round(dec, 6),
      lDeg: round(l, 4),
      bDeg: round(b, 4),
      plxMas: plx,
      ePlxMas: ePlx,
      distKpc: round(distKpc, 4),
      eDistKpc: round(eDistKpc, 4),
      pmEMasYr: num(row.pmE),
      ePmEMasYr: num(row.e_pmE),
      pmNMasYr: num(row.pmN),
      ePmNMasYr: num(row.e_pmN),
      vlsrKmS: num(row.VLSR),
      eVlsrKmS: num(row.e_VLSR),
      armCode,
      armFit: ARM_CODE_TO_FIT[armCode] ?? null,
      xKpc: round(gc.X, 4),
      yKpc: round(gc.Y, 4),
      zKpc: round(gc.Z, 4),
      rGalKpc: round(gc.R, 4),
      betaDeg: round(gc.beta, 3),
    })
  }

  masers.sort((a, b) => a.name.localeCompare(b.name))

  const armCounts = {}
  for (const m of masers) armCounts[m.armCode] = (armCounts[m.armCode] ?? 0) + 1

  const payload = {
    kind: 'MEASURED',
    badge: 'MEASURED',
    description:
      'Trigonometric parallaxes and proper motions of ~200 masers in high-mass star-forming regions ' +
      'measured by VLBI (BeSSeL/VLBA, VERA, EVN, LBA). These are the direct observational constraints ' +
      'on the spiral structure in arms.json.',
    recordCount: masers.length,
    source: {
      paper: 'Reid M.J., Menten K.M., Brunthaler A., et al. 2019, ApJ, 885, 131',
      title:
        'Trigonometric Parallaxes of High-mass Star-forming Regions: Our View of the Milky Way',
      bibcode: '2019ApJ...885..131R',
      doi: '10.3847/1538-4357/ab4a11',
      vizierTable: `${REID_VIZIER_ID}/table1`,
      vizierDoi: '10.26093/cds/vizier.18850131',
      url: REID_TABLE1_URL,
      readme: REID_README_URL,
      version: 'VizieR catalogue J/ApJ/885/131, prepared by CDS 16-Sep-2021 (199 rows)',
      retrieved: RETRIEVED,
    },
    licence:
      'Table reproduced from an AAS journal article (ApJ) via VizieR/CDS. Cite Reid et al. 2019, ' +
      'ApJ 885, 131 and the VizieR service. See LICENSE.md in this directory.',
    attribution:
      'Maser parallaxes: Reid et al. (2019), ApJ 885, 131 — VizieR J/ApJ/885/131 (CDS, Strasbourg).',
    frame: {
      equatorial: 'ICRS / J2000 (RA, Dec in degrees)',
      galactic: 'IAU galactic (l, b in degrees); NGP alpha=192.85948, delta=27.12825, l_NCP=122.93192',
      cartesian:
        'Galactocentric: origin at the Galactic centre, +X along galactic rotation at the Sun ' +
        '(toward l=90deg), +Y from the Galactic centre toward the Sun, +Z toward the NGP. ' +
        `Sun at (0, ${R0_KPC}, ${ZSUN_PC / 1000}) kpc. beta = atan2(X, Y), the Reid+2019 ` +
        'galactocentric azimuth (0 toward the Sun, increasing with galactic rotation).',
      R0Kpc: R0_KPC,
      ZsunPc: ZSUN_PC,
    },
    epoch: 'J2000.0 positions; proper motions as published (observation epochs 2003-2019)',
    units: {
      raDeg: 'deg',
      decDeg: 'deg',
      lDeg: 'deg',
      bDeg: 'deg',
      plxMas: 'mas',
      distKpc: 'kpc (= 1 / plxMas)',
      eDistKpc: 'kpc, 1-sigma, linear propagation e_plx/plx^2',
      pmEMasYr: 'mas/yr, eastward (dRA * cos Dec)',
      pmNMasYr: 'mas/yr, northward',
      vlsrKmS: 'km/s, Local Standard of Rest',
      xKpc: 'kpc',
      yKpc: 'kpc',
      zKpc: 'kpc',
      rGalKpc: 'kpc, galactocentric radius',
      betaDeg: 'deg, galactocentric azimuth',
    },
    armCodes: ARM_CODE_NAMES,
    armCounts,
    recordNote:
      'armName is not stored per record: resolve armCode against the top-level armCodes map. ' +
      'armFit names the arms.json arm this source constrains, or null when Table 2 has no fit for it.',
    notes: [
      'Distances are the naive parallax inverse 1/plx. Reid+2019 themselves recommend a Bayesian ' +
        'distance estimator for individual sources; for a 3D atlas the inverse is adequate, and ' +
        'the asymmetric bounds 1/(plx+e_plx) and 1/(plx-e_plx) follow directly from plxMas/ePlxMas.',
      'Parallax uncertainties for sources with multiple (N) maser spots were adjusted upwards by ' +
        'sqrt(N) by the authors (ReadMe note 1).',
      'Galactic (l, b) are computed here from the catalogue J2000 RA/Dec; they agree with the ' +
        'galactic coordinates encoded in each source name to better than ' +
        `${nameCheckMax.toFixed(3)} deg over ${nameChecked} checked sources.`,
    ],
    masers,
  }

  const path = join(OUT_DIR, 'masers.json')
  writeFileSync(path, JSON.stringify(payload))
  return { path, count: masers.length, nameCheckMax, nameChecked, armCounts }
}

// --------------------------------------------------------------------------------------------
// 2. arms.json — DERIVED (Reid+2019 Table 2, "Spiral Arm Characteristics")
// --------------------------------------------------------------------------------------------

/**
 * Reid+2019 Table 2, transcribed verbatim from the published table.
 *
 *   Arm        N   l-tangency  beta range   beta_kink  R_kink        psi_<        psi_>       Width
 *   3-kpc(N)   3   337.0       15 -> 18     15         3.52+/-0.26   -4.2+/-3.8   -4.2+/-3.8  0.18+/-0.05
 *   Norma     11   327.5        5 -> 54     18+/-4     4.46+/-0.19   -1.0+/-3.3   19.5+/-5.1  0.14+/-0.10
 *   Sct-Cen   36   306.1        0 -> 104    23         4.91+/-0.09   14.1+/-1.7   12.1+/-2.4  0.23+/-0.05
 *   Sgr-Car   35   285.6        2 -> 97     24+/-2     6.04+/-0.09   17.1+/-1.6    1.0+/-2.1  0.27+/-0.04
 *   Local     28   ...         -8 -> 34      9         8.26+/-0.05   11.4+/-1.9   11.4+/-1.9  0.31+/-0.05
 *   Perseus   41   ...        -23 -> 115    40         8.87+/-0.13   10.3+/-1.4    8.7+/-2.7  0.35+/-0.06
 *   Outer     11   ...        -16 -> 71     18        12.24+/-0.36    3.0+/-4.4    9.4+/-4.0  0.65+/-0.16
 *
 * Model: ln(R / R_kink) = -(beta - beta_kink) * tan(psi), beta in radians, psi = psi_< for
 * beta <= beta_kink and psi_> for beta > beta_kink. Arm width w(R) = w(R_kink) + 42 pc/kpc * (R - R_kink).
 */
const ARM_TABLE2 = [
  {
    id: '3kpc-near',
    name: '3-kpc arm (near)',
    shortName: '3-kpc',
    armCodes: ['3kN'],
    nSources: 3,
    tangencyLongitudeDeg: 337.0,
    betaDataRangeDeg: [15, 18],
    betaKinkDeg: 15,
    eBetaKinkDeg: null,
    rKinkKpc: 3.52,
    eRKinkKpc: 0.26,
    pitchLowDeg: -4.2,
    ePitchLowDeg: 3.8,
    pitchHighDeg: -4.2,
    ePitchHighDeg: 3.8,
    widthKpc: 0.18,
    eWidthKpc: 0.05,
    betaDrawRangeDeg: [-63, 25],
    drawRangeBasis:
      'Low end set at the galactocentric azimuth of the observed l=337.0 deg tangency (beta=-62.9); ' +
      'high end is the Table 2 data limit + 7 deg.',
    connectsTo: null,
    fieldWeight: 0.04,
    notes:
      'Associated with the Galactic bar rather than being a true spiral arm (Reid+2019 Sect. 5.5); ' +
      'only 3 parallaxes constrain it.',
  },
  {
    id: 'norma',
    name: 'Norma arm',
    shortName: 'Norma',
    armCodes: ['Nor'],
    nSources: 11,
    tangencyLongitudeDeg: 327.5,
    betaDataRangeDeg: [5, 54],
    betaKinkDeg: 18,
    eBetaKinkDeg: 4,
    rKinkKpc: 4.46,
    eRKinkKpc: 0.19,
    pitchLowDeg: -1.0,
    ePitchLowDeg: 3.3,
    pitchHighDeg: 19.5,
    ePitchHighDeg: 5.1,
    widthKpc: 0.14,
    eWidthKpc: 0.1,
    betaDrawRangeDeg: [-42, 60],
    drawRangeBasis:
      'Low end set at the galactocentric azimuth of the observed l=327.5 deg tangency (beta=-42.2); ' +
      'high end is the Table 2 data limit + 6 deg.',
    connectsTo: 'outer',
    fieldWeight: 0.1,
    notes:
      'Reid+2019 Sect. 5.1 argue the Norma arm most likely wraps around the far side of the Galactic ' +
      'centre and becomes the Outer arm, but their published figure joins the two with hand-adjusted ' +
      'pitch angles. We do NOT extrapolate that join: the two arms are kept as separate fitted ' +
      'segments and the association is recorded in connectsTo only.',
  },
  {
    id: 'scutum-centaurus',
    name: 'Scutum-Centaurus-OSC arm',
    shortName: 'Sct-Cen',
    armCodes: ['ScN', 'ScF', 'CtN', 'OSC'],
    nSources: 36,
    tangencyLongitudeDeg: 306.1,
    betaDataRangeDeg: [0, 104],
    betaKinkDeg: 23,
    eBetaKinkDeg: null,
    rKinkKpc: 4.91,
    eRKinkKpc: 0.09,
    pitchLowDeg: 14.1,
    ePitchLowDeg: 1.7,
    pitchHighDeg: 12.1,
    ePitchHighDeg: 2.4,
    widthKpc: 0.23,
    eWidthKpc: 0.05,
    betaDrawRangeDeg: [-230, 110],
    drawRangeBasis:
      'Extended to beta = -230 deg because Reid+2019 Sect. 5.2 state explicitly that extending this ' +
      'same fitted model beyond the Galactic centre carries it back into the 1st quadrant as the ' +
      'Outer Scutum-Centaurus (OSC) arm near R ~ 15 kpc. Beyond beta = -44 deg (the l=306.1 deg ' +
      'tangency) the curve is an extrapolation of the fit, not a fit to data.',
    connectsTo: null,
    fieldWeight: 0.26,
    notes:
      'Fits exclude six sources near l=30 deg with unusually large proper motions (G030.22-0.17, ' +
      'G030.41-0.23, G030.74-0.04, G030.81-0.05, G030.97-0.14, G031.41+0.30).',
  },
  {
    id: 'sagittarius-carina',
    name: 'Sagittarius-Carina arm',
    shortName: 'Sgr-Car',
    armCodes: ['SgN', 'SgF', 'CrN'],
    nSources: 35,
    tangencyLongitudeDeg: 285.6,
    betaDataRangeDeg: [2, 97],
    betaKinkDeg: 24,
    eBetaKinkDeg: 2,
    rKinkKpc: 6.04,
    eRKinkKpc: 0.09,
    pitchLowDeg: 17.1,
    ePitchLowDeg: 1.6,
    pitchHighDeg: 1.0,
    ePitchHighDeg: 2.1,
    widthKpc: 0.27,
    eWidthKpc: 0.04,
    betaDrawRangeDeg: [-110, 100],
    drawRangeBasis:
      'High end is the Table 2 data limit + 3 deg. Below beta = -33 deg (the 4th-quadrant tangency ' +
      'quoted in Reid+2019 Sect. 5.3) an extra segment with pitch 10.0 deg is appended, which is the ' +
      'value the authors state they adopt there to match the CO (l,v) trace of the Carina arm.',
    extraSegments: [
      {
        betaMinDeg: -110,
        betaMaxDeg: -33,
        pitchDeg: 10.0,
        provenance:
          'Reid+2019 Sect. 5.3 text: "we decrease the pitch angle to 10 deg in order to match the ' +
          'CO (l-v) trace of the Carina arm, assuming kinematic distances".',
      },
    ],
    connectsTo: null,
    fieldWeight: 0.22,
    notes:
      'Two outliers removed from the fit (G032.74-0.07, G033.64-0.22). The kink at beta=24 deg sits in ' +
      'a real 2-kpc-long gap in the arm near (X,Y)=(2,6) kpc.',
  },
  {
    id: 'local',
    name: 'Local arm (Orion spur)',
    shortName: 'Local',
    armCodes: ['Loc', 'LoS'],
    nSources: 28,
    tangencyLongitudeDeg: null,
    betaDataRangeDeg: [-8, 34],
    betaKinkDeg: 9,
    eBetaKinkDeg: null,
    rKinkKpc: 8.26,
    eRKinkKpc: 0.05,
    pitchLowDeg: 11.4,
    ePitchLowDeg: 1.9,
    pitchHighDeg: 11.4,
    ePitchHighDeg: 1.9,
    widthKpc: 0.31,
    eWidthKpc: 0.05,
    betaDrawRangeDeg: [-14, 40],
    drawRangeBasis: 'Table 2 data range padded by 6 deg at each end; this is an isolated segment.',
    connectsTo: null,
    fieldWeight: 0.06,
    notes:
      'A single pitch angle was fitted (psi_< = psi_>). Reid+2019 Sect. 5.5: an isolated arm segment ' +
      'with very significant massive star formation that has not been linked up into a full arm. ' +
      'The Sun sits just inside it (R0 = 8.15 kpc vs R_kink = 8.26 kpc).',
  },
  {
    id: 'perseus',
    name: 'Perseus arm',
    shortName: 'Perseus',
    armCodes: ['Per'],
    nSources: 41,
    tangencyLongitudeDeg: null,
    betaDataRangeDeg: [-23, 115],
    betaKinkDeg: 40,
    eBetaKinkDeg: null,
    rKinkKpc: 8.87,
    eRKinkKpc: 0.13,
    pitchLowDeg: 10.3,
    ePitchLowDeg: 1.4,
    pitchHighDeg: 8.7,
    ePitchHighDeg: 2.7,
    widthKpc: 0.35,
    eWidthKpc: 0.06,
    betaDrawRangeDeg: [-30, 200],
    drawRangeBasis:
      'Low end is the Table 2 data limit - 7 deg. High end extrapolates the psi_> = 8.7 deg fit ' +
      'inward past the data limit, following Reid+2019 Sect. 5.4 ("extrapolating the arm with this ' +
      'pitch angle inward into the 4th quadrant"). Beyond beta = 115 deg the curve is extrapolation.',
    connectsTo: null,
    fieldWeight: 0.22,
    notes:
      'Star formation along the arm is markedly uneven: it weakens in the 3rd quadrant and there is ' +
      'an ~8 kpc stretch between l=50 and l=90 deg with little activity.',
  },
  {
    id: 'outer',
    name: 'Outer arm',
    shortName: 'Outer',
    armCodes: ['Out'],
    nSources: 11,
    tangencyLongitudeDeg: null,
    betaDataRangeDeg: [-16, 71],
    betaKinkDeg: 18,
    eBetaKinkDeg: null,
    rKinkKpc: 12.24,
    eRKinkKpc: 0.36,
    pitchLowDeg: 3.0,
    ePitchLowDeg: 4.4,
    pitchHighDeg: 9.4,
    ePitchHighDeg: 4.0,
    widthKpc: 0.65,
    eWidthKpc: 0.16,
    betaDrawRangeDeg: [-25, 80],
    drawRangeBasis: 'Table 2 data range padded by ~9 deg at each end.',
    connectsTo: null,
    fieldWeight: 0.1,
    notes:
      'The kink near beta=18 deg rests partly on the revised BeSSeL distance to S269 of 4.15 +/- 0.22 ' +
      'kpc (Quiroga-Nunez+2019), which favours Asaki+2014 over Honma+2007.',
  },
]

/** R(beta) in kpc for a Reid log-periodic arm, honouring the kink. */
function armRadiusKpc(arm, betaDeg) {
  const psi = (betaDeg <= arm.betaKinkDeg ? arm.pitchLowDeg : arm.pitchHighDeg) * DEG
  return arm.rKinkKpc * Math.exp(-(betaDeg - arm.betaKinkDeg) * DEG * Math.tan(psi))
}

/** Chained, piecewise-continuous segments ready for a renderer to evaluate without branching logic. */
function buildArmSegments(arm) {
  const [drawMin, drawMax] = arm.betaDrawRangeDeg
  const segments = []
  const extras = arm.extraSegments ?? []
  const fitMin = extras.length > 0 ? Math.max(...extras.map((s) => s.betaMaxDeg)) : drawMin

  for (const extra of extras) {
    // Chain the extra segment onto the fitted curve at its upper beta so R stays continuous.
    segments.push({
      betaMinDeg: extra.betaMinDeg,
      betaMaxDeg: extra.betaMaxDeg,
      betaRefDeg: extra.betaMaxDeg,
      rRefKpc: round(armRadiusKpc(arm, extra.betaMaxDeg), 4),
      pitchDeg: extra.pitchDeg,
      fitted: false,
      provenance: extra.provenance,
    })
  }
  if (fitMin < arm.betaKinkDeg) {
    segments.push({
      betaMinDeg: fitMin,
      betaMaxDeg: arm.betaKinkDeg,
      betaRefDeg: arm.betaKinkDeg,
      rRefKpc: arm.rKinkKpc,
      pitchDeg: arm.pitchLowDeg,
      fitted: true,
      provenance: 'Reid+2019 Table 2, psi_<',
    })
  }
  if (drawMax > arm.betaKinkDeg) {
    segments.push({
      betaMinDeg: arm.betaKinkDeg,
      betaMaxDeg: drawMax,
      betaRefDeg: arm.betaKinkDeg,
      rRefKpc: arm.rKinkKpc,
      pitchDeg: arm.pitchHighDeg,
      fitted: true,
      provenance: 'Reid+2019 Table 2, psi_>',
    })
  }
  segments.sort((a, b) => a.betaMinDeg - b.betaMinDeg)
  return segments
}

function buildArms() {
  process.stdout.write('\n[2/4] arms.json  (DERIVED)\n')

  const arms = ARM_TABLE2.map((arm) => {
    const segments = buildArmSegments(arm)
    const [drawMin, drawMax] = arm.betaDrawRangeDeg
    return {
      id: arm.id,
      name: arm.name,
      shortName: arm.shortName,
      armCodes: arm.armCodes,
      nParallaxSources: arm.nSources,
      tangencyLongitudeDeg: arm.tangencyLongitudeDeg,
      betaDataRangeDeg: arm.betaDataRangeDeg,
      betaDrawRangeDeg: arm.betaDrawRangeDeg,
      drawRangeBasis: arm.drawRangeBasis,
      extrapolatedBelowDeg: drawMin < arm.betaDataRangeDeg[0] ? arm.betaDataRangeDeg[0] : null,
      extrapolatedAboveDeg: drawMax > arm.betaDataRangeDeg[1] ? arm.betaDataRangeDeg[1] : null,
      betaKinkDeg: arm.betaKinkDeg,
      eBetaKinkDeg: arm.eBetaKinkDeg,
      rKinkKpc: arm.rKinkKpc,
      eRKinkKpc: arm.eRKinkKpc,
      pitchLowDeg: arm.pitchLowDeg,
      ePitchLowDeg: arm.ePitchLowDeg,
      pitchHighDeg: arm.pitchHighDeg,
      ePitchHighDeg: arm.ePitchHighDeg,
      widthKpc: arm.widthKpc,
      eWidthKpc: arm.eWidthKpc,
      connectsTo: arm.connectsTo,
      fieldWeight: arm.fieldWeight,
      notes: arm.notes,
      segments,
      sample: {
        rAtDrawMinKpc: round(armRadiusKpc(arm, drawMin), 4),
        rAtDataMinKpc: round(armRadiusKpc(arm, arm.betaDataRangeDeg[0]), 4),
        rAtDataMaxKpc: round(armRadiusKpc(arm, arm.betaDataRangeDeg[1]), 4),
        rAtDrawMaxKpc: round(armRadiusKpc(arm, drawMax), 4),
      },
    }
  })

  const payload = {
    kind: 'DERIVED',
    badge: 'DERIVED',
    description:
      'Log-periodic spiral-arm fits to the Reid+2019 maser parallaxes. These are fitted model curves, ' +
      'not observations: the observations they are fitted to are the ~200 points in masers.json. ' +
      'There is no photograph of the Milky Way from outside and there never will be.',
    recordCount: arms.length,
    source: {
      paper: 'Reid M.J., Menten K.M., Brunthaler A., et al. 2019, ApJ, 885, 131',
      table: 'Table 2, "Spiral Arm Characteristics"',
      extraText:
        'Sect. 4 (spiral model definition and arm-width gradient) and Sect. 5 ' +
        '("Updated Spiral Arm Model", per-arm discussion) for the draw ranges and the Carina segment.',
      bibcode: '2019ApJ...885..131R',
      doi: '10.3847/1538-4357/ab4a11',
      arxiv: 'arXiv:1910.03357',
      url: 'https://arxiv.org/abs/1910.03357',
      vizierTable: `${REID_VIZIER_ID} (parallax table; Table 2 itself is not in the VizieR catalogue)`,
      version: 'published version, ApJ 885, 131 (2019 November 1)',
      retrieved: RETRIEVED,
    },
    licence:
      'Fitted parameters reproduced from an AAS journal article (ApJ). Cite Reid et al. 2019, ' +
      'ApJ 885, 131. See LICENSE.md in this directory.',
    attribution: "Spiral-arm model: Reid et al. (2019), ApJ 885, 131, Table 2.",
    model: {
      formula: 'ln(R / R_ref) = -(beta - beta_ref) * tan(pitch)',
      formulaUnits: 'R and R_ref in kpc; beta, beta_ref and pitch in RADIANS inside the formula',
      segmentUsage:
        'For each segment, evaluate R(beta) with that segment\'s betaRefDeg/rRefKpc/pitchDeg over ' +
        '[betaMinDeg, betaMaxDeg]. Segments are chained so R is continuous across boundaries.',
      widthFormula: 'w(R) = widthKpc + (dwdRPcPerKpc / 1000) * (R - rKinkKpc)   [kpc, Gaussian 1-sigma]',
      dwdRPcPerKpc: DW_DR_PC_PER_KPC,
      widthMeaning:
        'The fitted width is the intrinsic 1-sigma width of the distribution of HIGH-MASS ' +
        'STAR-FORMING REGIONS about the arm ridge line. The broader stellar arm is wider than this.',
      toCartesian: 'X = R * sin(beta), Y = R * cos(beta), Z = 0 (arm ridge line lies in the plane)',
    },
    frame: {
      name: 'Galactocentric galactic Cartesian',
      origin: 'Galactic centre',
      axes:
        '+X along galactic rotation at the Sun (toward l=90deg); +Y from the Galactic centre toward ' +
        'the Sun; +Z toward the North Galactic Pole. Right-handed; the Galaxy\'s angular momentum ' +
        'points toward -Z.',
      sunPositionKpc: [0, R0_KPC, ZSUN_PC / 1000],
      betaDefinition:
        'beta = atan2(X, Y): galactocentric azimuth, 0 toward the Sun, increasing in the direction ' +
        'of galactic rotation (Reid+2019 convention).',
      R0Kpc: R0_KPC,
      R0Source:
        'Reid+2019 (8.15 +/- 0.15 kpc). Chosen over GRAVITY Collaboration 2019 (8.178 +/- 0.035 kpc) ' +
        'because the Table 2 arm fits were themselves derived assuming R0 = 8.15 kpc; mixing the two ' +
        'would displace the masers from their own fitted arms.',
      Theta0KmS: THETA0_KMS,
      ZsunPc: ZSUN_PC,
    },
    epoch: 'present day (the model is static)',
    units: { radii: 'kpc', angles: 'deg', widths: 'kpc' },
    caveats: [
      'betaDataRangeDeg is the azimuth range actually covered by parallax measurements. ' +
        'betaDrawRangeDeg extends past it; extrapolatedBelowDeg / extrapolatedAboveDeg mark where. ' +
        'A renderer should visually de-emphasise the extrapolated portions.',
      'Reid+2019 argue Norma connects to Outer and Scutum-Centaurus connects to OSC. The OSC ' +
        'connection is a direct extension of the same fitted spiral and is drawn. The Norma-Outer ' +
        'join required hand-adjusted pitch angles in the paper and is NOT reproduced here.',
      'Pitch angles for the 3-kpc arm and the inner Norma segment are negative, i.e. those segments ' +
        'wind in the opposite sense. That is what the fit says.',
    ],
    arms,
  }

  const path = join(OUT_DIR, 'arms.json')
  writeFileSync(path, JSON.stringify(payload))
  return { path, count: arms.length, payload }
}

// --------------------------------------------------------------------------------------------
// 3. field.bin + field.json — DERIVED, deterministic
// --------------------------------------------------------------------------------------------

const FIELD_COUNT = 300000
const FIELD_MIX = Object.freeze({ bulge: 0.08, bar: 0.04, disk: 0.48, arms: 0.4 })

const DISK_SCALE_LENGTH_KPC = 3.5
const DISK_R_MIN_KPC = 0.5
const DISK_R_MAX_KPC = 18.0
const THIN_SCALE_HEIGHT_PC = 300
const THICK_SCALE_HEIGHT_PC = 900
const THICK_FRACTION = 0.12
const ARM_SCALE_HEIGHT_PC = 180
const FLARE_SCALE_LENGTH_KPC = 9.0
const ARM_RADIAL_SCALE_KPC = 6.0
const ARM_WIDTH_SCALE = 2.0
const BAR_ANGLE_DEG = 27.0 // Wegg, Gerhard & Portail 2015, MNRAS 450, 4050
const BAR_HALF_LENGTH_KPC = 2.6
const BULGE_SCALE_KPC = 0.6
const BULGE_AXIS_RATIOS = [1.0, 0.5, 0.45]

const FLARE_MAX = 2.2
const FLARE_MIN = 0.65
/** Disk flaring: scale height grows outward. Clamped so it never runs away. */
function flare(rKpc) {
  return Math.min(FLARE_MAX, Math.max(FLARE_MIN, Math.exp((rKpc - R0_KPC) / FLARE_SCALE_LENGTH_KPC)))
}

/**
 * Double-sided exponential height, truncated at 4 scale heights. The truncation matters: an
 * untruncated exponential sprays a few hundred points 15+ kpc off the plane, which reads as a
 * stellar halo the model does not claim to contain.
 */
const Z_TRUNCATION_SCALE_HEIGHTS = 4
function sampleHeightPc(hzPc, rand) {
  let zPc
  do {
    zPc = -hzPc * Math.log(Math.max(rand(), 1e-12))
  } while (zPc > Z_TRUNCATION_SCALE_HEIGHTS * hzPc)
  return rand() < 0.5 ? -zPc : zPc
}

function buildField(armsPayload) {
  process.stdout.write('\n[3/4] field.bin  (DERIVED, deterministic)\n')
  process.stdout.write(`  PRNG: mulberry32, seed = ${FIELD_SEED}\n`)

  const rand = mulberry32(FIELD_SEED)
  const gauss = makeGaussian(rand)

  const x = new Float32Array(FIELD_COUNT)
  const y = new Float32Array(FIELD_COUNT)
  const z = new Float32Array(FIELD_COUNT)
  const colour = new Uint8Array(FIELD_COUNT)

  const nBulge = Math.round(FIELD_COUNT * FIELD_MIX.bulge)
  const nBar = Math.round(FIELD_COUNT * FIELD_MIX.bar)
  const nArms = Math.round(FIELD_COUNT * FIELD_MIX.arms)
  const nDisk = FIELD_COUNT - nBulge - nBar - nArms

  const barU = [Math.sin(BAR_ANGLE_DEG * DEG), Math.cos(BAR_ANGLE_DEG * DEG)] // long axis, near end at +l
  const barV = [Math.cos(BAR_ANGLE_DEG * DEG), -Math.sin(BAR_ANGLE_DEG * DEG)] // in-plane perpendicular

  let i = 0
  const place = (px, py, pz, tempK) => {
    x[i] = px
    y[i] = py
    z[i] = pz
    colour[i] = temperatureToColourIndex(tempK)
    i += 1
  }

  // --- boxy/peanut bulge: old, metal-rich, red ------------------------------------------------
  for (let n = 0; n < nBulge; n += 1) {
    let r = 0
    do {
      r = -BULGE_SCALE_KPC * Math.log(Math.max(rand(), 1e-12))
    } while (r > 3.0)
    const u = 2 * rand() - 1
    const phi = 2 * Math.PI * rand()
    const s = Math.sqrt(Math.max(0, 1 - u * u))
    const a = r * s * Math.cos(phi) * BULGE_AXIS_RATIOS[0]
    const b = r * s * Math.sin(phi) * BULGE_AXIS_RATIOS[1]
    const c = r * u * BULGE_AXIS_RATIOS[2]
    const X = (a * barU[0] + b * barV[0]) * 1000
    const Y = (a * barU[1] + b * barV[1]) * 1000
    const T = 3300 + 1500 * rand() ** 1.4
    place(X, Y, c * 1000, T)
  }

  // --- long bar: old, slightly warmer ---------------------------------------------------------
  for (let n = 0; n < nBar; n += 1) {
    let s = 0
    do {
      s = BAR_HALF_LENGTH_KPC * (2 * rand() - 1)
    } while (rand() > Math.exp(-((Math.abs(s) / 2.2) ** 3)))
    const p = 0.5 * gauss()
    const h = 0.25 * gauss()
    const X = (s * barU[0] + p * barV[0]) * 1000
    const Y = (s * barU[1] + p * barV[1]) * 1000
    const T = 3500 + 1900 * rand() ** 1.3
    place(X, Y, h * 1000, T)
  }

  // --- smooth exponential disk ----------------------------------------------------------------
  for (let n = 0; n < nDisk; n += 1) {
    let R = 0
    do {
      // p(R) ~ R exp(-R/h) is Gamma(shape 2, scale h): sum of two exponentials.
      R = -DISK_SCALE_LENGTH_KPC * (Math.log(Math.max(rand(), 1e-12)) + Math.log(Math.max(rand(), 1e-12)))
    } while (R < DISK_R_MIN_KPC || R > DISK_R_MAX_KPC)
    const beta = 2 * Math.PI * rand()
    const thick = rand() < THICK_FRACTION
    const hz = (thick ? THICK_SCALE_HEIGHT_PC : THIN_SCALE_HEIGHT_PC) * flare(R)
    const zPc = sampleHeightPc(hz, rand)
    // Age-metallicity gradient: inner disk old and metal-rich (red), outer disk bluer.
    let T = (4150 + 950 * Math.min(2.2, R / R0_KPC)) * Math.exp(0.2 * gauss())
    if (thick) T *= 0.9 // thick disk is older
    if (rand() < 0.02) T = 9000 + 9000 * rand() // the hot tail that gives the disk its sparkle
    place(R * Math.sin(beta) * 1000, R * Math.cos(beta) * 1000, zPc, T)
  }

  // --- spiral arms, sampled FROM the arms.json fits --------------------------------------------
  const armWeights = armsPayload.arms.map((a) => a.fieldWeight)
  const weightSum = armWeights.reduce((s, w) => s + w, 0)
  const cumulative = []
  let acc = 0
  for (const w of armWeights) {
    acc += w / weightSum
    cumulative.push(acc)
  }

  const perArmCounts = new Array(armsPayload.arms.length).fill(0)
  for (let n = 0; n < nArms; n += 1) {
    const pick = rand()
    let ai = cumulative.findIndex((c) => pick <= c)
    if (ai < 0) ai = cumulative.length - 1
    const arm = armsPayload.arms[ai]
    const table = ARM_TABLE2[ai]
    const [bMin, bMax] = arm.betaDrawRangeDeg

    let beta = 0
    let R = 0
    let tries = 0
    for (;;) {
      beta = bMin + (bMax - bMin) * rand()
      R = armRadiusKpc(table, beta)
      tries += 1
      if (R >= DISK_R_MIN_KPC && R <= DISK_R_MAX_KPC) {
        const accept = Math.min(1, Math.exp(-(R - 2.0) / ARM_RADIAL_SCALE_KPC))
        if (rand() < accept) break
      }
      if (tries > 200) break // pathological arm; take whatever we have rather than spin
    }

    const psi = (beta <= table.betaKinkDeg ? table.pitchLowDeg : table.pitchHighDeg) * DEG
    const wKpc = Math.max(0.05, arm.widthKpc + (DW_DR_PC_PER_KPC / 1000) * (R - arm.rKinkKpc))
    const dR = (gauss() * wKpc * ARM_WIDTH_SCALE) / Math.max(0.2, Math.cos(psi))
    const Rp = Math.max(0.2, R + dR)
    const hz = ARM_SCALE_HEIGHT_PC * flare(Rp)
    const zPc = sampleHeightPc(hz, rand)

    // Arms host the young, hot population — this is what makes them read blue.
    let T
    if (rand() < 0.35) T = 7000 + 13000 * rand() ** 1.6
    else T = (4700 + 2300 * rand()) * Math.exp(0.18 * gauss())

    place(Rp * Math.sin(beta * DEG) * 1000, Rp * Math.cos(beta * DEG) * 1000, zPc, T)
    perArmCounts[ai] += 1
  }

  if (i !== FIELD_COUNT) throw new Error(`field: wrote ${i} points, expected ${FIELD_COUNT}`)

  // --- pack little-endian Struct-of-Arrays -----------------------------------------------------
  const bytesPerRecord = 4 + 4 + 4 + 1
  const buffer = Buffer.alloc(FIELD_COUNT * bytesPerRecord)
  const offX = 0
  const offY = FIELD_COUNT * 4
  const offZ = FIELD_COUNT * 8
  const offC = FIELD_COUNT * 12
  for (let k = 0; k < FIELD_COUNT; k += 1) {
    buffer.writeFloatLE(x[k], offX + k * 4)
    buffer.writeFloatLE(y[k], offY + k * 4)
    buffer.writeFloatLE(z[k], offZ + k * 4)
    buffer.writeUInt8(colour[k], offC + k)
  }

  const binPath = join(OUT_DIR, 'field.bin')
  writeFileSync(binPath, buffer)

  const palette = buildPalette()

  let rMax = 0
  let zAbsMax = 0
  for (let k = 0; k < FIELD_COUNT; k += 1) {
    rMax = Math.max(rMax, Math.hypot(x[k], y[k]))
    zAbsMax = Math.max(zAbsMax, Math.abs(z[k]))
  }

  const manifest = {
    kind: 'DERIVED',
    badge: 'DERIVED',
    statement:
      'DERIVED — a statistical realisation of the Reid+2019 arm model, not a catalogue of real stars.',
    description:
      'A deterministically seeded point cloud sampling the Milky Way stellar disk, bar and bulge. ' +
      'The spiral overdensity is sampled directly from the log-periodic fits in arms.json. No point ' +
      'in this file corresponds to any real star. It exists because there is no photograph of the ' +
      'Milky Way from outside and there never will be.',
    binary: 'field.bin',
    recordCount: FIELD_COUNT,
    bytesPerRecord,
    totalBytes: buffer.length,
    layout: 'Struct-of-Arrays (all x, then all y, then all z, then all colourIndex), little-endian',
    endianness: 'little',
    fieldOrder: ['x', 'y', 'z', 'colourIndex'],
    fields: [
      { name: 'x', dtype: 'float32', byteOffset: offX, byteLength: FIELD_COUNT * 4, stride: 4, units: 'pc' },
      { name: 'y', dtype: 'float32', byteOffset: offY, byteLength: FIELD_COUNT * 4, stride: 4, units: 'pc' },
      { name: 'z', dtype: 'float32', byteOffset: offZ, byteLength: FIELD_COUNT * 4, stride: 4, units: 'pc' },
      {
        name: 'colourIndex',
        dtype: 'uint8',
        byteOffset: offC,
        byteLength: FIELD_COUNT,
        stride: 1,
        units: 'index into colour.palette (0..255)',
      },
    ],
    quantization: {
      position: 'none — x, y, z are IEEE-754 float32 parsecs, no scale or offset applied',
      colour: {
        quantized: true,
        scheme: 'log-uniform blackbody temperature index',
        dequantize: 'T_K = 2000 * 10 ** (colourIndex / 255)',
        inverse: 'colourIndex = round(255 * log10(T_K / 2000)), T clamped to [2000, 20000] K',
        temperatureRangeK: [PALETTE_T_MIN, PALETTE_T_MAX],
        note:
          'Temperature here is a colour parameter for an age/metallicity gradient, NOT a measured ' +
          'effective temperature of anything.',
      },
    },
    colour: {
      paletteSize: PALETTE_SIZE,
      paletteFormat: 'sRGB 0..255 triples, index i corresponds to T = 2000 * 10 ** (i / 255) K',
      derivation:
        'Planck spectral radiance integrated 360-830 nm against the CIE 1931 2-deg observer ' +
        '(Wyman, Sloan & Shirley 2013 multi-lobe Gaussian fits), XYZ -> linear sRGB, negative ' +
        'components clipped, normalised so the largest linear component is 1 (chromaticity only; ' +
        'brightness is the renderer\'s business), then sRGB gamma-encoded.',
      palette,
    },
    frame: {
      name: 'Galactocentric galactic Cartesian',
      origin: 'Galactic centre',
      axes:
        '+X along galactic rotation at the Sun (toward l=90deg); +Y from the Galactic centre toward ' +
        'the Sun; +Z toward the North Galactic Pole. Right-handed.',
      sunPositionPc: [0, R0_KPC * 1000, ZSUN_PC],
      R0Kpc: R0_KPC,
      units: 'parsec',
    },
    epoch: 'present day (static; no proper motion or rotation is baked in)',
    determinism: {
      prng: 'mulberry32',
      seed: FIELD_SEED,
      seedHex: `0x${FIELD_SEED.toString(16)}`,
      guarantee:
        'A single mulberry32 stream drives every draw in generation order (bulge, bar, disk, arms). ' +
        'Re-running this script on any machine reproduces field.bin byte-for-byte, which is what ' +
        'makes a shared permalink show every user the identical galaxy.',
      note: 'Math.random() is never called.',
    },
    model: {
      totalPoints: FIELD_COUNT,
      components: {
        bulge: {
          count: nBulge,
          shape: 'boxy/peanut: exponential radial profile, axis ratios 1 : 0.5 : 0.45',
          scaleLengthKpc: BULGE_SCALE_KPC,
          truncationKpc: 3.0,
          temperatureK: '3300 + 1500 * u^1.4 — old and metal-rich, so red',
        },
        bar: {
          count: nBar,
          halfLengthKpc: BAR_HALF_LENGTH_KPC,
          lengthTaper: 'accept with probability exp(-(|s|/2.2)^3)',
          crossSectionKpc: { inPlaneSigma: 0.5, verticalSigma: 0.25 },
          angleDeg: BAR_ANGLE_DEG,
          angleConvention:
            'Angle between the bar long axis and the Sun-Galactic-centre line, near end at positive ' +
            'galactic longitude.',
          angleSource: 'Wegg, Gerhard & Portail 2015, MNRAS 450, 4050 (bar angle 27 +/- 2 deg)',
          temperatureK: '3500 + 1900 * u^1.3',
        },
        disk: {
          count: nDisk,
          surfaceDensity: 'exponential, p(R) ~ R exp(-R / h_R)',
          scaleLengthKpc: DISK_SCALE_LENGTH_KPC,
          radialRangeKpc: [DISK_R_MIN_KPC, DISK_R_MAX_KPC],
          verticalProfile: 'double-sided exponential',
          thinScaleHeightPc: THIN_SCALE_HEIGHT_PC,
          thickScaleHeightPc: THICK_SCALE_HEIGHT_PC,
          thickFraction: THICK_FRACTION,
          flaring: `h_z(R) *= clamp(exp((R - R0) / ${FLARE_SCALE_LENGTH_KPC} kpc), ${FLARE_MIN}, ${FLARE_MAX})`,
          verticalTruncation: `|z| <= ${Z_TRUNCATION_SCALE_HEIGHTS} * h_z(R)`,
          temperatureK:
            '(4150 + 950 * min(2.2, R/R0)) * exp(0.2 * N(0,1)), thick disk * 0.9; 2% hot tail at ' +
            '9000-18000 K. Encodes an inside-out age/metallicity gradient: redder inward.',
        },
        arms: {
          count: nArms,
          sampledFrom: 'arms.json — the Reid+2019 log-periodic fits, evaluated over betaDrawRangeDeg',
          perArmCounts: Object.fromEntries(armsPayload.arms.map((a, k) => [a.id, perArmCounts[k]])),
          weights: Object.fromEntries(armsPayload.arms.map((a) => [a.id, a.fieldWeight])),
          radialFalloff: `accept with probability min(1, exp(-(R - 2 kpc) / ${ARM_RADIAL_SCALE_KPC} kpc))`,
          crossSection:
            `Gaussian perpendicular offset of 1-sigma = ${ARM_WIDTH_SCALE} * w(R) / cos(pitch), with ` +
            'w(R) the Reid+2019 fitted arm width plus its 42 pc/kpc gradient.',
          armWidthScale: ARM_WIDTH_SCALE,
          armWidthScaleRationale:
            'The Reid+2019 fitted width describes high-mass star-forming regions, a narrow ridge ' +
            'tracer. The broader stellar arm population is wider, so the fitted width is scaled by ' +
            `${ARM_WIDTH_SCALE}. This is a presentation choice, not a measurement.`,
          scaleHeightPc: ARM_SCALE_HEIGHT_PC,
          verticalProfile: `double-sided exponential, flared, truncated at |z| <= ${Z_TRUNCATION_SCALE_HEIGHTS} * h_z(R)`,
          temperatureK:
            '35% drawn from 7000 + 13000 * u^1.6 (the young, hot population), 65% from ' +
            '(4700 + 2300 * u) * exp(0.18 * N(0,1)). Net effect: arms read blue against a red disk.',
        },
      },
    },
    extent: {
      maxCylindricalRadiusPc: round(rMax, 1),
      maxAbsZPc: round(zAbsMax, 1),
    },
    source: {
      derivedFrom: 'public/data/galaxy/arms.json (Reid et al. 2019, ApJ 885, 131, Table 2)',
      generator: 'scripts/build-galaxy-field.mjs',
      paper: 'Reid M.J., Menten K.M., Brunthaler A., et al. 2019, ApJ, 885, 131',
      bibcode: '2019ApJ...885..131R',
      doi: '10.3847/1538-4357/ab4a11',
      barGeometry: 'Wegg C., Gerhard O., Portail M. 2015, MNRAS 450, 4050 (2015MNRAS.450.4050W)',
      version: 'generated 2026-10-14 from arms.json',
      retrieved: RETRIEVED,
    },
    licence:
      'The generated point cloud is an original work of this project and carries no third-party ' +
      'licence. The arm parameters it was generated from are from Reid et al. 2019 (ApJ) — see ' +
      'LICENSE.md in this directory.',
    attribution:
      'Milky Way disk field: DERIVED — a statistical realisation of the Reid et al. (2019) arm model, ' +
      'not a catalogue of real stars.',
    reader: [
      'const buf = await (await fetch("field.bin")).arrayBuffer()',
      'const N = manifest.recordCount',
      'const x = new Float32Array(buf, 0, N)        // pc',
      'const y = new Float32Array(buf, 4*N, N)      // pc',
      'const z = new Float32Array(buf, 8*N, N)      // pc',
      'const c = new Uint8Array(buf, 12*N, N)       // palette index',
      '// Float32Array views require a 4-byte-aligned offset; 0, 4N and 8N always satisfy that.',
    ],
  }

  const manifestPath = join(OUT_DIR, 'field.json')
  writeFileSync(manifestPath, JSON.stringify(manifest))
  return { binPath, manifestPath, count: FIELD_COUNT, bytes: buffer.length, perArmCounts }
}

// --------------------------------------------------------------------------------------------
// 4. localgroup.json — MEASURED (UNGC, Karachentsev+2013)
// --------------------------------------------------------------------------------------------

const UNGC_VIZIER_ID = 'J/AJ/145/101'
const UNGC_CATALOG_URL =
  'https://vizier.cds.unistra.fr/viz-bin/asu-tsv?-source=J/AJ/145/101/catalog&-out.max=unlimited' +
  '&-out=Name,RAJ2000,DEJ2000,a26,Bmag,Kmag,TT,Mcl,Tdw,HRV,Dist,f_Dist,BMag,Ti1,MD,Ti5,SimbadName,NEDname'
const UNGC_TABLE6_URL =
  'https://vizier.cds.unistra.fr/viz-bin/asu-tsv?-source=J/AJ/145/101/table6&-out.max=unlimited' +
  '&-out=Name,DM,e_DM,n_DM,r_DM'

/** Everything inside this radius is treated as the Local Group census. */
const LOCAL_GROUP_CUTOFF_MPC = 1.5

const MORPHOLOGY_T_TYPE = {
  '-3': 'E (dSph/dE)',
  '-2': 'E/S0',
  '-1': 'S0',
  0: 'S0/a',
  1: 'Sa',
  2: 'Sab',
  3: 'Sb',
  4: 'Sbc',
  5: 'Sc',
  6: 'Scd',
  7: 'Sd',
  8: 'Sdm',
  9: 'Sm',
  10: 'Im / Ir',
  11: 'cI (compact irregular)',
}

function normaliseName(name) {
  return name.replace(/\s+/gu, ' ').trim()
}

function hostOf(mainDisturber, name) {
  const md = normaliseName(mainDisturber ?? '').toUpperCase()
  const self = normaliseName(name).toUpperCase()
  if (self === 'MILKY WAY') return 'MW'
  if (self === 'MESSIER031' || self === 'M31') return 'M31'
  if (md === 'MILKY WAY' || md === 'LMC' || md === 'SAG DSPH') return 'MW'
  if (md === 'MESSIER031' || md === 'NGC0205' || md === 'MESSIER033') return 'M31'
  return 'LG-other'
}

async function buildLocalGroup() {
  process.stdout.write('\n[4/4] localgroup.json  (MEASURED)\n')
  const catalogTsv = await cachedFetch(UNGC_CATALOG_URL, 'ungc_catalog.tsv')
  const table6Tsv = await cachedFetch(UNGC_TABLE6_URL, 'ungc_table6.tsv')

  const catalogRows = parseVizierTsv(catalogTsv).filter((r) => r.Name && r.Name.trim().length > 0)
  const dmRows = parseVizierTsv(table6Tsv).filter((r) => r.Name && r.Name.trim().length > 0)

  // Index table6 distance moduli by (name, method) so we can match the adopted method in f_Dist.
  const dmByName = new Map()
  for (const row of dmRows) {
    const key = normaliseName(row.Name)
    const dm = num(row.DM)
    if (dm === null) continue
    if (!dmByName.has(key)) dmByName.set(key, [])
    dmByName.get(key).push({ dm, eDm: num(row.e_DM), method: (row.n_DM ?? '').trim(), ref: (row.r_DM ?? '').trim() })
  }

  const galaxies = []
  let totalLocalVolume = 0
  let dmMatched = 0

  for (const row of catalogRows) {
    const distMpc = num(row.Dist)
    if (distMpc === null) continue
    totalLocalVolume += 1
    if (distMpc > LOCAL_GROUP_CUTOFF_MPC) continue

    const name = normaliseName(row.Name)
    const ra = sexagesimalToDeg(row.RAJ2000, true)
    const dec = sexagesimalToDeg(row.DEJ2000, false)
    if (ra === null || dec === null) continue
    const { l, b } = equatorialToGalactic(ra, dec)

    const adoptedMethod = (row.f_Dist ?? '').trim()
    const candidates = dmByName.get(name) ?? []
    const matching = candidates.filter((c) => c.method === adoptedMethod)
    const pool = matching.length > 0 ? matching : candidates

    let distanceKpc = distMpc * 1000
    let distanceModulus = null
    let eDistanceModulus = null
    let distancePrecision = 'catalog' // UNGC "Dist" column, rounded to 0.01 Mpc
    if (pool.length > 0) {
      distanceModulus = pool.reduce((s, c) => s + c.dm, 0) / pool.length
      const errs = pool.map((c) => c.eDm).filter((e) => e !== null)
      eDistanceModulus = errs.length > 0 ? errs.reduce((s, e) => s + e, 0) / errs.length : null
      distanceKpc = 10 ** (distanceModulus / 5 + 1) / 1000
      distancePrecision = matching.length > 0 ? 'distance-modulus (adopted method)' : 'distance-modulus (any method)'
      dmMatched += 1
    }

    const host = hostOf(row.MD, name)
    const isSelf = name === 'Milky Way'
    const isHost = isSelf || name === 'MESSIER031'
    const dKpcForGeometry = isSelf ? 0 : distanceKpc
    // UNGC lists the Milky Way with Dist = 0.01 Mpc, which is the Sun-Galactic-centre distance,
    // not a distance to a galaxy. Emitting it as a distance would plant a galaxy 8 kpc away.
    const sunToGcKpc = isSelf ? distanceKpc : null
    if (isSelf) {
      distanceKpc = 0
      distanceModulus = null
      eDistanceModulus = null
      distancePrecision = 'n/a — we are inside this galaxy'
    }
    const xh = dKpcForGeometry * Math.cos(b * DEG) * Math.cos(l * DEG) // kpc, toward the GC
    const yh = dKpcForGeometry * Math.cos(b * DEG) * Math.sin(l * DEG)
    const zh = dKpcForGeometry * Math.sin(b * DEG)

    const tt = num(row.TT)

    galaxies.push({
      id: name.toLowerCase().replaceAll(/[^a-z0-9]+/gu, '-').replaceAll(/(^-|-$)/gu, ''),
      name,
      simbadName: (row.SimbadName ?? '').trim() || null,
      nedName: (row.NEDname ?? '').trim() || null,
      raDeg: round(ra, 5),
      decDeg: round(dec, 5),
      lDeg: round(l, 4),
      bDeg: round(b, 4),
      distanceKpc: round(distanceKpc, 2),
      distanceMpc: round(distanceKpc / 1000, 5),
      distanceModulus: round(distanceModulus, 3),
      eDistanceModulus: round(eDistanceModulus, 3),
      distanceMethod: adoptedMethod || null,
      distancePrecision,
      ungcDistMpc: distMpc,
      sunToGalacticCentreKpc: sunToGcKpc === null ? null : round(sunToGcKpc, 2),
      // Heliocentric galactic Cartesian, kpc: +x toward the GC, +y toward l=90, +z toward the NGP.
      xHelioKpc: round(xh, 3),
      yHelioKpc: round(yh, 3),
      zHelioKpc: round(zh, 3),
      host,
      kind: isHost ? 'host' : 'satellite-or-member',
      mainDisturber: normaliseName(row.MD ?? '') || null,
      tidalIndexTheta1: num(row.Ti1),
      tidalIndexTheta5: num(row.Ti5),
      morphologyTType: tt,
      morphology: tt !== null ? (MORPHOLOGY_T_TYPE[String(tt)] ?? null) : null,
      dwarfMorphology: (row.Mcl ?? '').trim() || null,
      surfaceBrightnessClass: (row.Tdw ?? '').trim() || null,
      apparentBMag: num(row.Bmag),
      absoluteBMag: num(row.BMag),
      apparentKMag: num(row.Kmag),
      majorAxisArcmin: num(row.a26),
      radialVelocityHelioKmS: num(row.HRV),
    })
  }

  galaxies.sort((a, b) => (a.distanceKpc ?? Infinity) - (b.distanceKpc ?? Infinity))

  const hostCounts = {}
  for (const g of galaxies) hostCounts[g.host] = (hostCounts[g.host] ?? 0) + 1

  const named = (n) => galaxies.find((g) => g.name === n) ?? null
  const landmark = (n, label) => {
    const g = named(n)
    return g ? { label, name: n, distanceKpc: g.distanceKpc, distanceMpc: g.distanceMpc, method: g.distanceMethod } : null
  }

  const payload = {
    kind: 'MEASURED',
    badge: 'MEASURED',
    description:
      'The Local Group census: every galaxy in the Updated Nearby Galaxy Catalog within ' +
      `${LOCAL_GROUP_CUTOFF_MPC} Mpc. Distances are primarily TRGB, Cepheid, horizontal-branch and ` +
      'colour-magnitude-diagram measurements, not redshift-derived.',
    recordCount: galaxies.length,
    cutoffMpc: LOCAL_GROUP_CUTOFF_MPC,
    sourceRowsAvailable: totalLocalVolume,
    sourceRowsNote:
      `The full UNGC catalogue table served by VizieR holds ${totalLocalVolume} Local Volume galaxies ` +
      `with a distance (out to 26.2 Mpc); ${galaxies.length} of them fall inside ${LOCAL_GROUP_CUTOFF_MPC} Mpc ` +
      'and are emitted here. The remainder belongs to the cosmic layer, not the galactic layer.',
    hostCounts,
    distanceModulusMatched: dmMatched,
    landmarks: [
      landmark('LMC', 'Large Magellanic Cloud'),
      landmark('SMC', 'Small Magellanic Cloud'),
      landmark('MESSIER031', 'M31 Andromeda'),
      landmark('MESSIER033', 'M33 Triangulum'),
    ].filter(Boolean),
    source: {
      paper: 'Karachentsev I.D., Makarov D.I., Kaisina E.I. 2013, AJ, 145, 101',
      title: 'Updated Nearby Galaxy Catalog (UNGC)',
      bibcode: '2013AJ....145..101K',
      doi: '10.1088/0004-6256/145/4/101',
      vizierTable: `${UNGC_VIZIER_ID}/catalog (main table) + ${UNGC_VIZIER_ID}/table6 (distance moduli)`,
      vizierDoi: '10.26093/cds/vizier.51450101',
      url: UNGC_CATALOG_URL,
      secondaryUrl: UNGC_TABLE6_URL,
      version: `VizieR catalogue ${UNGC_VIZIER_ID} (catalog: 869 rows, table6: 783 rows)`,
      retrieved: RETRIEVED,
      liveVersion:
        'The catalogue is maintained live at http://www.sao.ru/lv/lvgdb/ ; the VizieR snapshot is ' +
        'the 2013 published version and is what is pinned here.',
    },
    licence:
      'Table reproduced from an AAS journal article (AJ) via VizieR/CDS. Cite Karachentsev et al. ' +
      '2013, AJ 145, 101 and the VizieR service. See LICENSE.md in this directory.',
    attribution:
      'Local Group census: Karachentsev, Makarov & Kaisina (2013), AJ 145, 101 (Updated Nearby ' +
      'Galaxy Catalog) — VizieR J/AJ/145/101 (CDS, Strasbourg).',
    frame: {
      equatorial: 'ICRS / J2000 (RA, Dec in degrees)',
      galactic: 'IAU galactic (l, b in degrees)',
      cartesian:
        'Heliocentric galactic Cartesian, kpc: +x toward the Galactic centre (l=0, b=0), ' +
        '+y toward l=90 deg, +z toward the North Galactic Pole. The Sun is the origin. ' +
        'NOTE: this differs from the galactocentric frame used by masers.json and field.bin — ' +
        'at Local Group distances the 8.15 kpc offset is negligible but the axes differ, so convert ' +
        'with X = y, Y = 8.15 - x, Z = z + 0.0055 (kpc) if you need the galactocentric frame.',
      note: 'The "Milky Way" row is emitted with kind="host" and all Cartesian components zero.',
    },
    epoch: 'J2000.0',
    units: {
      distanceKpc: 'kpc (0 on the Milky Way row — we are inside it)',
      distanceMpc: 'Mpc',
      sunToGalacticCentreKpc: 'kpc, set only on the Milky Way row; see caveats',
      distanceModulus: 'mag',
      xHelioKpc: 'kpc',
      apparentBMag: 'mag',
      absoluteBMag: 'mag',
      majorAxisArcmin: 'arcmin (Holmberg diameter a26)',
      radialVelocityHelioKmS: 'km/s',
      tidalIndexTheta1: 'dimensionless (UNGC tidal index Theta_1)',
    },
    caveats: [
      'distancePrecision tells you which number you are looking at. "distance-modulus (adopted ' +
        'method)" means distanceKpc was recomputed from the UNGC table6 distance modulus measured ' +
        'with the method the catalogue adopts, which is far more precise than the main table\'s ' +
        '"Dist" column rounded to 0.01 Mpc (= 10 kpc, useless for Milky Way satellites).',
      'UNGC is the 2013 published catalogue. Roughly 40 ultra-faint Milky Way satellites discovered ' +
        'since (DES, Pan-STARRS, HSC, Gaia) are NOT in it. This file is complete with respect to its ' +
        'source, not with respect to the sky.',
      'The "Milky Way" row exists in UNGC with Dist = 0.01 Mpc, which is its Sun-Galactic-centre ' +
        'distance, not a distance to a galaxy. It is emitted with kind="host", distanceKpc = 0 and ' +
        'zeroed Cartesian coordinates so a renderer cannot place a galaxy 8 kpc from the Sun. The ' +
        'UNGC value is preserved in sunToGalacticCentreKpc (7.94 kpc from its "geom" distance ' +
        `modulus) — note this differs from the R0 = ${R0_KPC} kpc that masers.json, arms.json and ` +
        'field.bin use, which is Reid+2019. Prefer R0 = 8.15 kpc; the UNGC number is kept only so ' +
        'nothing is silently discarded.',
      'host is assigned from the UNGC "main disturber" (MD) column, which is a tidal-influence ' +
        'assignment, not a dynamical membership proof.',
    ],
    galaxies,
  }

  const path = join(OUT_DIR, 'localgroup.json')
  writeFileSync(path, JSON.stringify(payload))
  return { path, count: galaxies.length, totalLocalVolume, hostCounts, dmMatched, landmarks: payload.landmarks }
}

// --------------------------------------------------------------------------------------------
// LICENSE.md
// --------------------------------------------------------------------------------------------

function writeLicence() {
  const text = `# Licences and required attribution — \`public/data/galaxy/\`

Generated by \`scripts/build-galaxy-field.mjs\` on ${RETRIEVED}.
Every string in the **Attribution strings the UI must display** section below is mandatory
wherever the corresponding layer is rendered.

---

## 1. \`masers.json\` — MEASURED

**Reid M. J., Menten K. M., Brunthaler A., Zheng X. W., Dame T. M., Xu Y., Li J., Sakai N., Wu Y.,
Immer K., Zhang B., Sanna A., Moscadelli L., Rygl K. L. J., Bartkiewicz A., Hu B., Quiroga-Nuñez
L. H., van Langevelde H. J. (2019), "Trigonometric Parallaxes of High-mass Star-forming Regions:
Our View of the Milky Way", _The Astrophysical Journal_ **885**, 131.**

- Bibcode \`2019ApJ...885..131R\` · DOI \`10.3847/1538-4357/ab4a11\`
- Retrieved from VizieR catalogue **${REID_VIZIER_ID}/table1** (199 rows), VizieR catalogue DOI
  \`10.26093/cds/vizier.18850131\`
- Retrieved ${RETRIEVED}

## 2. \`arms.json\` — DERIVED

Same paper, **Table 2 ("Spiral Arm Characteristics")**, plus Sect. 4 and Sect. 5 of the text for the
arm-width gradient and the per-arm azimuth extensions. Table 2 is not part of the VizieR catalogue;
the values were transcribed from the published article (arXiv:1910.03357).

## 3. \`field.bin\` / \`field.json\` — DERIVED

Generated by this repository. No third-party data is embedded. It is a statistical realisation of
the Reid et al. (2019) arm model, so that paper must still be credited. The bar geometry follows
**Wegg C., Gerhard O., Portail M. (2015), MNRAS 450, 4050** (bar angle 27°).

## 4. \`localgroup.json\` — MEASURED

**Karachentsev I. D., Makarov D. I., Kaisina E. I. (2013), "Updated Nearby Galaxy Catalog",
_The Astronomical Journal_ **145**, 101.**

- Bibcode \`2013AJ....145..101K\` · DOI \`10.1088/0004-6256/145/4/101\`
- Retrieved from VizieR catalogue **${UNGC_VIZIER_ID}** (main \`catalog\` table, 869 rows, and
  \`table6\` distance moduli, 783 rows), VizieR catalogue DOI \`10.26093/cds/vizier.51450101\`
- Retrieved ${RETRIEVED}

---

## VizieR / CDS

Both catalogues were retrieved through the VizieR service and its acknowledgement is required:

> This research has made use of the VizieR catalogue access tool, CDS, Strasbourg, France
> (DOI: 10.26093/cds/vizier). The original description of the VizieR service was published in
> 2000, A&AS 143, 23.

VizieR rules of usage: <https://cds.unistra.fr/vizier-org/licences_vizier.html>

## Copyright status — read this before any commercial use

Both source tables were first published in **AAS journals** (ApJ 2019, AJ 2013). VizieR's rules of
usage state that "the data retrieved with VizieR are free of usage in a scientific context" and that
"the commercial usage of the data is subject to rules depending of the origin", directing users to
the publisher's policy — for AAS titles, <https://journals.aas.org/aas-copyright-policy/>. Neither
article predates the AAS's 2022 move to CC BY 4.0, so neither carries an explicit open licence.

**Status for this project: attribution-required, commercial reuse unverified.** The derived files in
this directory are small, transformed subsets (coordinate conversions, unit changes, a filtered
census) published with full citation. If OmniAtlas is ever monetised, confirm reuse terms with the
AAS before shipping \`masers.json\`, \`arms.json\` and \`localgroup.json\`. \`field.bin\` is
unaffected: it contains no third-party rows.

---

## Attribution strings the UI must display

| File | Badge | String |
|---|---|---|
| \`masers.json\` | MEASURED | Maser parallaxes: Reid et al. (2019), ApJ 885, 131 — VizieR J/ApJ/885/131 (CDS, Strasbourg). |
| \`arms.json\` | DERIVED | Spiral-arm model: Reid et al. (2019), ApJ 885, 131, Table 2. |
| \`field.bin\` | DERIVED | Milky Way disk field: DERIVED — a statistical realisation of the Reid et al. (2019) arm model, not a catalogue of real stars. |
| \`localgroup.json\` | MEASURED | Local Group census: Karachentsev, Makarov & Kaisina (2013), AJ 145, 101 (Updated Nearby Galaxy Catalog) — VizieR J/AJ/145/101 (CDS, Strasbourg). |

Service credit, shown once wherever any of the above appears:

> This research has made use of the VizieR catalogue access tool, CDS, Strasbourg, France
> (DOI: 10.26093/cds/vizier).
`
  const path = join(OUT_DIR, 'LICENSE.md')
  writeFileSync(path, text)
  return path
}

// --------------------------------------------------------------------------------------------
// main
// --------------------------------------------------------------------------------------------

const started = Date.now()
mkdirSync(OUT_DIR, { recursive: true })
process.stdout.write(`build-galaxy-field.mjs\n  output: ${OUT_DIR}\n  cache:  ${CACHE_DIR}\n`)

const masers = await buildMasers()
const arms = buildArms()
const field = buildField(arms.payload)
const localGroup = await buildLocalGroup()
const licencePath = writeLicence()

// --------------------------------------------------------------------------------------------
// summary
// --------------------------------------------------------------------------------------------

const rows = [
  ['masers.json', 'MEASURED', masers.count, masers.path],
  ['arms.json', 'DERIVED', arms.count, arms.path],
  ['field.bin', 'DERIVED', field.count, field.binPath],
  ['field.json', 'DERIVED', 1, field.manifestPath],
  ['localgroup.json', 'MEASURED', localGroup.count, localGroup.path],
  ['LICENSE.md', '-', 1, licencePath],
]

process.stdout.write('\n' + '='.repeat(78) + '\n')
process.stdout.write('SUMMARY\n')
process.stdout.write('='.repeat(78) + '\n')
let total = 0
for (const [name, badge, count, path] of rows) {
  const bytes = statSync(path).size
  total += bytes
  process.stdout.write(
    `  ${name.padEnd(16)} ${badge.padEnd(9)} ${String(count).padStart(7)} rec  ${fmtBytes(bytes).padStart(10)}  ${path}\n`,
  )
}
process.stdout.write(`  ${''.padEnd(16)} ${''.padEnd(9)} ${''.padStart(7)}      ${fmtBytes(total).padStart(10)}  TOTAL\n`)

process.stdout.write(`\n  masers:      ${masers.count} rows, arm codes: `)
process.stdout.write(
  Object.entries(masers.armCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(' ') + '\n',
)
process.stdout.write(
  `               l/b cross-check vs source names: max deviation ${masers.nameCheckMax.toFixed(4)} deg ` +
    `over ${masers.nameChecked} sources\n`,
)
process.stdout.write(`  arms:        ${arms.count} fitted arms, R0 = ${R0_KPC} kpc (Reid+2019)\n`)
process.stdout.write(`  field:       ${field.count} points, mulberry32 SEED = ${FIELD_SEED}\n`)
for (const arm of arms.payload.arms) {
  const k = arms.payload.arms.indexOf(arm)
  process.stdout.write(`                 ${arm.id.padEnd(20)} ${String(field.perArmCounts[k]).padStart(6)} arm points\n`)
}
process.stdout.write(
  `  localgroup:  ${localGroup.count} galaxies within ${LOCAL_GROUP_CUTOFF_MPC} Mpc ` +
    `(out of ${localGroup.totalLocalVolume} UNGC Local Volume rows retrieved); ` +
    `${localGroup.dmMatched} refined from distance moduli\n`,
)
process.stdout.write(
  `               hosts: ` +
    Object.entries(localGroup.hostCounts)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ') + '\n',
)
for (const lm of localGroup.landmarks) {
  process.stdout.write(`                 ${lm.label.padEnd(26)} ${String(lm.distanceKpc).padStart(10)} kpc  (${lm.method})\n`)
}
process.stdout.write(`\n  done in ${((Date.now() - started) / 1000).toFixed(1)} s\n`)
