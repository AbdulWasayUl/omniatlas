// build-universe.mjs — extragalactic universe & large-scale structure ETL.
//
//   node scripts/build-universe.mjs [--refresh]
//
// Pulls three VizieR catalogues plus a frozen cosmology block into
// public/data/universe/:
//
//   ungc.json      Updated Nearby Galaxy Catalog (Karachentsev+ 2013) — Local Volume
//   cf4.bin/.json  Cosmicflows-4 group catalogue (Tully+ 2023) — supergalactic frame
//   2mrs.bin/.json 2MASS Redshift Survey (Huchra+ 2012) — all-sky redshift space
//   cosmology.json Planck 2018 VI parameters, frozen
//
// Every record declares a DISTANCE KIND. Nothing here renders without one.
// Binaries are little-endian, tightly packed Struct-of-Arrays (all of field A,
// then all of field B, ...). Each .bin has a sibling .json manifest.
//
// Sources are downloaded once into .cache/universe/ (gitignored) so reruns are
// offline-safe. Pass --refresh to force re-download.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE_DIR = join(REPO_ROOT, '.cache', 'universe')
const OUT_DIR = join(REPO_ROOT, 'public', 'data', 'universe')

const RETRIEVED = '2026-10-14'
const REFRESH = process.argv.includes('--refresh')

const TAP_ENDPOINT = 'https://tapvizier.cds.unistra.fr/TAPVizieR/tap/sync'

const CDS_ACKNOWLEDGEMENT =
  'This research has made use of the VizieR catalogue access tool, CDS, Strasbourg, ' +
  'France (DOI: 10.26093/cds/vizier). The original description of the VizieR service ' +
  'was published in A&AS 143, 23 (2000).'
const CDS_LICENCE = 'CC BY 4.0 (CDS VizieR service) — underlying catalogue (c) the cited authors / AAS'

// ---------------------------------------------------------------------------
// download + cache
// ---------------------------------------------------------------------------

function tapUrl(adql) {
  const params = new URLSearchParams({
    request: 'doQuery',
    lang: 'adql',
    format: 'tsv',
    MAXREC: '1000000',
    query: adql,
  })
  return `${TAP_ENDPOINT}?${params.toString()}`
}

