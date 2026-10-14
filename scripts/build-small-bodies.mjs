/**
 * build-small-bodies.mjs — JPL SBDB ingest for OmniAtlas.
 *
 * Produces:
 *   public/data/smallbodies/named.json        notable named asteroids + comets, full osculating elements
 *   public/data/smallbodies/belt.bin          Float32 Struct-of-Arrays, ~80k main-belt members
 *   public/data/smallbodies/belt.manifest.json
 *   public/data/smallbodies/LICENSE.md
 *
 * Source: JPL Small-Body Database Query API (https://ssd-api.jpl.nasa.gov/sbdb_query.api).
 * Build time only — the endpoint sends no Access-Control-Allow-Origin header.
 *
 * Usage: node scripts/build-small-bodies.mjs [--refresh]
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CACHE_DIR = join(REPO_ROOT, '.cache', 'sbdb')
const OUT_DIR = join(REPO_ROOT, 'public', 'data', 'smallbodies')

const API = 'https://ssd-api.jpl.nasa.gov/sbdb_query.api'
const API_DOC = 'https://ssd-api.jpl.nasa.gov/doc/sbdb_query.html'
const RETRIEVED = '2026-10-14'
const REFRESH = process.argv.includes('--refresh')

const LICENCE =
  'Public domain (work of the U.S. Government, NASA/JPL-Caltech). Courtesy credit requested.'
const ATTRIBUTION =
  'Orbital and physical data: NASA/JPL Small-Body Database (SBDB), Jet Propulsion Laboratory / California Institute of Technology.'

const DEG2RAD = Math.PI / 180

/* ------------------------------------------------------------------ fetch */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function cacheKey(name, params) {
  const hash = createHash('sha256').update(params.toString()).digest('hex').slice(0, 12)
  return join(CACHE_DIR, `${name}.${hash}.json`)
}