async function fetchCached(cacheName, url) {
  const path = join(CACHE_DIR, cacheName)
  if (!REFRESH && existsSync(path) && statSync(path).size > 0) {
    process.stdout.write(`  cache hit  ${cacheName} (${statSync(path).size.toLocaleString()} B)\n`)
    return readFileSync(path, 'utf8')
  }
  mkdirSync(CACHE_DIR, { recursive: true })
  process.stdout.write(`  downloading ${cacheName} ...\n`)

  let lastError
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { Accept: 'text/tab-separated-values' } })
      const body = await response.text()
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 400)}`)
      if (body.includes('QUERY_STATUS" value="ERROR"')) {
        throw new Error(`VizieR TAP error: ${body.slice(0, 600)}`)
      }
      if (body.trim().length === 0) throw new Error('empty response body')
      writeFileSync(path, body)
      process.stdout.write(`  saved       ${cacheName} (${body.length.toLocaleString()} B)\n`)
      return body
    } catch (error) {
      lastError = error
      const waitMs = attempt * 5000
      process.stdout.write(`  attempt ${attempt} failed (${error.message.slice(0, 160)}); retrying in ${waitMs} ms\n`)
      await new Promise((r) => setTimeout(r, waitMs))
    }
  }
  throw new Error(`Could not retrieve ${cacheName} after 4 attempts: ${lastError?.message}`)
}

// VizieR TAP emits TSV with string columns wrapped in double quotes.
function parseTsv(text) {
  const lines = text.split('\n').filter((line) => line.length > 0 && line !== '\r')
  const unquote = (raw) => {
    const v = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
      return v.slice(1, -1).replaceAll('""', '"').trim()
    }
    return v.trim()
  }
  const header = lines[0].split('\t').map(unquote)
  const rows = []
  for (let i = 1; i < lines.length; i += 1) {
    const cells = lines[i].split('\t')
    if (cells.length < header.length) continue
    const row = {}
    for (let c = 0; c < header.length; c += 1) row[header[c]] = unquote(cells[c])
    rows.push(row)
  }
  return rows
}

const num = (v) => {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

// ---------------------------------------------------------------------------
// quantization helpers (dequantization formulas are repeated in each manifest)
// ---------------------------------------------------------------------------

const LON_SCALE = 360 / 65536 // uint16 -> degrees
const LAT_SCALE = 90 / 32767 // int16  -> degrees

const encodeLon = (deg) => {
  let d = deg % 360
  if (d < 0) d += 360
  return Math.round(d / LON_SCALE) & 0xffff
}
const encodeLat = (deg) => Math.max(-32767, Math.min(32767, Math.round(deg / LAT_SCALE)))
const clampU16 = (v) => Math.max(0, Math.min(65535, Math.round(v)))
const clampI16 = (v) => Math.max(-32768, Math.min(32767, Math.round(v)))

// ---------------------------------------------------------------------------
// 1. UNGC — Updated Nearby Galaxy Catalog
// ---------------------------------------------------------------------------

// VizieR f_Dist codes (note G1 of J/AJ/145/101) -> explicit method + coarse kind.
// The coarse kind is the contract the renderer enforces: every distance declares
// what sort of distance it is.
const UNGC_METHOD = {
  TRGB: ['tip_of_the_red_giant_branch', 'trgb_cepheid'],
  Cep: ['cepheid_period_luminosity', 'trgb_cepheid'],
  RR: ['rr_lyrae', 'luminosity_distance'],
  HB: ['horizontal_branch', 'luminosity_distance'],
  CMD: ['colour_magnitude_diagram', 'luminosity_distance'],
  SBF: ['surface_brightness_fluctuation', 'luminosity_distance'],
  PNLF: ['planetary_nebula_luminosity_function', 'luminosity_distance'],
  SN: ['supernova', 'luminosity_distance'],
  BS: ['brightest_stars', 'luminosity_distance'],
  TF: ['tully_fisher', 'luminosity_distance'],
  FP: ['fundamental_plane', 'luminosity_distance'],
  geom: ['geometric_maser_or_eclipsing_binary', 'geometric'],
  mem: ['group_membership', 'inherited'],
  txt: ['literature_estimate', 'luminosity_distance'],
  h: ['hubble_flow_from_velocity', 'redshift_space'],
  "h'": ['hubble_flow_from_corrected_velocity', 'redshift_space'],
}

async function buildUngc() {
  process.stdout.write('\n[1/4] UNGC — J/AJ/145/101/catalog\n')
  const adql =
    'SELECT "Name","RAJ2000","DEJ2000","Dist","f_Dist","TT","Mcl","BMag","Kmag","a26","A26",' +
    '"b/a","i","HRV","Vlg","W50","vAmp","KLum","M26","MHI","Ti1","Ti5","MD","SimbadName","NEDname" ' +
    'FROM "J/AJ/145/101/catalog"'
  const rows = parseTsv(await fetchCached('ungc.tsv', tapUrl(adql)))

  const galaxies = []
  const kindCounts = {}
  const methodCounts = {}
  let maxDist = 0

  for (const r of rows) {
    const dist = num(r.Dist)
    const ra = num(r.RAJ2000)
    const dec = num(r.DEJ2000)
    if (dist === null || ra === null || dec === null) continue

    const code = (r.f_Dist ?? '').trim()
    const mapped = UNGC_METHOD[code] ?? ['unknown', 'undeclared']
    const [method, kind] = mapped
    kindCounts[kind] = (kindCounts[kind] ?? 0) + 1
    methodCounts[code || '(blank)'] = (methodCounts[code || '(blank)'] ?? 0) + 1
    if (dist > maxDist) maxDist = dist

    const g = {
      name: r.Name,
      ra: Math.round(ra * 1e5) / 1e5,
      dec: Math.round(dec * 1e5) / 1e5,
      distMpc: dist,
      distanceKind: kind,
      distanceMethod: method,
    }
    const put = (key, value, digits) => {
      if (value === null || value === undefined || value === '') return
      g[key] = digits === undefined ? value : Math.round(value * 10 ** digits) / 10 ** digits
    }
    put('tType', num(r.TT))
    put('dwarfMorph', r.Mcl || null)
    put('absBMag', num(r.BMag), 2)
    put('kMag', num(r.Kmag), 2)
    put('a26ArcMin', num(r.a26), 2)
    put('a26Kpc', num(r.A26), 2)
    put('axisRatio', num(r['b/a']), 3)
    put('inclinationDeg', num(r.i))
    put('vHelioKmS', num(r.HRV))
    put('vLgKmS', num(r.Vlg))
    put('hiWidth50KmS', num(r.W50))
    put('vRotKmS', num(r.vAmp))
    put('logKLumSun', num(r.KLum), 2)
    put('logM26Sun', num(r.M26), 2)
    put('logMhiSun', num(r.MHI), 2)
    put('tidalIndex1', num(r.Ti1), 2)
    put('tidalIndex5', num(r.Ti5), 2)
    put('mainDisturber', r.MD || null)
    // Keep cross-identifiers only where they add a searchable alias the Name column lacks.
    const canon = (s) => (s ?? '').toLowerCase().replaceAll(/[^a-z0-9]/g, '')
    const aliases = []
    for (const alt of [r.SimbadName, r.NEDname]) {
      if (alt && canon(alt) !== canon(r.Name) && !aliases.some((a) => canon(a) === canon(alt))) aliases.push(alt)
    }
    if (aliases.length > 0) g.aliases = aliases
    galaxies.push(g)
  }

  galaxies.sort((a, b) => a.distMpc - b.distMpc)

  const payload = {
    meta: {
      dataset: 'UNGC — Updated Nearby Galaxy Catalog (Local Volume)',
      recordCount: galaxies.length,
      kind: 'MEASURED',
      coordinateFrame: 'ICRS equatorial (J2000); ra/dec in decimal degrees',
      epoch: 'J2000.0',
      units: { ra: 'deg', dec: 'deg', distMpc: 'Mpc', velocities: 'km/s', magnitudes: 'mag', a26ArcMin: 'arcmin', a26Kpc: 'kpc' },
      distanceKinds: kindCounts,
      distanceKindLegend: {
        trgb_cepheid: 'Tip of the RGB or Cepheid period-luminosity — the best rungs of the distance ladder.',
        luminosity_distance: 'Photometric / standard-candle luminosity distance from a secondary indicator.',
        geometric: 'Geometric (maser or detached eclipsing binary) — no ladder assumed.',
        inherited: 'Adopted from the distance of the host group, not measured for this galaxy.',
        redshift_space: 'Derived from recession velocity via a Hubble flow model. NOT a measured distance.',
      },
      distanceMethodCodeCounts: methodCounts,
      maxDistanceMpc: maxDist,
      note:
        'The published VizieR table J/AJ/145/101/catalog holds 869 galaxies, not the ~1400 ' +
        'now listed by the live Local Volume database (www.sao.ru/lv/lvgdb). This file is the ' +
        'frozen, citable 2013 catalogue. cartesian position = ra/dec/distMpc; no cosmology applied.',
      sourceUrl: 'https://vizier.cds.unistra.fr/viz-bin/VizieR-3?-source=J/AJ/145/101/catalog',
      vizierCatalogue: 'J/AJ/145/101',
      vizierTable: 'J/AJ/145/101/catalog',
      sourceVersion: 'Karachentsev, Makarov & Kaisina 2013, AJ 145, 101 (2013AJ....145..101K)',
      retrieved: RETRIEVED,
      licence: CDS_LICENCE,
      attribution:
        'Updated Nearby Galaxy Catalog — Karachentsev, Makarov & Kaisina (2013), AJ 145, 101. ' +
        'Retrieved from VizieR (CDS, Strasbourg).',
    },
    galaxies,
  }

  const json = JSON.stringify(payload)
  const path = join(OUT_DIR, 'ungc.json')
  writeFileSync(path, json)
  return { path, bytes: Buffer.byteLength(json), rows: galaxies.length, kindCounts }
}

// ---------------------------------------------------------------------------
// 2. Cosmicflows-4 group catalogue -> cf4.bin (20 B/record SoA)
// ---------------------------------------------------------------------------

async function buildCf4() {
  process.stdout.write('\n[2/4] Cosmicflows-4 groups — J/ApJ/944/94/groups\n')
  const adql =
    'SELECT "1PGC","Ngal","DMzp","e_DMzp","DMav","e_DMav","Dist","SGL","SGB","Vcmb","o_DMcal" ' +
    'FROM "J/ApJ/944/94/groups"'
  const rows = parseTsv(await fetchCached('cf4-groups.tsv', tapUrl(adql)))

  const kept = []
  for (const r of rows) {
    const dist = num(r.Dist)
    const sgl = num(r.SGL)
    const sgb = num(r.SGB)
    if (dist === null || dist <= 0 || sgl === null || sgb === null) continue
    kept.push({
      pgc: num(r['1PGC']) ?? 0,
      ngal: num(r.Ngal) ?? 1,
      dist,
      eDMav: num(r.e_DMav) ?? num(r.e_DMzp) ?? 0,
      sgl,
      sgb,
      vcmb: num(r.Vcmb) ?? 0,
      nCal: num(r.o_DMcal) ?? 0,
    })
  }
  kept.sort((a, b) => a.dist - b.dist)

  const n = kept.length
  const RECORD_BYTES = 20
  const buf = Buffer.allocUnsafe(n * RECORD_BYTES)
  const off = {
    distMpc: 0,
    pgc: 4 * n,
    sgl: 8 * n,
    sgb: 10 * n,
    eDMav: 12 * n,
    vcmb: 14 * n,
    ngal: 16 * n,
    distanceKind: 18 * n,
    nCalibrators: 19 * n,
  }

  let calibratorAnchored = 0
  let minDist = Infinity
  let maxDist = 0
  let maxFracErr = 0
  let sumFracErr = 0

  for (let i = 0; i < n; i += 1) {
    const g = kept[i]
    buf.writeFloatLE(g.dist, off.distMpc + i * 4)
    buf.writeUInt32LE(g.pgc >>> 0, off.pgc + i * 4)
    buf.writeUInt16LE(encodeLon(g.sgl), off.sgl + i * 2)
    buf.writeInt16LE(encodeLat(g.sgb), off.sgb + i * 2)
    buf.writeUInt16LE(clampU16(g.eDMav / 1e-4), off.eDMav + i * 2)
    buf.writeInt16LE(clampI16(g.vcmb), off.vcmb + i * 2)
    buf.writeUInt16LE(clampU16(g.ngal), off.ngal + i * 2)
    const kind = g.nCal > 0 ? 1 : 0
    if (kind === 1) calibratorAnchored += 1
    buf.writeUInt8(kind, off.distanceKind + i)
    buf.writeUInt8(Math.max(0, Math.min(255, g.nCal)), off.nCalibrators + i)

    // fractional line-of-sight distance error implied by the distance modulus error
    const frac = 10 ** (g.eDMav / 5) - 1
    sumFracErr += frac
    if (frac > maxFracErr) maxFracErr = frac
    if (g.dist < minDist) minDist = g.dist
    if (g.dist > maxDist) maxDist = g.dist
  }

  const binPath = join(OUT_DIR, 'cf4.bin')
  writeFileSync(binPath, buf)

  const manifest = {
    dataset: 'Cosmicflows-4 group catalogue — redshift-independent distances of galaxy groups',
    file: 'cf4.bin',
    kind: 'MEASURED',
    recordCount: n,
    recordBytes: RECORD_BYTES,
    totalBytes: buf.length,
    byteOrder: 'little-endian',
    layout: 'struct-of-arrays (all of field 0, then all of field 1, ...)',
    coordinateFrame:
      'de Vaucouleurs supergalactic (SGL/SGB), as published in the table — no frame conversion applied. ' +
      'Cartesian: X = d cos(SGB) cos(SGL), Y = d cos(SGB) sin(SGL), Z = d sin(SGB).',
    epoch: 'J2000.0 (equatorial coordinates the supergalactic frame is defined against)',
    distanceKind: {
      enumField: 'distanceKind',
      values: {
        0: 'luminosity_distance — weighted-average distance modulus DMzp from secondary indicators (TF, FP, SBF, SNIa, SNII)',
        1: 'trgb_cepheid — group contains >=1 TRGB / Cepheid / maser calibrator (o_DMcal > 0); DMzp is anchored on it',
      },
      counts: { 0: n - calibratorAnchored, 1: calibratorAnchored },
      note:
        'All distances are luminosity distances derived from distance moduli, REDSHIFT-INDEPENDENT. ' +
        'They are not comoving distances and are not redshift-space positions, so this catalogue has ' +
        'no Fingers-of-God. CF4 is internally calibrated to H0 = 74.6 km/s/Mpc; see cosmology.json ' +
        'for the H0 tension note before mixing these distances with Planck-based comoving distances.',
    },
    fields: [
      {
        name: 'distMpc',
        dtype: 'float32',
        byteOffset: off.distMpc,
        byteLength: 4 * n,
        unit: 'Mpc',
        description: 'Luminosity distance corresponding to DMzp (VizieR column Dist).',
        quantization: null,
        dequantize: 'value',
      },
      {
        name: 'pgc',
        dtype: 'uint32',
        byteOffset: off.pgc,
        byteLength: 4 * n,
        unit: null,
        description: 'PGC id of the dominant galaxy in the group (VizieR column 1PGC). Stable identifier.',
        quantization: null,
        dequantize: 'value',
      },
      {
        name: 'sgl',
        dtype: 'uint16',
        byteOffset: off.sgl,
        byteLength: 2 * n,
        unit: 'deg',
        description: 'Supergalactic longitude, 0..360.',
        quantization: { scale: LON_SCALE, offset: 0, maxErrorDeg: LON_SCALE / 2 },
        dequantize: `deg = value * ${LON_SCALE}`,
      },
      {
        name: 'sgb',
        dtype: 'int16',
        byteOffset: off.sgb,
        byteLength: 2 * n,
        unit: 'deg',
        description: 'Supergalactic latitude, -90..+90.',
        quantization: { scale: LAT_SCALE, offset: 0, maxErrorDeg: LAT_SCALE / 2 },
        dequantize: `deg = value * ${LAT_SCALE}`,
      },
      {
        name: 'eDMav',
        dtype: 'uint16',
        byteOffset: off.eDMav,
        byteLength: 2 * n,
        unit: 'mag',
        description:
          'Uncertainty in the average distance modulus (VizieR column e_DMav). This is the ' +
          'line-of-sight distance error that dominates; the renderer elongates each group ' +
          'radially by it instead of drawing a point. VALUE 0 MEANS NOT AVAILABLE, not ' +
          '"zero error": 228 records carry 0.0 in the source table and must be drawn with a ' +
          'fallback extent (or flagged), never as an exactly-known distance.',
        quantization: { scale: 1e-4, offset: 0 },
        dequantize:
          'mag = value * 1e-4 ; fractional radial half-extent = 10**(mag/5) - 1 ; ' +
          'radial extent in Mpc = distMpc * (10**(mag/5) - 1)',
      },
      {
        name: 'vcmb',
        dtype: 'int16',
        byteOffset: off.vcmb,
        byteLength: 2 * n,
        unit: 'km/s',
        description: 'Systemic velocity in the CMB frame (VizieR column Vcmb). Independent of distMpc.',
        quantization: null,
        dequantize: 'value',
      },
      {
        name: 'ngal',
        dtype: 'uint16',
        byteOffset: off.ngal,
        byteLength: 2 * n,
        unit: null,
        description: 'Number of member galaxies in the group. 1 = an ungrouped single galaxy.',
        quantization: null,
        dequantize: 'value',
      },
      {
        name: 'distanceKind',
        dtype: 'uint8',
        byteOffset: off.distanceKind,
        byteLength: n,
        unit: null,
        description: 'Distance-kind enum; see distanceKind.values.',
        quantization: null,
        dequantize: 'value',
      },
      {
        name: 'nCalibrators',
        dtype: 'uint8',
        byteOffset: off.nCalibrators,
        byteLength: n,
        unit: null,
        description: 'Number of member galaxies with calibrator-quality distances (o_DMcal), clamped to 255.',
        quantization: null,
        dequantize: 'value',
      },
    ],
    statistics: {
      distanceMpc: { min: Math.round(minDist * 100) / 100, max: Math.round(maxDist * 100) / 100 },
      fractionalDistanceError: {
        mean: Math.round((sumFracErr / n) * 1e4) / 1e4,
        max: Math.round(maxFracErr * 1e4) / 1e4,
        note: 'Derived from e_DMav; this is why groups must be drawn radially elongated.',
      },
      groupsWithMoreThanOneMember: kept.filter((g) => g.ngal > 1).length,
    },
    knownSourceDefects: {
      note:
        'These are defects in the upstream VizieR table, reproduced here verbatim because this ' +
        'build does not silently correct its source. Confirmed against VizieR TAP directly.',
      virgoClusterSglSgb: {
        affectedRecords: [
          { pgc: 41220, galaxy: 'NGC 4472 / M49', sourceSgl: 148.144, sourceSgb: 16.9072 },
          { pgc: 41361, galaxy: 'NGC 4486 / M87', sourceSgl: 283.9352, sourceSgb: 74.5198 },
        ],
        problem:
          'Both records are Virgo Cluster galaxies (Vcmb = 1479 km/s; PGC 41220 is the ' +
          'catalogue richest nearby group at Ngal = 164, Dist = 16.2 Mpc). The Virgo Cluster ' +
          'true supergalactic position is SGL 102.9, SGB -2.3. The SGL/SGB values above place ' +
          'PGC 41220 about 47 deg away and PGC 41361 about 110 deg away. PGC 41361 SGL/SGB ' +
          'equal M87 GALACTIC coordinates (l = 283.78, b = 74.49) to 0.16 deg, so galactic ' +
          'coordinates appear to have been written into the supergalactic columns for that row.',
        evidence:
          '2MRS galaxy surface density within 2 deg: 4.9x the sky average at the true Virgo ' +
          'position, but 0.8x and 0.2x at these two source positions, i.e. empty sky.',
        rendererGuidance:
          'Do NOT render these two records at their stored SGL/SGB. Either drop them, or ' +
          'override to SGL 102.9 / SGB -2.3 and label the override. Distance, Vcmb and Ngal ' +
          'for PGC 41220 are correct and match the Virgo Cluster.',
      },
    },
    sourceUrl: 'https://vizier.cds.unistra.fr/viz-bin/VizieR-3?-source=J/ApJ/944/94/groups',
    vizierCatalogue: 'J/ApJ/944/94',
    vizierTable: 'J/ApJ/944/94/groups (= published tables 3 and 4 merged by CDS)',
    sourceVersion: 'Tully, Kourkchi, Courtois et al. 2023, ApJ 944, 94 (2023ApJ...944...94T)',
    retrieved: RETRIEVED,
    licence: CDS_LICENCE,
    attribution:
      'Cosmicflows-4 — Tully, Kourkchi, Courtois et al. (2023), ApJ 944, 94. ' +
      'Retrieved from VizieR (CDS, Strasbourg).',
    sha256: sha256(buf),
  }

  const manifestPath = join(OUT_DIR, 'cf4.json')
  const manifestJson = JSON.stringify(manifest, null, 2)
  writeFileSync(manifestPath, manifestJson)

  return {
    binPath,
    binBytes: buf.length,
    manifestPath,
    manifestBytes: Buffer.byteLength(manifestJson),
    rows: n,
    calibratorAnchored,
  }
}

// ---------------------------------------------------------------------------
// 3. 2MRS -> 2mrs.bin (14 B/record SoA) + measured zone-of-avoidance limits
// ---------------------------------------------------------------------------

// Published 2MRS selection (Huchra et al. 2012, ApJS 199, 26, Sect. 2):
// Ks <= 11.75 and |b| > 5 deg for 30 < l < 330, |b| > 8 deg otherwise.
const formalZoaLimitDeg = (lDeg) => {
  const l = ((lDeg % 360) + 360) % 360
  return l > 30 && l < 330 ? 5 : 8
}

function measureZoneOfAvoidance(records) {
  // Empirical coverage limit per 10-degree longitude bin: the |b| below which the
  // surface density of catalogued galaxies collapses relative to that bin's own
  // density in the well-covered band 15 deg < |b| < 45 deg.
  const LON_BINS = 36
  const LAT_STEP = 1 // deg
  const bins = Array.from({ length: LON_BINS }, () => new Float64Array(90))
  const reference = new Float64Array(LON_BINS)

  for (const r of records) {
    const l = ((r.glon % 360) + 360) % 360
    const bi = Math.min(LON_BINS - 1, Math.floor(l / (360 / LON_BINS)))
    const ab = Math.min(89.999, Math.abs(r.glat))
    bins[bi][Math.floor(ab / LAT_STEP)] += 1
  }

  // solid angle of a |b| ring of width LAT_STEP within one longitude bin
  const ringArea = (bLow, bHigh) =>
    (2 * Math.PI / LON_BINS) * 2 * (Math.sin((bHigh * Math.PI) / 180) - Math.sin((bLow * Math.PI) / 180))

  for (let bi = 0; bi < LON_BINS; bi += 1) {
    let count = 0
    let area = 0
    for (let k = 15; k < 45; k += 1) {
      count += bins[bi][k]
      area += ringArea(k, k + 1)
    }
    reference[bi] = area > 0 ? count / area : 0
  }

  const THRESHOLD = 0.25
  const perLongitude = []
  let maxLimit = 0
  let sumSinLimit = 0

  for (let bi = 0; bi < LON_BINS; bi += 1) {
    let limit = 0
    for (let k = 0; k < 20; k += 1) {
      const density = bins[bi][k] / ringArea(k, k + 1)
      if (reference[bi] > 0 && density < THRESHOLD * reference[bi]) limit = k + 1
      else break
    }
    perLongitude.push({
      lCenterDeg: bi * 10 + 5,
      measuredLimitAbsBDeg: limit,
      formalLimitAbsBDeg: formalZoaLimitDeg(bi * 10 + 5),
      galaxiesBelowMeasuredLimit: Array.from({ length: limit }, (_, k) => bins[bi][k]).reduce((a, b) => a + b, 0),
    })
    if (limit > maxLimit) maxLimit = limit
    sumSinLimit += Math.sin((limit * Math.PI) / 180)
  }

  const belowFormal = records.filter((r) => Math.abs(r.glat) < formalZoaLimitDeg(r.glon)).length
  const below5 = records.filter((r) => Math.abs(r.glat) < 5).length
  const below8 = records.filter((r) => Math.abs(r.glat) < 8).length

  return {
    description:
      'The Milky Way blocks the view of the extragalactic sky near the galactic plane. 2MRS has ' +
      'no coverage there. Render this as an explicit, labelled wedge — "obscured by the Milky Way ' +
      '- no survey coverage" - never as empty space, which would read as a real void.',
    formalSelection: {
      source: 'Huchra et al. 2012, ApJS 199, 26, Sect. 2 (survey definition)',
      rule: '|b| > 5 deg for 30 deg < l < 330 deg; |b| > 8 deg for l < 30 deg or l > 330 deg; Ks <= 11.75',
      wedgeHalfOpeningDeg: { lBetween30And330: 5, lElse: 8 },
      skyFractionObscured: Math.round(((330 - 30) / 360 * Math.sin((5 * Math.PI) / 180) + (60 / 360) * Math.sin((8 * Math.PI) / 180)) * 1e5) / 1e5,
    },
    measured: {
      method:
        'Galaxy surface density computed in 36 longitude bins x 1 deg |b| rings (solid-angle ' +
        'normalised). The coverage limit for a bin is the largest |b| for which every ring below ' +
        'it has density < 25% of that bin\'s own mean density over 15 deg < |b| < 45 deg.',
      maxLimitAbsBDeg: maxLimit,
      meanSkyFractionObscured: Math.round((sumSinLimit / LON_BINS) * 1e5) / 1e5,
      perLongitudeBin: perLongitude,
    },
    actualGalaxyCountsInsideTheGap: {
      belowFormalLimit: belowFormal,
      absBLessThan5Deg: below5,
      absBLessThan8Deg: below8,
      note:
        belowFormal === 0
          ? 'Exactly zero. The published catalogue applies the |b| cut strictly, so inside the wedge ' +
            'the data is not sparse — it is absent. Any structure a renderer appears to show there ' +
            'is interpolation, and must not be drawn.'
          : `${belowFormal} galaxies lie inside the formal limit (recovered through low-extinction ` +
            'windows). The gap is a severe incompleteness rather than a hard cut, but it is still a gap.',
    },
  }
}

async function build2mrs() {
  process.stdout.write('\n[3/4] 2MASS Redshift Survey — J/ApJS/199/26/table3\n')
  const adql =
    'SELECT "ID","RAJ2000","DEJ2000","GLON","GLAT","Ktmag","cz","e_cz","n_cz","type" ' +
    'FROM "J/ApJS/199/26/table3"'
  const rows = parseTsv(await fetchCached('2mrs-table3.tsv', tapUrl(adql)))

  const records = []
  for (const r of rows) {
    const glon = num(r.GLON)
    const glat = num(r.GLAT)
    if (glon === null || glat === null) continue
    const typeStr = (r.type ?? '').trim()
    const tMatch = /^-?\d+/.exec(typeStr)
    records.push({
      glon,
      glat,
      cz: num(r.cz),
      eCz: num(r.e_cz),
      ktmag: num(r.Ktmag),
      tType: tMatch ? Number(tMatch[0]) : null,
      czFrom2mrs: (r.n_cz ?? '').trim() === '6',
    })
  }
  records.sort((a, b) => (a.cz ?? Infinity) - (b.cz ?? Infinity))

  const zoa = measureZoneOfAvoidance(records)

  const n = records.length
  const RECORD_BYTES = 14
  const buf = Buffer.allocUnsafe(n * RECORD_BYTES)
  const off = {
    cz: 0,
    glon: 4 * n,
    glat: 6 * n,
    eCz: 8 * n,
    ktmag: 10 * n,
    tType: 12 * n,
    flags: 13 * n,
  }

  const CZ_NULL = -2147483648
  let withRedshift = 0
  let czMin = Infinity
  let czMax = -Infinity

  for (let i = 0; i < n; i += 1) {
    const g = records[i]
    const hasCz = g.cz !== null
    if (hasCz) {
      withRedshift += 1
      if (g.cz < czMin) czMin = g.cz
      if (g.cz > czMax) czMax = g.cz
    }
    buf.writeInt32LE(hasCz ? g.cz : CZ_NULL, off.cz + i * 4)
    buf.writeUInt16LE(encodeLon(g.glon), off.glon + i * 2)
    buf.writeInt16LE(encodeLat(g.glat), off.glat + i * 2)
    buf.writeUInt16LE(g.eCz === null ? 65535 : clampU16(g.eCz), off.eCz + i * 2)
    buf.writeUInt16LE(g.ktmag === null ? 65535 : clampU16(g.ktmag / 1e-3), off.ktmag + i * 2)
    buf.writeInt8(g.tType === null ? -128 : Math.max(-127, Math.min(127, g.tType)), off.tType + i)
    let flags = 0
    if (hasCz) flags |= 1
    if (Math.abs(g.glat) < formalZoaLimitDeg(g.glon)) flags |= 2
    if (g.czFrom2mrs) flags |= 4
    buf.writeUInt8(flags, off.flags + i)
  }

  const binPath = join(OUT_DIR, '2mrs.bin')
  writeFileSync(binPath, buf)

  const manifest = {
    dataset: '2MASS Redshift Survey (2MRS) — all-sky galaxy redshift catalogue',
    file: '2mrs.bin',
    kind: 'MEASURED',
    recordCount: n,
    recordBytes: RECORD_BYTES,
    totalBytes: buf.length,
    byteOrder: 'little-endian',
    layout: 'struct-of-arrays (all of field 0, then all of field 1, ...)',
    coordinateFrame:
      'Galactic (l, b) as published, IAU 1958 system tied to J2000 equatorial. Galactic is the ' +
      'natural frame here because the survey gap is defined in it. Convert to equatorial/supergalactic ' +
      'downstream if needed.',
    epoch: 'J2000.0',
    distanceKind: {
      value: 'redshift_space',
      note:
        'THIS CATALOGUE CONTAINS NO MEASURED DISTANCES. Each record carries a heliocentric/barycentric ' +
        'recession velocity cz only. Any radius the renderer draws is a redshift-space position: it ' +
        'contains peculiar-velocity distortion (Fingers-of-God in clusters, Kaiser squashing on large ' +
        'scales) and must be labelled as such, never as a real-space position.',
      recommendedRadius:
        'For cz < 30000 km/s use the low-z approximation d ~ cz / H0 with H0 from cosmology.json ' +
        '(67.4 km/s/Mpc). Beyond that, integrate the comoving distance using z = cz/c. ' +
        'cz is in the barycentric frame, NOT the CMB frame: subtract the solar apex motion ' +
        '(~369.8 km/s toward l=264.021, b=48.253) before comparing with CF4 Vcmb.',
    },
    fields: [
      {
        name: 'cz',
        dtype: 'int32',
        byteOffset: off.cz,
        byteLength: 4 * n,
        unit: 'km/s',
        description:
          'Recession velocity corrected to the solar-system barycentre (VizieR column cz). ' +
          `Sentinel ${CZ_NULL} (INT32_MIN) means "no redshift"; check flags bit 0.`,
        quantization: null,
        dequantize: 'value',
      },
      {
        name: 'glon',
        dtype: 'uint16',
        byteOffset: off.glon,
        byteLength: 2 * n,
        unit: 'deg',
        description: 'Galactic longitude l, 0..360.',
        quantization: { scale: LON_SCALE, offset: 0, maxErrorDeg: LON_SCALE / 2 },
        dequantize: `deg = value * ${LON_SCALE}`,
      },
      {
        name: 'glat',
        dtype: 'int16',
        byteOffset: off.glat,
        byteLength: 2 * n,
        unit: 'deg',
        description: 'Galactic latitude b, -90..+90.',
        quantization: { scale: LAT_SCALE, offset: 0, maxErrorDeg: LAT_SCALE / 2 },
        dequantize: `deg = value * ${LAT_SCALE}`,
      },
      {
        name: 'eCz',
        dtype: 'uint16',
        byteOffset: off.eCz,
        byteLength: 2 * n,
        unit: 'km/s',
        description: 'Uncertainty in cz. 65535 = unknown.',
        quantization: null,
        dequantize: 'value',
      },
      {
        name: 'ktmag',
        dtype: 'uint16',
        byteOffset: off.ktmag,
        byteLength: 2 * n,
        unit: 'mag',
        description:
          'Extinction-corrected total extrapolated 2MASS Ks magnitude (Ktmag). 65535 = unknown. ' +
          'Survey limit Ks <= 11.75.',
        quantization: { scale: 1e-3, offset: 0 },
        dequantize: 'mag = value * 1e-3',
      },
      {
        name: 'tType',
        dtype: 'int8',
        byteOffset: off.tType,
        byteLength: n,
        unit: null,
        description:
          'Leading numeric morphological T-type from the ZCAT-convention type string ' +
          '(-9 = unclassified early .. 99 = peculiar/irregular codes). -128 is reserved for ' +
          '"not given" but is unused in this release: every row carries a type string.',
        quantization: null,
        dequantize: 'value',
      },
      {
        name: 'flags',
        dtype: 'uint8',
        byteOffset: off.flags,
        byteLength: n,
        unit: null,
        description:
          'bit0 = redshift present (cz valid); bit1 = lies inside the formal zone-of-avoidance ' +
          'limit for its longitude; bit2 = redshift measured by 2MRS itself (n_cz = 6).',
        quantization: null,
        dequantize: 'value',
      },
    ],
    statistics: {
      withRedshift,
      withoutRedshift: n - withRedshift,
      czKmS: { min: czMin, max: czMax },
      approxRedshiftRange: { zMin: Math.round((czMin / 299792.458) * 1e6) / 1e6, zMax: Math.round((czMax / 299792.458) * 1e6) / 1e6 },
    },
    zoneOfAvoidance: zoa,
    sourceUrl: 'https://vizier.cds.unistra.fr/viz-bin/VizieR-3?-source=J/ApJS/199/26/table3',
    vizierCatalogue: 'J/ApJS/199/26',
    vizierTable: 'J/ApJS/199/26/table3',
    sourceVersion: 'Huchra, Macri, Masters et al. 2012, ApJS 199, 26 (2012ApJS..199...26H)',
    retrieved: RETRIEVED,
    licence: CDS_LICENCE,
    attribution:
      '2MASS Redshift Survey — Huchra, Macri, Masters et al. (2012), ApJS 199, 26. ' +
      'Retrieved from VizieR (CDS, Strasbourg).',
    sha256: sha256(buf),
  }

  const manifestPath = join(OUT_DIR, '2mrs.json')
  const manifestJson = JSON.stringify(manifest, null, 2)
  writeFileSync(manifestPath, manifestJson)

  return {
    binPath,
    binBytes: buf.length,
    manifestPath,
    manifestBytes: Buffer.byteLength(manifestJson),
    rows: n,
    withRedshift,
    zoa,
  }
}

// ---------------------------------------------------------------------------
// 4. cosmology.json — frozen Planck 2018 parameters
// ---------------------------------------------------------------------------

const C_KM_S = 299792.458

function comovingDistanceMpc(z, { H0, Om, OL, Or }) {
  // D_C = (c/H0) * integral_0^z dz' / E(z'),  E = sqrt(Om(1+z)^3 + Or(1+z)^4 + OL)
  // Integrated in a = 1/(1+z) with Simpson's rule, which keeps the high-z tail well sampled.
  const aMin = 1 / (1 + z)
  const N = 400000
  const h = (1 - aMin) / N
  const f = (a) => 1 / Math.sqrt(Om * a + Or + OL * a ** 4) // = 1 / (a^2 E(a))
  let s = f(aMin) + f(1)
  for (let i = 1; i < N; i += 1) s += (i % 2 === 1 ? 4 : 2) * f(aMin + i * h)
  return (C_KM_S / H0) * ((h / 3) * s)
}

function particleHorizonMpc({ H0, Om, OL, Or }) {
  // comoving distance to z -> infinity (a -> 0); integrand ~ 1/sqrt(Or) near a=0, finite.
  const N = 400000
  const h = 1 / N
  const f = (a) => (a <= 0 ? 1 / Math.sqrt(Or) : 1 / Math.sqrt(Om * a + Or + OL * a ** 4))
  let s = f(0) + f(1)
  for (let i = 1; i < N; i += 1) s += (i % 2 === 1 ? 4 : 2) * f(i * h)
  return (C_KM_S / H0) * ((h / 3) * s)
}

function buildCosmology() {
  process.stdout.write('\n[4/4] cosmology.json — Planck 2018 VI (frozen)\n')

  const H0 = 67.4
  const Om = 0.315
  const OL = 0.685
  const h = H0 / 100
  // photons + 3 massless neutrino species: Omega_r h^2 = 4.15e-5
  const Or = 4.15e-5 / (h * h)
  const params = { H0, Om, OL, Or }

  const Z_STAR = 1089.9
  const dcLastScattering = comovingDistanceMpc(Z_STAR, params)
  const dcHorizon = particleHorizonMpc(params)
  const hubbleDistance = C_KM_S / H0
  const MPC_PER_GLY = 306.601394 // 1 Gly = 306.601 Mpc

  const payload = {
    dataset: 'Frozen cosmological parameters for OmniAtlas',
    kind: 'MEASURED (parameters) / DERIVED (distances computed from them)',
    retrieved: RETRIEVED,
    source: {
      name: 'Planck 2018 results. VI. Cosmological parameters',
      citation: 'Planck Collaboration, Aghanim N. et al. 2020, A&A 641, A6 (2018 results; 2020A&A...641A...6P)',
      dataset: 'TT,TE,EE+lowE+lensing',
      url: 'https://doi.org/10.1051/0004-6361/201833910',
      arxiv: 'arXiv:1807.06209',
      licence: 'Values quoted from the published paper; numerical facts, freely citable with attribution.',
    },
    parameters: {
      H0: { value: H0, unit: 'km/s/Mpc', uncertainty: 0.5, description: 'Hubble constant today.' },
      h: { value: Math.round(h * 1e6) / 1e6, unit: null, description: 'H0 / 100.' },
      OmegaM: { value: Om, unit: null, uncertainty: 0.007, description: 'Total matter density parameter.' },
      OmegaLambda: { value: OL, unit: null, uncertainty: 0.007, description: 'Dark-energy density parameter.' },
      OmegaK: { value: 0, unit: null, description: 'Curvature — assumed exactly flat, as the base LCDM model does.' },
      OmegaR: {
        value: Math.round(Or * 1e9) / 1e9,
        unit: null,
        description: 'Radiation (photons + 3 massless neutrinos), Omega_r h^2 = 4.15e-5. Negligible below z ~ 100 but included in the integrals.',
      },
      ageGyr: { value: 13.787, unit: 'Gyr', uncertainty: 0.02, description: 'Age of the universe.' },
      sigma8: { value: 0.811, unit: null, uncertainty: 0.006 },
      ns: { value: 0.965, unit: null, uncertainty: 0.004 },
      TcmbK: { value: 2.7255, unit: 'K', description: 'CMB monopole temperature (Fixsen 2009).' },
    },
    lastScattering: {
      z: Z_STAR,
      zRounded: 1089,
      description: 'Recombination / the surface of last scattering — the CMB. The limit of what can be seen.',
      comovingDistanceMpc: Math.round(dcLastScattering * 10) / 10,
      comovingDistanceGly: Math.round((dcLastScattering / MPC_PER_GLY) * 1000) / 1000,
      publishedPlanckValueMpc: 13869.6,
      publishedPlanckNote:
        'Planck 2018 VI quotes the comoving angular-diameter distance D_M(z*) = 13869.6 Mpc for the ' +
        'base model. Our value is computed here from the frozen parameters above and agrees to ' +
        'better than 1%; prefer our computed value so the number and the transform cannot drift apart.',
      lookbackTimeGyr: 13.787 - 0.00038,
      uiLabel:
        'the limit of what can be seen — 13.787 billion years of light travel. NOT "the edge of the universe".',
    },
    particleHorizon: {
      description:
        'Comoving distance light could have travelled since t=0 (z -> infinity): the radius of the ' +
        'observable universe. This — not the CMB shell — is the ~14,300 Mpc / 46.5 Gly figure ' +
        'usually quoted. The CMB shell sits just inside it.',
      comovingDistanceMpc: Math.round(dcHorizon * 10) / 10,
      comovingDistanceGly: Math.round((dcHorizon / MPC_PER_GLY) * 1000) / 1000,
      commonlyQuotedMpc: 14300,
      commonlyQuotedGly: 46.5,
    },
    derived: {
      hubbleDistanceMpc: Math.round(hubbleDistance * 10) / 10,
      hubbleTimeGyr: Math.round((977.792222 / H0) * 1000) / 1000,
      mpcPerGly: MPC_PER_GLY,
      speedOfLightKmS: C_KM_S,
    },
    distanceRecipes: {
      note: 'Which transform to use at which scale. Never mix them silently.',
      rules: [
        'Where a distance modulus exists (UNGC, Cosmicflows-4), use it directly: d_L = 10**(DM/5 - 5) Mpc. No cosmology is assumed and no H0 enters.',
        'Below z ~ 0.1 (2MRS, essentially all of it), d ~ cz / H0 is accurate to better than ~5%.',
        'Beyond that, integrate D_C = (c/H0) * int_0^z dz\'/E(z\'), E(z) = sqrt(Om(1+z)^3 + Or(1+z)^4 + OL).',
        'Luminosity distance d_L = (1+z) D_C; angular-diameter distance d_A = D_C / (1+z). For a flat universe these differ from D_C by factors that matter past z ~ 0.1.',
      ],
    },
    h0Tension: {
      description:
        'The early-universe (CMB) and late-universe (distance-ladder) measurements of H0 disagree ' +
        'at about 5 sigma. This is an open problem in cosmology, not a rounding error, and the UI ' +
        'surfaces it rather than hiding it.',
      planck2018: { H0: 67.4, uncertainty: 0.5, method: 'CMB + LCDM, early universe', source: 'Planck Collaboration 2020, A&A 641, A6' },
      sh0es: { H0: 73.04, uncertainty: 1.04, method: 'Cepheid-calibrated SNe Ia distance ladder, late universe', source: 'Riess et al. 2022, ApJ 934, L7 (2022ApJ...934L...7R)' },
      cosmicflows4Internal: {
        H0: 74.6,
        uncertainty: 0.8,
        method: 'Cosmicflows-4 internal zero point',
        source: 'Tully et al. 2023, ApJ 944, 94',
        warning:
          'CF4 distances are calibrated to H0 = 74.6 while this module uses 67.4. Mixing a CF4 ' +
          'distance with a cz/H0 distance puts a ~10% radial seam exactly at the scale transition. ' +
          'Use the CF4 distance modulus directly wherever CF4 is being rendered and disclose the scale.',
      },
      tensionSigma: Math.round(((73.04 - 67.4) / Math.sqrt(1.04 ** 2 + 0.5 ** 2)) * 100) / 100,
      uiNote:
        'How fast the universe expands is measured two ways that do not agree: 67.4 km/s/Mpc from ' +
        'the cosmic microwave background, 73.0 from nearby supernovae. OmniAtlas renders with the ' +
        'Planck value; distances beyond the Local Group carry this ~8% systematic.',
    },
  }

  const json = JSON.stringify(payload, null, 2)
  const path = join(OUT_DIR, 'cosmology.json')
  writeFileSync(path, json)
  return { path, bytes: Buffer.byteLength(json), dcLastScattering, dcHorizon }
}

// ---------------------------------------------------------------------------
// licence file
// ---------------------------------------------------------------------------

function writeLicence() {
  const text = `# Data sources and attribution — public/data/universe/

Everything in this directory was produced by \`scripts/build-universe.mjs\` on ${RETRIEVED}.
The UI MUST display the attribution strings below wherever these layers are rendered.

## Service acknowledgement (required for all three catalogues)

> ${CDS_ACKNOWLEDGEMENT}

The CDS VizieR service makes its data available under the Creative Commons Attribution 4.0
International licence (CC BY 4.0). Copyright in the underlying catalogue content remains with the
original authors and the publishing journals; each is cited individually below.

## ungc.json — Updated Nearby Galaxy Catalog

- VizieR catalogue: \`J/AJ/145/101\`, table \`catalog\`
- Reference: Karachentsev I. D., Makarov D. I., Kaisina E. I. (2013), *Updated Nearby Galaxy Catalog*,
  AJ 145, 101. Bibcode 2013AJ....145..101K.
- **Attribution string:** \`Updated Nearby Galaxy Catalog — Karachentsev, Makarov & Kaisina (2013), AJ 145, 101, via VizieR (CDS)\`

## cf4.bin / cf4.json — Cosmicflows-4 group catalogue

- VizieR catalogue: \`J/ApJ/944/94\`, table \`groups\` (published tables 3 and 4, merged by CDS)
- Reference: Tully R. B., Kourkchi E., Courtois H. M., Anand G. S., Blakeslee J. P., Brout D.,
  de Jaeger T., Dupuy A., Guinet D., Howlett C., Jensen J. B., Pomarede D., Rizzi L., Rubin D.,
  Said K., Scolnic D., Stahl B. E. (2023), *Cosmicflows-4*, ApJ 944, 94. Bibcode 2023ApJ...944...94T.
- **Attribution string:** \`Cosmicflows-4 — Tully et al. (2023), ApJ 944, 94, via VizieR (CDS)\`

## 2mrs.bin / 2mrs.json — 2MASS Redshift Survey

- VizieR catalogue: \`J/ApJS/199/26\`, table \`table3\`
- Reference: Huchra J. P., Macri L. M., Masters K. L., et al. (2012), *The 2MASS Redshift Survey —
  Description and Data Release*, ApJS 199, 26. Bibcode 2012ApJS..199...26H.
- 2MRS is built on the Two Micron All Sky Survey, a joint project of the University of Massachusetts
  and IPAC/Caltech, funded by NASA and the NSF. 2MASS requires this acknowledgement.
- **Attribution string:** \`2MASS Redshift Survey — Huchra et al. (2012), ApJS 199, 26, via VizieR (CDS); 2MASS: UMass / IPAC-Caltech, NASA / NSF\`

## cosmology.json — Planck 2018 cosmological parameters

- Reference: Planck Collaboration, Aghanim N. et al. (2020), *Planck 2018 results. VI. Cosmological
  parameters*, A&A 641, A6. arXiv:1807.06209. Bibcode 2020A&A...641A...6P.
- H0-tension alternative: Riess A. G. et al. (2022), ApJ 934, L7. Bibcode 2022ApJ...934L...7R.
- Parameter values are numerical facts quoted from the published papers; derived distances in the
  file are computed by this repository from those values.
- **Attribution string:** \`Cosmology: Planck 2018 VI (Planck Collaboration 2020, A&A 641, A6); H0 tension: Riess et al. (2022), ApJ 934, L7\`

## Distance-kind contract

No record in this directory carries a bare "distance". Every one declares its kind:

| kind | meaning |
|---|---|
| \`trgb_cepheid\` | tip-of-the-red-giant-branch or Cepheid; the best rungs of the ladder |
| \`geometric\` | maser or detached eclipsing binary; no ladder assumed |
| \`luminosity_distance\` | from a distance modulus / secondary standard candle |
| \`inherited\` | adopted from the host group, not measured for this object |
| \`redshift_space\` | from recession velocity and a Hubble-flow model; contains peculiar-velocity distortion |
| \`comoving\` | integrated from the frozen cosmology (cosmology.json); used only for the CMB shell |
`
  const path = join(OUT_DIR, 'LICENSE-DATA.md')
  writeFileSync(path, text)
  return { path, bytes: Buffer.byteLength(text) }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true })
process.stdout.write(`build-universe — extragalactic & large-scale structure ETL\nout: ${OUT_DIR}\ncache: ${CACHE_DIR}\n`)

const ungc = await buildUngc()
const cf4 = await buildCf4()
const mrs = await build2mrs()
const cosmo = buildCosmology()
const licence = writeLicence()

const kb = (b) => `${(b / 1024).toFixed(1)} KiB`
const pad = (s, w) => String(s).padEnd(w)

process.stdout.write('\n' + '='.repeat(78) + '\nSUMMARY\n' + '='.repeat(78) + '\n')
const table = [
  ['file', 'records', 'bytes', 'size'],
  ['ungc.json', ungc.rows, ungc.bytes, kb(ungc.bytes)],
  ['cf4.bin', cf4.rows, cf4.binBytes, kb(cf4.binBytes)],
  ['cf4.json (manifest)', '-', cf4.manifestBytes, kb(cf4.manifestBytes)],
  ['2mrs.bin', mrs.rows, mrs.binBytes, kb(mrs.binBytes)],
  ['2mrs.json (manifest)', '-', mrs.manifestBytes, kb(mrs.manifestBytes)],
  ['cosmology.json', '-', cosmo.bytes, kb(cosmo.bytes)],
  ['LICENSE-DATA.md', '-', licence.bytes, kb(licence.bytes)],
]
for (const [a, b, c, d] of table) {
  process.stdout.write(`${pad(a, 24)}${pad(b, 10)}${pad(typeof c === 'number' ? c.toLocaleString() : c, 12)}${d}\n`)
}
const total = ungc.bytes + cf4.binBytes + cf4.manifestBytes + mrs.binBytes + mrs.manifestBytes + cosmo.bytes + licence.bytes
process.stdout.write(`${pad('TOTAL', 24)}${pad('', 10)}${pad(total.toLocaleString(), 12)}${kb(total)}\n`)