/** Fetch one SBDB query, cached on disk so reruns are offline-safe. */
async function sbdb(name, paramsObject) {
  const params = new URLSearchParams(paramsObject)
  const file = cacheKey(name, params)
  if (!REFRESH && existsSync(file)) {
    return JSON.parse(readFileSync(file, 'utf-8'))
  }
  const url = `${API}?${params.toString()}`
  let lastError = null
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' } })
      const text = await response.text()
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`)
      const json = JSON.parse(text)
      if (json.code && json.code !== '200') throw new Error(`SBDB ${json.code}: ${json.message}`)
      mkdirSync(CACHE_DIR, { recursive: true })
      writeFileSync(file, JSON.stringify(json))
      process.stdout.write(
        `  fetched ${name.padEnd(26)} rows=${String(json.data?.length ?? 0).padStart(6)} ` +
          `(${(text.length / 1024).toFixed(0)} KiB)\n`,
      )
      return json
    } catch (error) {
      lastError = error
      if (attempt < 3) await sleep(2000 * (attempt + 1))
    }
  }
  throw new Error(`SBDB query "${name}" failed after 4 attempts: ${lastError?.message}`)
}

/** Turn SBDB's {fields,data} column form into objects. */
function rows(json) {
  const fields = json.fields
  return (json.data ?? []).map((row) => {
    const out = {}
    for (let k = 0; k < fields.length; k += 1) out[fields[k]] = row[k]
    return out
  })
}

const num = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)

// SBDB is unit-inconsistent on 'density': almost every row is g/cm^3 (0.3..6), but a
// few (e.g. 152830 Dinkinesh = 2400) are served in kg/m^3. Our schema declares g/cm^3,
// so normalise those. No known small body exceeds ~10 g/cm^3, so the test is unambiguous.
const densityGCm3 = (v) => {
  const n = num(v)
  if (n === null) return null
  return n > 100 ? n / 1000 : n
}
const round = (v, dp) => (v === null ? null : Number(v.toFixed(dp)))

/* ------------------------------------------------------- named.json pools */

const NAMED_FIELDS = [
  'spkid', 'full_name', 'pdes', 'name', 'prefix', 'kind', 'class', 'neo', 'pha',
  'epoch', 'e', 'a', 'q', 'i', 'om', 'w', 'ma', 'tp', 'per_y', 'n', 'ad',
  'H', 'G', 'M1', 'K1', 'diameter', 'extent', 'GM', 'density', 'rot_per', 'pole',
  'albedo', 'BV', 'spec_T', 'spec_B', 'moid', 't_jup',
  'orbit_id', 'source', 'soln_date', 'condition_code', 'data_arc', 'n_obs_used',
  'first_obs', 'last_obs', 'producer',
].join(',')

const cdata = (object) => JSON.stringify(object)

/** Objects that must be present no matter what the brightness cuts do. */
const MUST_HAVE_PDES = [
  // Big main belt / spacecraft targets / radar-characterised NEAs
  '1', '2', '3', '4', '10', '16', '21', '52', '87', '243', '253', '433', '511', '617',
  '704', '951', '1620', '1862', '2060', '2062', '3200', '3548', '4179', '4769', '5535',
  '6489', '9969', '11351', '25143', '65803', '99942', '101955', '152830', '162173',
  '175706', '2867', '21900', '52246', '15094', '11351',
  // Distant / dwarf planets / Arrokoth
  '134340', '136199', '136108', '136472', '50000', '90377', '20000', '28978', '90482',
  '225088', '486958', '10199', '2060',
  // Comets by packed designation
  '1P', '2P', '9P', '19P', '21P', '26P', '55P', '67P', '73P', '81P', '103P', '109P', '153P',
]

/** Comets and interstellar objects whose designations contain a space (EQ rejects spaces). */
const MUST_HAVE_PDES_REGEX = [
  '^1995 O1$',   // C/1995 O1 Hale-Bopp
  '^2020 F3$',   // C/2020 F3 NEOWISE
  '^1996 B2$',   // C/1996 B2 Hyakutake
  '^2006 P1$',   // C/2006 P1 McNaught
  '^2012 S1$',   // C/2012 S1 ISON
  '^2013 A1$',   // C/2013 A1 Siding Spring
  '^2021 A1$',   // C/2021 A1 Leonard
  '^2023 A3$',   // C/2023 A3 Tsuchinshan-ATLAS
  '^2014 UN271$',// C/2014 UN271 Bernardinelli-Bernstein
  '^2017 U1$',   // 1I/'Oumuamua (SBDB: A/2017 U1)
  '^2019 Q4$',   // 2I/Borisov
  '^1973 E1$',   // C/1973 E1 Kohoutek
  '^1975 V1$',   // C/1975 V1 West
  '^1965 S1$',   // C/1965 S1 Ikeya-Seki
]

function chunk(array, size) {
  const out = []
  for (let k = 0; k < array.length; k += size) out.push(array.slice(k, k + size))
  return out
}

const ORBIT_CLASS_NAME = {
  IEO: 'Atira (interior-Earth) asteroid', ATE: 'Aten near-Earth asteroid',
  APO: 'Apollo near-Earth asteroid', AMO: 'Amor near-Earth asteroid',
  MCA: 'Mars-crossing asteroid', IMB: 'Inner main-belt asteroid',
  MBA: 'Main-belt asteroid', OMB: 'Outer main-belt asteroid',
  TJN: 'Jupiter Trojan', AST: 'Asteroid (unclassified)', CEN: 'Centaur',
  TNO: 'Trans-Neptunian object', PAA: 'Parabolic asteroid', HYA: 'Hyperbolic asteroid',
  ETc: 'Encke-type comet', JFc: 'Jupiter-family comet (Levison-Duncan)',
  JFC: 'Jupiter-family comet (classical)', CTc: 'Chiron-type comet',
  HTC: 'Halley-type comet', PAR: 'Parabolic comet', HYP: 'Hyperbolic comet',
  COM: 'Comet (unclassified)',
}

/** Coarse family bucket the UI can filter on. */
function familyOf(orbitClass, kind) {
  if (kind?.startsWith('c')) return 'comet'
  switch (orbitClass) {
    case 'IEO': case 'ATE': case 'APO': case 'AMO': return 'NEA'
    case 'MCA': return 'Mars-crosser'
    case 'IMB': case 'MBA': case 'OMB': return 'MBA'
    case 'TJN': return 'Jupiter Trojan'
    case 'CEN': return 'Centaur'
    case 'TNO': return 'TNO'
    case 'PAA': case 'HYA': case 'PAR': case 'HYP': return 'interstellar/unbound'
    default: return 'other'
  }
}

function buildNamedRecord(r) {
  const orbitClass = str(r.class)
  const kind = str(r.kind)
  const elements = {
    epochJdTdb: num(r.epoch),
    aAu: round(num(r.a), 9),
    e: round(num(r.e), 9),
    iDeg: round(num(r.i), 6),
    omDeg: round(num(r.om), 6),
    wDeg: round(num(r.w), 6),
    maDeg: round(num(r.ma), 6),
    qAu: round(num(r.q), 9),
    adAu: round(num(r.ad), 9),
    tpJdTdb: round(num(r.tp), 6),
    periodYr: round(num(r.per_y), 6),
    nDegPerDay: round(num(r.n), 9),
  }
  const physical = {
    H: num(r.H),
    G: num(r.G),
    M1: num(r.M1),
    K1: num(r.K1),
    diameterKm: num(r.diameter),
    extentKm: str(r.extent),
    gmKm3S2: num(r.GM),
    densityGCm3: densityGCm3(r.density),
    rotPeriodH: num(r.rot_per),
    poleRaDecDeg: str(r.pole),
    albedo: num(r.albedo),
    bv: num(r.BV),
    specT: str(r.spec_T),
    specB: str(r.spec_B),
  }
  const orbitSolution = {
    orbitId: str(r.orbit_id),
    source: str(r.source),
    solnDate: str(r.soln_date),
    conditionCode: str(r.condition_code),
    dataArcDays: num(r.data_arc),
    nObsUsed: num(r.n_obs_used),
    firstObs: str(r.first_obs),
    lastObs: str(r.last_obs),
    producer: str(r.producer),
  }
  const drop = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null))
  return {
    id: `sb-${r.spkid}`,
    spkid: r.spkid === null || r.spkid === undefined ? null : String(r.spkid),
    pdes: str(r.pdes),
    name: str(r.name),
    fullName: str(r.full_name),
    prefix: str(r.prefix),
    kind,
    numbered: kind?.endsWith('n') ?? false,
    orbitClass,
    orbitClassName: ORBIT_CLASS_NAME[orbitClass] ?? null,
    family: familyOf(orbitClass, kind),
    neo: r.neo === 'Y',
    pha: r.pha === 'Y',
    moidAu: round(num(r.moid), 6),
    tJup: round(num(r.t_jup), 4),
    elements: drop(elements),
    physical: drop(physical),
    orbitSolution: drop(orbitSolution),
  }
}

async function buildNamed() {
  process.stdout.write('\n[1/2] named.json — notable named asteroids and comets\n')

  const nameDefined = cdata({ AND: ['name|DF'] })
  const pools = []

  pools.push(['bright-named-asteroids', await sbdb('named-asteroids', {
    fields: NAMED_FIELDS, 'full-prec': '1', 'sb-kind': 'a',
    'sb-cdata': nameDefined, sort: 'H', limit: '560',
  })])

  pools.push(['bright-named-NEOs', await sbdb('named-neos', {
    fields: NAMED_FIELDS, 'full-prec': '1', 'sb-kind': 'a', 'sb-group': 'neo',
    'sb-cdata': nameDefined, sort: 'H', limit: '120',
  })])

  pools.push(['bright-named-TNO+Centaur', await sbdb('named-distant', {
    fields: NAMED_FIELDS, 'full-prec': '1', 'sb-class': 'TNO,CEN',
    'sb-cdata': nameDefined, sort: 'H', limit: '120',
  })])

  pools.push(['bright-named-Jupiter-Trojans', await sbdb('named-trojans', {
    fields: NAMED_FIELDS, 'full-prec': '1', 'sb-class': 'TJN',
    'sb-cdata': nameDefined, sort: 'H', limit: '60',
  })])

  pools.push(['numbered-periodic-comets', await sbdb('comets-numbered', {
    fields: NAMED_FIELDS, 'full-prec': '1', 'sb-kind': 'c', 'sb-ns': 'n', 'sb-xfrag': '1',
    sort: 'pdes', limit: '2000',
  })])

  pools.push(['brightest-unnumbered-comets', await sbdb('comets-unnumbered', {
    fields: NAMED_FIELDS, 'full-prec': '1', 'sb-kind': 'c', 'sb-ns': 'u', 'sb-xfrag': '1',
    'sb-cdata': cdata({ AND: ['M1|DF'] }), sort: 'M1', limit: '80',
  })])

  // Explicit must-haves. sb-cdata caps at 2048 chars, so chunk the OR list.
  let mustHaveRows = 0
  for (const [index, part] of chunk(MUST_HAVE_PDES, 36).entries()) {
    const json = await sbdb(`must-have-eq-${index}`, {
      fields: NAMED_FIELDS, 'full-prec': '1',
      'sb-cdata': cdata({ OR: part.map((p) => `pdes|EQ|${p}`) }), limit: '200',
    })
    mustHaveRows += json.data?.length ?? 0
    pools.push([`must-have-eq-${index}`, json])
  }
  for (const [index, part] of chunk(MUST_HAVE_PDES_REGEX, 10).entries()) {
    const json = await sbdb(`must-have-re-${index}`, {
      fields: NAMED_FIELDS, 'full-prec': '1',
      'sb-cdata': cdata({ OR: part.map((p) => `pdes|RE|${p}`) }), limit: '200',
    })
    mustHaveRows += json.data?.length ?? 0
    pools.push([`must-have-re-${index}`, json])
  }

  const bySpkid = new Map()
  const poolCounts = []
  for (const [label, json] of pools) {
    const list = rows(json)
    let added = 0
    for (const r of list) {
      if (!r.spkid) continue
      if (!bySpkid.has(r.spkid)) {
        bySpkid.set(r.spkid, r)
        added += 1
      }
    }
    poolCounts.push({ pool: label, returned: list.length, new: added })
  }

  const records = [...bySpkid.values()].map(buildNamedRecord)

  // Rank: comets and named asteroids are sorted inside their own family by brightness
  // (H for asteroids, M1 total magnitude for comets), families interleaved by a fixed
  // priority so no dynamical class is starved.
  const FAMILY_RANK = {
    MBA: 0, NEA: 1, TNO: 2, comet: 3, 'Jupiter Trojan': 4, Centaur: 5,
    'Mars-crosser': 6, 'interstellar/unbound': 7, other: 8,
  }
  records.sort((x, y) => {
    const fx = FAMILY_RANK[x.family] ?? 9
    const fy = FAMILY_RANK[y.family] ?? 9
    if (fx !== fy) return fx - fy
    const mx = x.physical.H ?? x.physical.M1 ?? 99
    const my = y.physical.H ?? y.physical.M1 ?? 99
    return mx - my
  })

  const familyTally = {}
  for (const r of records) familyTally[r.family] = (familyTally[r.family] ?? 0) + 1

  const withFullElements = records.filter(
    (r) => ['aAu', 'e', 'iDeg', 'omDeg', 'wDeg', 'maDeg', 'epochJdTdb']
      .every((k) => r.elements[k] !== undefined),
  ).length

  const epochs = new Set(records.map((r) => r.elements.epochJdTdb))

  const payload = {
    meta: {
      dataset: 'OmniAtlas notable small bodies',
      recordCount: records.length,
      source: API,
      sourceName: 'NASA/JPL Small-Body Database (SBDB) Query API',
      sourceVersion: 'SBDB Query API 1.0 (2021 August)',
      sourceDoc: API_DOC,
      retrieved: RETRIEVED,
      licence: LICENCE,
      attribution: ATTRIBUTION,
      frame: 'Heliocentric IAU76/J2000 ecliptic (SBDB "equinox" = J2000); elements are osculating.',
      epoch: 'per-object, elements.epochJdTdb (Julian Day, TDB) — epochs DIFFER between objects',
      distinctEpochs: epochs.size,
      units: {
        aAu: 'au', qAu: 'au', adAu: 'au', e: 'dimensionless',
        iDeg: 'deg', omDeg: 'deg (longitude of ascending node)',
        wDeg: 'deg (argument of perihelion)', maDeg: 'deg (mean anomaly at epoch)',
        tpJdTdb: 'Julian Day TDB (perihelion passage)', periodYr: 'Julian years',
        nDegPerDay: 'deg/day', diameterKm: 'km', rotPeriodH: 'hours (synodic)',
        moidAu: 'au', gmKm3S2: 'km^3/s^2', densityGCm3: 'g/cm^3',
      },
      selection: poolCounts,
      familyCounts: familyTally,
      note:
        'Null/absent physical parameters are omitted rather than zero-filled. ' +
        'Comets carry M1 (total magnitude) instead of H. ' +
        'Unbound objects (HYA/HYP/PAR) have e >= 1 and no meaningful a/ad.',
    },
    objects: records,
  }

  mkdirSync(OUT_DIR, { recursive: true })
  const path = join(OUT_DIR, 'named.json')
  writeFileSync(path, JSON.stringify(payload))

  return { path, records, poolCounts, familyTally, withFullElements, epochs, mustHaveRows }
}

/* ------------------------------------------------------------- belt.bin */

const BELT_H_LIMIT = 15.2
const BELT_CLASSES = 'IMB,MBA,OMB'
const PAGE = 20000

const BELT_FIELD_SPEC = [
  { key: 'a', attribute: 'sbA', units: 'au', description: 'semi-major axis' },
  { key: 'e', attribute: 'sbE', units: 'dimensionless', description: 'eccentricity' },
  { key: 'i', attribute: 'sbI', units: 'rad', description: 'inclination' },
  { key: 'om', attribute: 'sbOmega', units: 'rad', description: 'longitude of ascending node (Omega)' },
  { key: 'w', attribute: 'sbPeri', units: 'rad', description: 'argument of perihelion (omega)' },
  { key: 'ma', attribute: 'sbM0', units: 'rad', description: 'mean anomaly at the shared epoch' },
  { key: 'H', attribute: 'sbH', units: 'mag', description: 'absolute magnitude' },
]

async function buildBelt() {
  process.stdout.write('\n[2/2] belt.bin — main-belt orbital-element field\n')

  const constraint = cdata({ AND: [`H|LE|${BELT_H_LIMIT}`] })
  const head = await sbdb('belt-count', {
    'sb-class': BELT_CLASSES, 'sb-cdata': constraint,
  })
  const total = head.count
  process.stdout.write(`  SBDB reports ${total} bodies in ${BELT_CLASSES} with H <= ${BELT_H_LIMIT}\n`)

  const seen = new Set()
  const raw = []
  let epochTally = new Map()
  let rejected = 0

  for (let from = 0; from < total; from += PAGE) {
    const json = await sbdb(`belt-page-${from}`, {
      fields: 'spkid,a,e,i,om,w,ma,epoch,H',
      'full-prec': '1',
      'sb-class': BELT_CLASSES,
      'sb-cdata': constraint,
      sort: 'spkid',
      limit: String(PAGE),
      'limit-from': String(from),
    })
    for (const r of rows(json)) {
      if (seen.has(r.spkid)) continue
      seen.add(r.spkid)
      const rec = {
        a: num(r.a), e: num(r.e), i: num(r.i),
        om: num(r.om), w: num(r.w), ma: num(r.ma), H: num(r.H),
      }
      const epoch = num(r.epoch)
      if (Object.values(rec).some((v) => v === null) || epoch === null) {
        rejected += 1
        continue
      }
      rec.epoch = epoch
      epochTally.set(epoch, (epochTally.get(epoch) ?? 0) + 1)
      raw.push(rec)
    }
  }

  if (raw.length === 0) throw new Error('belt: SBDB returned no usable rows')

  // Brightest first, so a renderer can upload a prefix of the buffer as an LOD cut.
  raw.sort((x, y) => x.H - y.H || x.a - y.a)

  const epochs = [...epochTally.entries()].sort((p, q) => q[1] - p[1])
  const sharedEpoch = epochs[0][0]
  const sharedEpochShare = epochs[0][1] / raw.length

  // SBDB osculates almost every main-belt body at one common epoch, but a handful of
  // recently-updated solutions sit elsewhere. Rather than pay 4 bytes/record for a
  // per-object epoch, advance those few mean anomalies to the common epoch with the
  // same linear two-body step the vertex shader will use. GAUSS_K_DEG is the Gaussian
  // mean motion for a = 1 au, in deg/day.
  const GAUSS_K_DEG = 0.9856076686
  let rephased = 0
  let maxRephaseDeg = 0
  for (const r of raw) {
    if (r.epoch === sharedEpoch) continue
    const n = GAUSS_K_DEG / Math.pow(r.a, 1.5)
    const dM = n * (sharedEpoch - r.epoch)
    r.ma = ((r.ma + dM) % 360 + 360) % 360
    r.epoch = sharedEpoch
    rephased += 1
    maxRephaseDeg = Math.max(maxRephaseDeg, Math.abs(dM))
  }

  const n = raw.length
  const buffer = Buffer.alloc(n * BELT_FIELD_SPEC.length * 4)
  const fieldManifest = []
  let offset = 0
  for (const spec of BELT_FIELD_SPEC) {
    fieldManifest.push({
      name: spec.key,
      attribute: spec.attribute,
      dtype: 'float32',
      byteOffset: offset,
      byteLength: n * 4,
      itemSize: 1,
      count: n,
      units: spec.units,
      description: spec.description,
    })
    for (let k = 0; k < n; k += 1) {
      const v = raw[k][spec.key]
      buffer.writeFloatLE(spec.units === 'rad' ? v * DEG2RAD : v, offset + k * 4)
    }
    offset += n * 4
  }

  // ---- Kirkwood-gap sanity check -------------------------------------------
  const BIN = 0.01
  const LO = 1.7
  const HI = 4.6
  const bins = new Array(Math.round((HI - LO) / BIN)).fill(0)
  for (const r of raw) {
    const b = Math.floor((r.a - LO) / BIN)
    if (b >= 0 && b < bins.length) bins[b] += 1
  }
  const histogram = bins.map((count, k) => ({ aLo: Number((LO + k * BIN).toFixed(2)), count }))

  const KIRKWOOD = [
    { a: 2.065, label: '4:1' },
    { a: 2.502, label: '3:1' },
    { a: 2.825, label: '5:2' },
    { a: 2.958, label: '7:3' },
    { a: 3.279, label: '2:1' },
  ]
  const binAt = (a) => bins[Math.floor((a - LO) / BIN)] ?? 0
  const localMean = (a, halfWidthAu) => {
    const lo = Math.floor((a - halfWidthAu - LO) / BIN)
    const hi = Math.floor((a + halfWidthAu - LO) / BIN)
    let sum = 0
    let count = 0
    for (let k = lo; k <= hi; k += 1) {
      if (k < 0 || k >= bins.length) continue
      sum += bins[k]
      count += 1
    }
    return count ? sum / count : 0
  }
  const gapReport = KIRKWOOD.map((g) => {
    // Deepest bin within +-0.02 au of the nominal resonance.
    let deepest = Infinity
    let deepestA = g.a
    for (let d = -2; d <= 2; d += 1) {
      const a = Number((g.a + d * BIN).toFixed(3))
      const c = binAt(a)
      if (c < deepest) { deepest = c; deepestA = a }
    }
    const shoulder = (localMean(g.a - 0.10, 0.03) + localMean(g.a + 0.10, 0.03)) / 2
    return {
      resonance: g.label,
      aAu: g.a,
      deepestBinAu: deepestA,
      deepestBinCount: deepest,
      shoulderMeanCount: Number(shoulder.toFixed(1)),
      depletion: shoulder > 0 ? Number((1 - deepest / shoulder).toFixed(3)) : null,
      visible: shoulder > 0 && deepest < 0.6 * shoulder,
    }
  })

  const manifest = {
    dataset: 'OmniAtlas main-belt orbital-element field',
    file: 'belt.bin',
    recordCount: n,
    endianness: 'little',
    layout: 'struct-of-arrays (all of field A, then all of field B, ...)',
    uploadHint:
      'Each block is directly uploadable as a THREE.InstancedBufferAttribute ' +
      '(itemSize 1, normalized false) using the listed attribute name.',
    recordByteStride: BELT_FIELD_SPEC.length * 4,
    totalBytes: buffer.length,
    fieldOrder: BELT_FIELD_SPEC.map((s) => s.key),
    fields: fieldManifest,
    quantization: {
      applied: false,
      note: 'Raw IEEE-754 binary32. No scale/offset. Dequantization formula: value = f32 (identity).',
      angleConversion: 'SBDB serves i, om, w, ma in degrees; stored here in RADIANS (deg * PI/180).',
    },
    sortOrder: 'absolute magnitude H ascending (brightest first), tie-break semi-major axis',
    frame: 'Heliocentric IAU76/J2000 ecliptic (SBDB equinox = J2000); osculating two-body elements',
    epoch: {
      shared: true,
      julianDayTdb: sharedEpoch,
      isoApprox: jdToIso(sharedEpoch),
      timescale: 'TDB',
      distinctEpochsAsDelivered: epochTally.size,
      dominantEpochShareAsDelivered: Number(sharedEpochShare.toFixed(6)),
      recordsRephasedToSharedEpoch: rephased,
      maxMeanAnomalyShiftDeg: Number(maxRephaseDeg.toFixed(4)),
      note:
        epochTally.size === 1
          ? 'SBDB delivered one common epoch of osculation for every selected body, so it is stored once here rather than per object.'
          : `SBDB delivered ${epochTally.size} distinct epochs; ${(sharedEpochShare * 100).toFixed(3)}% of bodies already used the epoch above. ` +
            `The remaining ${rephased} record(s) had their mean anomaly advanced linearly to that epoch ` +
            '(M0 += n * dt, n = 0.9856076686 / a^1.5 deg/day, wrapped to [0,360)), so every record in belt.bin IS at the single epoch above. ' +
            `Largest shift applied: ${maxRephaseDeg.toFixed(3)} deg.`,
    },
    selection: {
      query: `${API}?sb-class=${BELT_CLASSES}&sb-cdata=${constraint}`,
      orbitClasses: BELT_CLASSES.split(','),
      magnitudeLimit: `H <= ${BELT_H_LIMIT}`,
      sbdbReportedCount: total,
      rowsRejectedForNullElements: rejected,
    },
    source: API,
    sourceName: 'NASA/JPL Small-Body Database (SBDB) Query API',
    sourceVersion: 'SBDB Query API 1.0 (2021 August)',
    sourceDoc: API_DOC,
    retrieved: RETRIEVED,
    licence: LICENCE,
    attribution: ATTRIBUTION,
    provenance: 'MEASURED',
    kirkwoodGaps: gapReport,
    semiMajorAxisHistogram: {
      binWidthAu: BIN,
      rangeAu: [LO, HI],
      bins: histogram.map((h) => h.count),
      binLeftEdgesAu: histogram.map((h) => h.aLo),
    },
  }

  mkdirSync(OUT_DIR, { recursive: true })
  const binPath = join(OUT_DIR, 'belt.bin')
  const manifestPath = join(OUT_DIR, 'belt.manifest.json')
  writeFileSync(binPath, buffer)
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  return { binPath, manifestPath, n, bins, LO, BIN, gapReport, manifest, rejected, epochTally }
}

function jdToIso(jd) {
  const ms = (jd - 2440587.5) * 86400000
  return new Date(ms).toISOString().slice(0, 19) + 'Z'
}

/* --------------------------------------------------------------- reporting */

function printHistogram(bins, LO, BIN) {
  // Aggregate 0.01 au bins into 0.02 au rows so the whole belt fits one screen.
  const GROUP = 2
  const rowsOut = []
  for (let k = 0; k < bins.length; k += GROUP) {
    let count = 0
    for (let j = k; j < Math.min(k + GROUP, bins.length); j += 1) count += bins[j]
    rowsOut.push({ a: LO + k * BIN, count })
  }
  const max = Math.max(...rowsOut.map((r) => r.count), 1)
  const WIDTH = 68
  const ROW = GROUP * BIN
  // Mark the row whose [left, left+ROW) interval actually contains the resonance.
  const GAPS = [[2.065, '4:1'], [2.502, '3:1'], [2.825, '5:2'], [2.958, '7:3'], [3.279, '2:1']]
  process.stdout.write('\n  Semi-major-axis histogram (0.02 au bins, Kirkwood gaps marked):\n')
  for (const r of rowsOut) {
    const a = Number(r.a.toFixed(2))
    const bar = '#'.repeat(Math.round((r.count / max) * WIDTH))
    let mark = ''
    for (const [ga, label] of GAPS) {
      if (ga >= r.a - 1e-9 && ga < r.a + ROW - 1e-9) mark = `  <== ${label} Kirkwood gap (a=${ga} au)`
    }
    process.stdout.write(
      `   ${a.toFixed(2)} au |${bar.padEnd(WIDTH)}| ${String(r.count).padStart(5)}${mark}\n`,
    )
  }
}

/* -------------------------------------------------------------------- main */

const t0 = Date.now()
process.stdout.write('build-small-bodies: JPL SBDB -> public/data/smallbodies/\n')
mkdirSync(CACHE_DIR, { recursive: true })

const named = await buildNamed()
const belt = await buildBelt()

const licenseText = `# Data licence — public/data/smallbodies/

## Source

NASA/JPL Small-Body Database (SBDB) Query API
${API}
API documentation: ${API_DOC}
API version: SBDB Query API 1.0 (2021 August)
Retrieved: ${RETRIEVED}

Files produced from this source:

- \`named.json\` — ${named.records.length} notable named asteroids and comets with full osculating elements
- \`belt.bin\` + \`belt.manifest.json\` — ${belt.n} main-belt bodies (H <= ${BELT_H_LIMIT}), Float32 struct-of-arrays

## Licence

${LICENCE}

Data produced by the Jet Propulsion Laboratory, California Institute of Technology,
under contract with NASA, are works of the U.S. Government and are not subject to
copyright protection in the United States. JPL requests courtesy attribution.

See JPL's image/data use policy: https://www.jpl.nasa.gov/jpl-image-use-policy

## Exact attribution string the UI must display

> ${ATTRIBUTION}

Short form, acceptable where space is constrained:

> Small-body data: NASA/JPL-Caltech SBDB

## Notes

- Elements are **osculating** two-body elements in the heliocentric IAU76/J2000
  ecliptic frame (SBDB \`equinox\` = J2000). They are valid near their epoch of
  osculation and drift from the true trajectory away from it.
- \`belt.bin\` shares one epoch for all records; it is in \`belt.manifest.json\`
  under \`epoch.julianDayTdb\`.
- \`named.json\` carries a **per-object** epoch, because comets and NEOs are
  osculated at their own solution epochs.
- Nothing in this directory is fetched at runtime; the SBDB endpoint sends no
  \`Access-Control-Allow-Origin\` header and cannot be read from a browser.
`

const licensePath = join(OUT_DIR, 'LICENSE.md')
writeFileSync(licensePath, licenseText)

printHistogram(belt.bins, belt.LO, belt.BIN)

process.stdout.write('\n  Kirkwood-gap check:\n')
for (const g of belt.gapReport) {
  process.stdout.write(
    `   ${g.resonance.padEnd(4)} a=${g.aAu.toFixed(3)} au  deepest bin ${String(g.deepestBinCount).padStart(4)} ` +
      `vs shoulder ${String(g.shoulderMeanCount).padStart(6)}  depletion ${((g.depletion ?? 0) * 100).toFixed(1)}%  ` +
      `${g.visible ? 'GAP VISIBLE' : '*** NOT VISIBLE ***'}\n`,
  )
}
if (belt.gapReport.some((g) => !g.visible)) {
  process.stderr.write('\n  WARNING: at least one Kirkwood gap is not resolved — check the query.\n')
}

const size = (p) => statSync(p).size
const fmt = (b) => `${b.toLocaleString()} B (${(b / 1024 / 1024).toFixed(2)} MiB)`

process.stdout.write('\n  Named-object pools:\n')
for (const p of named.poolCounts) {
  process.stdout.write(`   ${p.pool.padEnd(30)} returned ${String(p.returned).padStart(5)}  new ${String(p.new).padStart(5)}\n`)
}
process.stdout.write('\n  Named-object families:\n')
for (const [k, v] of Object.entries(named.familyTally).sort((a, b) => b[1] - a[1])) {
  process.stdout.write(`   ${k.padEnd(22)} ${String(v).padStart(5)}\n`)
}

process.stdout.write('\n=== Summary ===\n')
process.stdout.write(`  named.json          ${String(named.records.length).padStart(7)} records   ${fmt(size(named.path))}\n`)
process.stdout.write(`    full 6-element sets: ${named.withFullElements}/${named.records.length}; distinct epochs: ${named.epochs.size}\n`)
process.stdout.write(`  belt.bin            ${String(belt.n).padStart(7)} records   ${fmt(size(belt.binPath))}\n`)
process.stdout.write(`    ${BELT_FIELD_SPEC.length} Float32 blocks x ${belt.n} = ${BELT_FIELD_SPEC.length * 4} B/record; rejected ${belt.rejected} null rows\n`)
process.stdout.write(
  `    shared epoch JD ${belt.manifest.epoch.julianDayTdb} (${belt.manifest.epoch.isoApprox}); ` +
    `SBDB delivered ${belt.epochTally.size} distinct epoch(s), ` +
    `${belt.manifest.epoch.recordsRephasedToSharedEpoch} record(s) re-phased ` +
    `(max shift ${belt.manifest.epoch.maxMeanAnomalyShiftDeg} deg)\n`,
)
process.stdout.write(`  belt.manifest.json                    ${fmt(size(belt.manifestPath))}\n`)
process.stdout.write(`  LICENSE.md                            ${fmt(size(licensePath))}\n`)
process.stdout.write(`\n  Output directory: ${OUT_DIR}\n`)
process.stdout.write(`  Attribution required: ${ATTRIBUTION}\n`)
process.stdout.write(`  Done in ${((Date.now() - t0) / 1000).toFixed(1)} s\n`)