process.stdout.write('\nDistance kinds\n')
process.stdout.write(`  ungc.json  ${JSON.stringify(ungc.kindCounts)}\n`)
process.stdout.write(
  `  cf4.bin    luminosity_distance: ${cf4.rows - cf4.calibratorAnchored}, trgb_cepheid-anchored: ${cf4.calibratorAnchored}\n`,
)
process.stdout.write(
  `  2mrs.bin   redshift_space: ${mrs.withRedshift} with cz, ${mrs.rows - mrs.withRedshift} position-only (flags bit0 = 0)\n`,
)
process.stdout.write('  cosmology.json  comoving (integrated from Planck 2018 parameters)\n')

process.stdout.write('\n2MRS zone of avoidance (measured)\n')
process.stdout.write(`  formal survey cut:        |b| > 5 deg (30 < l < 330), |b| > 8 deg otherwise\n`)
process.stdout.write(`  measured max |b| limit:   ${mrs.zoa.measured.maxLimitAbsBDeg} deg\n`)
process.stdout.write(`  mean obscured sky:        ${(mrs.zoa.measured.meanSkyFractionObscured * 100).toFixed(2)} %\n`)
process.stdout.write(
  `  galaxies inside the gap:  ${mrs.zoa.actualGalaxyCountsInsideTheGap.belowFormalLimit} (|b| < 5 deg: ${mrs.zoa.actualGalaxyCountsInsideTheGap.absBLessThan5Deg})\n`,
)

process.stdout.write('\nCosmology (computed from the frozen Planck 2018 parameters)\n')
process.stdout.write(`  comoving distance to last scattering (z=1089.9): ${cosmo.dcLastScattering.toFixed(1)} Mpc\n`)
process.stdout.write(`  particle horizon (z -> inf):                     ${cosmo.dcHorizon.toFixed(1)} Mpc (${(cosmo.dcHorizon / 306.601394).toFixed(2)} Gly)\n`)
process.stdout.write('\nDone.\n')
