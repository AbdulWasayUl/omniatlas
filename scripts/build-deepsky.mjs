// Build-time ETL for the deep-sky layer.
//
//   node scripts/build-deepsky.mjs [--force]
//
// Sources (downloaded once into .cache/, which is gitignored):
//   1. OpenNGC, pinned to release tag v20260501 — NGC/IC catalogue + addendum (CC BY-SA 4.0)
//   2. OpenNGC outlines/objects/ — 379 traced isophote polygon files (CC BY-SA 4.0)
//   3. Harris (1996, 2010 edition) Milky Way globular cluster catalogue (mwgc.dat)
//
// Outputs: public/data/deepsky/{ngc.bin,ngc.json,ngc-ids.json,ngc-names.json,
//                               outlines.bin,outlines.json,globulars.json,LICENSE-DATA.md}
//
// Binary convention: little-endian, tightly packed Struct-of-Arrays (all of field A, then
// all of field B, ...). Every .bin has a sibling .json manifest giving field order, dtypes,
// byte offsets, quantization, frame, epoch, units, source URL, pinned tag, retrieval date
// and licence.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = join(ROOT, '.cache', 'deepsky')
const OUT = join(ROOT, 'public', 'data', 'deepsky')

const FORCE = process.argv.includes('--force')

// ---------------------------------------------------------------------------
// Pinned sources
// ---------------------------------------------------------------------------

const OPENNGC_TAG = 'v20260501'
const OPENNGC_REPO = 'https://github.com/mattiaverga/OpenNGC'
const OPENNGC_TARBALL = `https://codeload.github.com/mattiaverga/OpenNGC/tar.gz/refs/tags/${OPENNGC_TAG}`
const HARRIS_URL = 'https://physics.mcmaster.ca/~harris/mwgc.dat'

const RETRIEVED = '2026-10-14'

const OPENNGC_LICENCE = 'CC-BY-SA-4.0'
const OPENNGC_ATTRIBUTION =
  'OpenNGC — Mattia Verga, release ' +
  OPENNGC_TAG +
  ' (https://github.com/mattiaverga/OpenNGC), CC BY-SA 4.0'
const HARRIS_LICENCE =
  'Free of charge for all users; redistribution must refer to the original source ' +
  '(https://physics.mcmaster.ca/~harris/mwgc.dat) without charging any fee.'
const HARRIS_ATTRIBUTION =
  'Globular cluster data: Harris, W.E. 1996, AJ, 112, 1487 (2010 edition)'

// Planck 2018 TT,TE,EE+lowE+lensing+BAO — same constants as src/astronomy/cosmology.ts
const H0_KM_S_MPC = 67.66
const C_KM_S = 299792.458

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const log = (s) => process.stdout.write(`${s}\n`)
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

function fmtBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`
}

async function cached(name, url) {
  mkdirSync(CACHE, { recursive: true })
  const path = join(CACHE, name)
  if (!FORCE && existsSync(path)) {
    const buf = readFileSync(path)
    log(`  cache hit  ${name}  ${fmtBytes(buf.length)}`)
    return buf
  }
  log(`  fetching   ${url}`)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status} ${res.statusText}`)
  const buf = Buffer.from(await res.arrayBuffer())
  writeFileSync(path, buf)
  log(`  cached     ${name}  ${fmtBytes(buf.length)}`)
  return buf
}

/** Minimal POSIX/GNU tar reader (ustar). Returns Map<path, Buffer>. Node builtins only. */
function untar(buf) {
  const files = new Map()
  let offset = 0
  let longName = null
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512)
    if (header.every((b) => b === 0)) break
    const str = (s, e) => header.subarray(s, e).toString('utf8').replace(/\0.*$/s, '').trim()
    const prefix = str(345, 500)
    let name = str(0, 100)
    const sizeField = str(124, 136)
    const size = sizeField ? parseInt(sizeField, 8) : 0
    const typeFlag = String.fromCharCode(header[156]) || '0'
    const body = buf.subarray(offset + 512, offset + 512 + size)
    offset += 512 + Math.ceil(size / 512) * 512
    if (typeFlag === 'L') {
      longName = body.toString('utf8').replace(/\0.*$/s, '')
      continue
    }
    if (longName !== null) {
      name = longName
      longName = null
    } else if (prefix) {
      name = `${prefix}/${name}`
    }
    if (typeFlag === '0' || typeFlag === '\0') files.set(name, Buffer.from(body))
  }
  return files
}

/** RFC4180-ish CSV with a configurable delimiter. Returns array of string[]. */
function parseCsv(text, delim = ';') {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === delim) {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      field = ''
      rows.push(row)
      row = []
    } else if (ch !== '\r') field += ch
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/** "00:07:15.84" (hours) -> degrees. */
function raSexagesimalToDeg(s) {
  const m = /^\s*(\d+):(\d+):([\d.]+)\s*$/.exec(s)
  if (!m) return null
  const deg = (Number(m[1]) + Number(m[2]) / 60 + Number(m[3]) / 3600) * 15
  return Number.isFinite(deg) ? deg : null
}

/** "+27:42:29.1" -> degrees. */
function decSexagesimalToDeg(s) {
  const m = /^\s*([+-]?)(\d+):(\d+):([\d.]+)\s*$/.exec(s)
  if (!m) return null
  const mag = Number(m[2]) + Number(m[3]) / 60 + Number(m[4]) / 3600
  const deg = m[1] === '-' ? -mag : mag
  return Number.isFinite(deg) ? deg : null
}

const num = (s) => {
  if (s === undefined || s === null) return null
  const t = String(s).trim()
  if (t === '') return null
  const v = Number(t)
  return Number.isFinite(v) ? v : null
}

// ---------------------------------------------------------------------------
// 1 + 2. OpenNGC tarball
// ---------------------------------------------------------------------------

log('')
log(`OpenNGC ${OPENNGC_TAG}`)
const tarGz = await cached(`OpenNGC-${OPENNGC_TAG}.tar.gz`, OPENNGC_TARBALL)
const openNgcSha = sha256(tarGz)
const archive = untar(gunzipSync(tarGz))
const stem = `OpenNGC-${OPENNGC_TAG.replace(/^v/, '')}`
const pick = (p) => {
  const hit = archive.get(`${stem}/${p}`) ?? archive.get(p)
  if (!hit) throw new Error(`missing ${p} in OpenNGC tarball (entries: ${archive.size})`)
  return hit
}
log(`  archive    ${archive.size} files, sha256 ${openNgcSha.slice(0, 16)}…`)

// ---------------------------------------------------------------------------
// NGC + addendum -> ngc.bin
// ---------------------------------------------------------------------------

const TYPE_ORDER = [
  'G', 'GPair', 'GTrpl', 'GGroup', 'OCl', 'GCl', 'Cl+N', '*Ass',
  'PN', 'HII', 'DrkN', 'EmN', 'Neb', 'RfN', 'SNR', 'Nova',
  '*', '**', 'Other', 'Dup', 'NonEx',
]

function readCatalogue(csvBuf, fromAddendum) {
  const rows = parseCsv(csvBuf.toString('utf8'))
  const header = rows[0].map((h) => h.trim())
  const col = Object.fromEntries(header.map((h, i) => [h, i]))
  const need = ['Name', 'Type', 'RA', 'Dec', 'Const', 'MajAx', 'MinAx', 'PosAng',
    'B-Mag', 'V-Mag', 'SurfBr', 'Hubble', 'Pax', 'Redshift', 'M', 'Identifiers', 'Common names']
  for (const k of need) if (col[k] === undefined) throw new Error(`column "${k}" not in CSV header`)

  const out = []
  const skipped = []
  for (let r = 1; r < rows.length; r++) {
    const f = rows[r]
    if (!f || f.length < header.length - 2) continue
    const name = (f[col.Name] ?? '').trim()
    if (!name) continue
    const raDeg = raSexagesimalToDeg(f[col.RA] ?? '')
    const decDeg = decSexagesimalToDeg(f[col.Dec] ?? '')
    if (raDeg === null || decDeg === null) {
      // "NonEx" entries — catalogued objects later shown not to exist — carry no coordinates
      // at all. They cannot be placed on the sky, so they are dropped rather than faked.
      skipped.push(name)
      continue
    }
    out.push({
      designation: name,
      type: (f[col.Type] ?? '').trim(),
      raDeg,
      decDeg,
      constellation: (f[col.Const] ?? '').trim(),
      majAx: num(f[col.MajAx]),
      minAx: num(f[col.MinAx]),
      posAng: num(f[col.PosAng]),
      bmag: num(f[col['B-Mag']]),
      vmag: num(f[col['V-Mag']]),
      surfBr: num(f[col.SurfBr]),
      hubble: (f[col.Hubble] ?? '').trim(),
      pax: num(f[col.Pax]),
      redshift: num(f[col.Redshift]),
      messier: num(f[col.M]),
      identifiers: (f[col.Identifiers] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      commonNames: (f[col['Common names']] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      fromAddendum,
    })
  }
  return { rows: out, skipped }
}

const ngcParsed = readCatalogue(pick('database_files/NGC.csv'), false)
const addParsed = readCatalogue(pick('database_files/addendum.csv'), true)
const ngcRows = ngcParsed.rows
const addRows = addParsed.rows
const skippedNoPosition = [...ngcParsed.skipped, ...addParsed.skipped]
const records = [...ngcRows, ...addRows]
log(`  parsed     ${ngcRows.length} NGC/IC rows + ${addRows.length} addendum rows = ${records.length}`)
log(`  skipped    ${skippedNoPosition.length} rows with no coordinates: ${skippedNoPosition.join(', ')}`)

// Resolve distances. No distance is ever invented, and the distance indicator has to match
// the kind of object or the result is nonsense:
//
//   * Hubble's law is only meaningful for extragalactic objects. OpenNGC carries a redshift
//     for Galactic objects too (it is just their peculiar radial velocity re-expressed), and
//     feeding that to cz/H0 puts the Orion Nebula at 412 kpc instead of 412 pc.
//   * Conversely, OpenNGC's `Pax` is "the main value reported from SIMBAD", which for a galaxy
//     is a contaminated foreground measurement — it puts M31 at 167 pc. Parallax is therefore
//     only used for Galactic objects.
//
// Anything left over is direction-only. In particular M31 (z = -0.001, blueshifted) gets no
// Hubble distance: its real 785 kpc comes from Cepheids/TRGB, which OpenNGC does not carry,
// so inventing one here would be exactly the thing this pipeline must not do.
const EXTRAGALACTIC = new Set(['G', 'GPair', 'GTrpl', 'GGroup'])

let nParallax = 0
let nRedshift = 0
let nDirectionOnly = 0
let nNegativeZ = 0
let nLowZ = 0
let nParallaxIgnoredExtragalactic = 0
let nRedshiftIgnoredGalactic = 0
for (const rec of records) {
  const extragalactic = EXTRAGALACTIC.has(rec.type)
  rec.distancePc = Number.NaN
  rec.distanceKind = 0
  if (extragalactic) {
    if (rec.pax !== null && rec.pax > 0) nParallaxIgnoredExtragalactic++
    if (rec.redshift !== null && rec.redshift > 0) {
      rec.distancePc = ((rec.redshift * C_KM_S) / H0_KM_S_MPC) * 1e6
      rec.distanceKind = 2
      nRedshift++
      if (rec.redshift < 0.01) nLowZ++
    }
  } else {
    if (rec.redshift !== null && rec.redshift !== 0) nRedshiftIgnoredGalactic++
    if (rec.pax !== null && rec.pax > 0) {
      rec.distancePc = 1000 / rec.pax
      rec.distanceKind = 1
      nParallax++
    }
  }
  if (rec.distanceKind === 0) {
    nDirectionOnly++
    if (extragalactic && rec.redshift !== null && rec.redshift <= 0) nNegativeZ++
  }
}

// Quantization sanity: widen if the real data overflows the chosen scales.
const maxAx = records.reduce((a, r) => Math.max(a, r.majAx ?? 0, r.minAx ?? 0), 0)
const AX_SCALE = 0.01 // arcmin per code unit
if (maxAx / AX_SCALE >= 65535) throw new Error(`MajAx ${maxAx}' overflows uint16 at scale ${AX_SCALE}`)
const maxPa = records.reduce((a, r) => Math.max(a, r.posAng ?? 0), 0)
if (maxPa * 10 >= 65535) throw new Error(`PosAng ${maxPa} overflows uint16 at 0.1 deg`)

const N = records.length
const buffers = []
const fields = []
let off = 0
function section(name, Ctor, dtype, fill, extra = {}) {
  const arr = new Ctor(N)
  for (let i = 0; i < N; i++) arr[i] = fill(records[i], i)
  const bytes = arr.byteLength
  fields.push({ name, dtype, byteOffset: off, byteLength: bytes, count: N, ...extra })
  buffers.push(Buffer.from(arr.buffer, arr.byteOffset, bytes))
  off += bytes
  return arr
}

const I16_NULL = -32768
const U16_NULL = 65535
const q = (v, scale, nullValue) => (v === null ? nullValue : Math.round(v / scale))

section('raMicroDeg', Uint32Array, 'uint32', (r) => Math.round(r.raDeg * 1e6), {
  units: 'microdegree', dequantize: 'raDeg = raMicroDeg * 1e-6', frame: 'ICRS / J2000 equatorial',
})
section('decMicroDeg', Int32Array, 'int32', (r) => Math.round(r.decDeg * 1e6), {
  units: 'microdegree', dequantize: 'decDeg = decMicroDeg * 1e-6', frame: 'ICRS / J2000 equatorial',
})
section('redshift', Float32Array, 'float32', (r) => (r.redshift === null ? Number.NaN : r.redshift), {
  units: 'dimensionless (heliocentric z)', nullValue: 'NaN',
})
section('distancePc', Float32Array, 'float32', (r) => r.distancePc, {
  units: 'parsec', nullValue: 'NaN (direction-only object)',
  note: 'kind 1 = 1000/parallax_mas; kind 2 = Hubble distance z*c/H0 with ' +
    `H0 = ${H0_KM_S_MPC} km/s/Mpc, c = ${C_KM_S} km/s (Planck 2018)`,
})
section('vmag', Int16Array, 'int16', (r) => q(r.vmag, 0.01, I16_NULL), {
  units: 'mag (V)', dequantize: 'vmag = code * 0.01', nullValue: I16_NULL,
})
section('bmag', Int16Array, 'int16', (r) => q(r.bmag, 0.01, I16_NULL), {
  units: 'mag (B)', dequantize: 'bmag = code * 0.01', nullValue: I16_NULL,
})
section('majAx', Uint16Array, 'uint16', (r) => q(r.majAx, AX_SCALE, U16_NULL), {
  units: 'arcmin', dequantize: 'majAxArcmin = code * 0.01', nullValue: U16_NULL,
})
section('minAx', Uint16Array, 'uint16', (r) => q(r.minAx, AX_SCALE, U16_NULL), {
  units: 'arcmin', dequantize: 'minAxArcmin = code * 0.01', nullValue: U16_NULL,
})
section('posAng', Uint16Array, 'uint16', (r) => q(r.posAng, 0.1, U16_NULL), {
  units: 'degree, major-axis position angle north eastwards',
  dequantize: 'posAngDeg = code * 0.1', nullValue: U16_NULL,
})
section('surfBr', Int16Array, 'int16', (r) => q(r.surfBr, 0.01, I16_NULL), {
  units: 'mag/arcsec^2 (B-band, within the 25 mag isophote; galaxies only)',
  dequantize: 'surfBr = code * 0.01', nullValue: I16_NULL,
})
section('type', Uint8Array, 'uint8', (r) => {
  const i = TYPE_ORDER.indexOf(r.type)
  return i < 0 ? TYPE_ORDER.indexOf('Other') : i
}, { enum: TYPE_ORDER })
section('distanceKind', Uint8Array, 'uint8', (r) => r.distanceKind, {
  enum: ['none (direction-only)', 'parallax', 'hubble-from-redshift'],
})
section('messier', Uint8Array, 'uint8', (r) => (r.messier === null ? 0 : r.messier), {
  note: '0 = not a Messier object, else the Messier number 1..110',
})
section('flags', Uint8Array, 'uint8', (r) => {
  let v = 0
  if (r.fromAddendum) v |= 1
  if (r.commonNames.length) v |= 2
  if (r.type === 'Dup') v |= 4
  if (r.type === 'NonEx') v |= 8
  return v
}, { bits: { 0: 'from addendum.csv', 1: 'has common name', 2: 'duplicate entry', 3: 'nonexistent object' } })

const ngcBin = Buffer.concat(buffers)
const recordBytes = off / N

// ---------------------------------------------------------------------------
// Outlines -> outlines.bin
// ---------------------------------------------------------------------------

const outlineFiles = [...archive.keys()]
  .filter((k) => k.includes('/outlines/objects/') && k.endsWith('.txt'))
  .sort()
if (outlineFiles.length === 0) throw new Error('no outline files found in OpenNGC tarball')

const outlines = []
let totalPoints = 0
let totalRings = 0
for (const key of outlineFiles) {
  const base = key.slice(key.lastIndexOf('/') + 1).replace(/\.txt$/, '')
  const m = /^(.*?)(?:_lv(\d))?$/.exec(base)
  const objectName = m[1]
  const level = m[2] ? Number(m[2]) : 0
  const lines = archive.get(key).toString('utf8').split(/\r?\n/)
  const rings = []
  let cur = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    const t = line.split('\t')
    if (t.length < 4 || t[0].trim() !== 'line') continue
    const flag = t[1].trim()
    const ra = Number(t[2])
    const dec = Number(t[3])
    if (!Number.isFinite(ra) || !Number.isFinite(dec)) continue
    const last = cur[cur.length - 1]
    if (!last || last[0] !== ra || last[1] !== dec) cur.push([ra, dec])
    if (flag === '*') {
      // '*' terminates the ring (its point repeats the first vertex).
      if (cur.length >= 3) rings.push(cur)
      cur = []
    }
  }
  if (cur.length >= 3) rings.push(cur)
  if (rings.length === 0) continue
  outlines.push({ stem: base, object: objectName, level, rings })
  totalRings += rings.length
  for (const ring of rings) totalPoints += ring.length
}

const O = outlines.length
const R = totalRings
const P = totalPoints

const oRaMid = new Float32Array(O)
const oDecMid = new Float32Array(O)
const oRaScale = new Float32Array(O)
const oDecScale = new Float32Array(O)
const oRingStart = new Uint32Array(O)
const oRingCount = new Uint32Array(O)
const rPointStart = new Uint32Array(R)
const rPointCount = new Uint32Array(R)
const rOutline = new Uint16Array(R)
const pRa = new Int16Array(P)
const pDec = new Int16Array(P)

let ringCursor = 0
let pointCursor = 0
let worstErrArcsec = 0
for (let oi = 0; oi < O; oi++) {
  const o = outlines[oi]
  // Unwrap RA around the first vertex so an outline straddling RA = 0 stays contiguous.
  const ra0 = o.rings[0][0][0]
  const unwrap = (ra) => {
    let v = ra
    while (v - ra0 > 180) v -= 360
    while (v - ra0 < -180) v += 360
    return v
  }
  let raMin = Infinity, raMax = -Infinity, decMin = Infinity, decMax = -Infinity
  for (const ring of o.rings) {
    for (const [ra, dec] of ring) {
      const u = unwrap(ra)
      if (u < raMin) raMin = u
      if (u > raMax) raMax = u
      if (dec < decMin) decMin = dec
      if (dec > decMax) decMax = dec
    }
  }
  const raMid = (raMin + raMax) / 2
  const decMid = (decMin + decMax) / 2
  const raScale = Math.max((raMax - raMin) / 2 / 32767, 1e-9)
  const decScale = Math.max((decMax - decMin) / 2 / 32767, 1e-9)
  oRaMid[oi] = raMid
  oDecMid[oi] = decMid
  oRaScale[oi] = raScale
  oDecScale[oi] = decScale
  oRingStart[oi] = ringCursor
  oRingCount[oi] = o.rings.length
  for (const ring of o.rings) {
    rPointStart[ringCursor] = pointCursor
    rPointCount[ringCursor] = ring.length
    rOutline[ringCursor] = oi
    ringCursor++
    for (const [ra, dec] of ring) {
      const u = unwrap(ra)
      const rc = Math.max(-32768, Math.min(32767, Math.round((u - oRaMid[oi]) / oRaScale[oi])))
      const dc = Math.max(-32768, Math.min(32767, Math.round((dec - oDecMid[oi]) / oDecScale[oi])))
      pRa[pointCursor] = rc
      pDec[pointCursor] = dc
      const eRa = Math.abs(oRaMid[oi] + rc * oRaScale[oi] - u) * Math.cos((dec * Math.PI) / 180)
      const eDec = Math.abs(oDecMid[oi] + dc * oDecScale[oi] - dec)
      worstErrArcsec = Math.max(worstErrArcsec, Math.hypot(eRa, eDec) * 3600)
      pointCursor++
    }
  }
}

const outlineSections = [
  ['outlineRaMid', oRaMid, 'float32', 'degree', 'RA of the outline bounding-box centre'],
  ['outlineDecMid', oDecMid, 'float32', 'degree', 'Dec of the outline bounding-box centre'],
  ['outlineRaScale', oRaScale, 'float32', 'degree per code unit', 'RA dequantization scale'],
  ['outlineDecScale', oDecScale, 'float32', 'degree per code unit', 'Dec dequantization scale'],
  ['outlineRingStart', oRingStart, 'uint32', 'index', 'first ring index for this outline'],
  ['outlineRingCount', oRingCount, 'uint32', 'count', 'number of rings in this outline'],
  ['ringPointStart', rPointStart, 'uint32', 'index', 'first point index for this ring'],
  ['ringPointCount', rPointCount, 'uint32', 'count', 'number of points in this ring'],
  ['ringOutline', rOutline, 'uint16', 'index', 'owning outline index'],
  ['pointRa', pRa, 'int16', 'code', 'quantized RA offset'],
  ['pointDec', pDec, 'int16', 'code', 'quantized Dec offset'],
]
const outlineFieldMeta = []
const outlineBufs = []
let ooff = 0
for (const [name, arr, dtype, units, note] of outlineSections) {
  outlineFieldMeta.push({
    name, dtype, byteOffset: ooff, byteLength: arr.byteLength, count: arr.length, units, note,
  })
  outlineBufs.push(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength))
  ooff += arr.byteLength
}
const outlinesBin = Buffer.concat(outlineBufs)

// ---------------------------------------------------------------------------
// 3. Harris 2010 globular clusters
// ---------------------------------------------------------------------------

log('')
log('Harris (1996, 2010 edition) Milky Way globular clusters')
const harrisBuf = await cached('mwgc.dat', HARRIS_URL)
const harrisSha = sha256(harrisBuf)
const harrisLines = harrisBuf.toString('utf8').split(/\r?\n/)

function sectionLines(headerRegex) {
  const hi = harrisLines.findIndex((l) => headerRegex.test(l))
  if (hi < 0) throw new Error(`Harris section header not found: ${headerRegex}`)
  const out = []
  for (let i = hi + 1; i < harrisLines.length; i++) {
    const l = harrisLines[i]
    if (/^_{5,}/.test(l)) break
    if (!l.trim()) {
      if (out.length) break
      continue
    }
    out.push(l)
  }
  return out
}

const slice = (l, a, b) => l.slice(a, b).trim()
const sliceNum = (l, a, b) => {
  const t = slice(l, a, b)
  if (t === '') return null
  const v = Number(t)
  return Number.isFinite(v) ? v : null
}

const part1 = sectionLines(/^\s*ID\s+Name\s+RA\s+\(2000\)\s+DEC/)
const part2 = sectionLines(/^\s*ID\s+\[Fe\/H\]\s+wt/)
const part3 = sectionLines(/^\s*ID\s+v_r\s+\+\/-/)
if (part1.length !== 157) throw new Error(`Harris Part I: expected 157 rows, got ${part1.length}`)

const byId = new Map()
for (const l of part1) {
  const id = slice(l, 0, 12)
  const name = slice(l, 12, 25)
  const t = l.slice(25).trim().split(/\s+/)
  if (t.length !== 13) throw new Error(`Harris Part I row has ${t.length} tokens, expected 13: ${l}`)
  const [rah, ram, ras, decd, decm, decs, gl, gb, rSun, rGc, X, Y, Z] = t
  const decSign = decd.trim().startsWith('-') ? -1 : 1
  byId.set(id, {
    id,
    name: name || null,
    raDeg: (Number(rah) + Number(ram) / 60 + Number(ras) / 3600) * 15,
    decDeg: decSign * (Math.abs(Number(decd)) + Number(decm) / 60 + Number(decs) / 3600),
    glDeg: Number(gl),
    gbDeg: Number(gb),
    rSunKpc: Number(rSun),
    rGcKpc: Number(rGc),
    xKpc: Number(X),
    yKpc: Number(Y),
    zKpc: Number(Z),
  })
}
for (const l of part2) {
  const g = byId.get(slice(l, 0, 12))
  if (!g) continue
  g.feH = sliceNum(l, 12, 19)
  g.feHWeight = sliceNum(l, 19, 22)
  g.ebv = sliceNum(l, 22, 29)
  g.vHB = sliceNum(l, 29, 35)
  g.distanceModulusV = sliceNum(l, 35, 41)
  g.vMagIntegrated = sliceNum(l, 41, 47)
  g.absMagV = sliceNum(l, 47, 54)
  g.colorUB = sliceNum(l, 54, 61)
  g.colorBV = sliceNum(l, 61, 67)
  g.colorVR = sliceNum(l, 67, 73)
  g.colorVI = sliceNum(l, 73, 79)
  g.spectralType = slice(l, 79, 85) || null
  g.ellipticity = sliceNum(l, 85, 91)
}
for (const l of part3) {
  const g = byId.get(slice(l, 0, 13))
  if (!g) continue
  g.radialVelocityKmS = sliceNum(l, 13, 20)
  g.radialVelocityErrKmS = sliceNum(l, 20, 26)
  g.radialVelocityLsrKmS = sliceNum(l, 26, 34)
  g.velocityDispersionKmS = sliceNum(l, 34, 42)
  g.concentration = sliceNum(l, 48, 55)
  g.coreCollapsed = slice(l, 55, 60).startsWith('c')
  g.coreRadiusArcmin = sliceNum(l, 60, 65)
  g.halfLightRadiusArcmin = sliceNum(l, 65, 71)
  g.centralSurfaceBrightness = sliceNum(l, 71, 79)
  g.logCentralDensity = sliceNum(l, 79, 86)
}
const globulars = [...byId.values()].sort((a, b) => a.rSunKpc - b.rSunKpc)
const matched2 = globulars.filter((g) => g.feH !== undefined).length
const matched3 = globulars.filter((g) => g.concentration !== undefined).length
log(`  parsed     ${globulars.length} clusters (Part II matched ${matched2}, Part III matched ${matched3})`)

// ---------------------------------------------------------------------------
// Write outputs
// ---------------------------------------------------------------------------

mkdirSync(OUT, { recursive: true })
const written = []
function emit(name, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
  writeFileSync(join(OUT, name), buf)
  written.push([name, buf.length])
  return buf.length
}

const provenance = {
  sourceName: 'OpenNGC',
  sourceUrl: OPENNGC_REPO,
  sourceFile: `${OPENNGC_TARBALL}`,
  sourceVersion: OPENNGC_TAG,
  sourceSha256: openNgcSha,
  retrieved: RETRIEVED,
  licence: OPENNGC_LICENCE,
  attribution: OPENNGC_ATTRIBUTION,
  licenceUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
}

emit('ngc.bin', ngcBin)
emit('ngc.json', `${JSON.stringify({
  format: 'struct-of-arrays',
  endianness: 'little',
  binary: 'ngc.bin',
  recordCount: N,
  bytesPerRecord: recordBytes,
  totalBytes: ngcBin.length,
  sourceRows: {
    'database_files/NGC.csv': ngcRows.length,
    'database_files/addendum.csv': addRows.length,
    skippedWithoutCoordinates: skippedNoPosition,
  },
  frame: 'ICRS (J2000 equatorial)',
  epoch: 'J2000.0',
  note: 'Tightly packed struct-of-arrays: every field is one contiguous run of recordCount ' +
    'values at the stated byteOffset. Index i of each array refers to the same object; ' +
    'designations are in ngc-ids.json at the same index. Fields are ordered 4-byte, then ' +
    '2-byte, then 1-byte, so every byteOffset is a multiple of its dtype size and each field ' +
    'can be wrapped in a zero-copy typed-array view over the ArrayBuffer.',
  fields,
  placement: {
    threeDimensional: nParallax + nRedshift,
    fromParallax: nParallax,
    fromRedshift: nRedshift,
    directionOnly: nDirectionOnly,
    directionOnlyExtragalacticWithNonPositiveRedshift: nNegativeZ,
    parallaxIgnoredBecauseExtragalactic: nParallaxIgnoredExtragalactic,
    redshiftIgnoredBecauseGalactic: nRedshiftIgnoredGalactic,
    hubbleDistancesBelowZ001: nLowZ,
    rule: [
      'Extragalactic types (G, GPair, GTrpl, GGroup) with a positive heliocentric redshift ' +
      'get a Hubble distance. Their OpenNGC parallax is ignored: it is SIMBADs "main value", ' +
      'which for a galaxy is a contaminated foreground measurement (it would place M31 at 167 pc).',
      'Galactic types with a positive parallax get 1000/parallax_mas. Their redshift is ' +
      'ignored: it is a peculiar radial velocity, not cosmological expansion, and cz/H0 would ' +
      'place the Orion Nebula at 412 kpc instead of 412 pc.',
      'Everything else is direction-only (distancePc = NaN, distanceKind = 0) and must be drawn ' +
      'on the celestial sphere, not in depth. No distance is estimated, interpolated or invented.',
      'Notably M31/NGC0224 is direction-only here: it is blueshifted, so Hubbles law yields ' +
      'nothing, and its true 785 kpc rests on Cepheid/TRGB work that OpenNGC does not carry.',
    ],
    cosmology: {
      H0: H0_KM_S_MPC,
      c: C_KM_S,
      source: 'Planck 2018 TT,TE,EE+lowE+lensing+BAO',
      formula: 'distancePc = z * c / H0 * 1e6  (valid only for z << 1)',
      caveat: 'Below z ~ 0.01 (~44 Mpc) peculiar velocities of several hundred km/s are a large ' +
        `fraction of cz, so those ${nLowZ} Hubble distances are indicative only. Badge them ` +
        'DERIVED, never MEASURED.',
    },
  },
  companions: {
    'ngc-ids.json': 'index-aligned designations, constellations and Hubble morphological types',
    'ngc-names.json': 'objects carrying a common name and/or a Messier number',
  },
  ...provenance,
}, null, 2)}\n`)

const constValues = []
const constIndex = new Uint16Array(N)
const hubbleValues = []
const hubbleIndex = new Uint16Array(N)
const enumise = (values, s) => {
  if (!s) return 0
  let i = values.indexOf(s)
  if (i < 0) { values.push(s); i = values.length - 1 }
  return i + 1
}
constValues.length = 0
hubbleValues.length = 0
const designations = new Array(N)
for (let i = 0; i < N; i++) {
  designations[i] = records[i].designation
  constIndex[i] = enumise(constValues, records[i].constellation)
  hubbleIndex[i] = enumise(hubbleValues, records[i].hubble)
}
emit('ngc-ids.json', `${JSON.stringify({
  count: N,
  note: 'Arrays are index-aligned with ngc.bin. For the enum arrays, 0 means "absent" and ' +
    'value v>0 means values[v-1].',
  designations,
  constellations: { values: constValues, index: [...constIndex] },
  hubbleTypes: { values: hubbleValues, index: [...hubbleIndex] },
  ...provenance,
})}\n`)

const named = []
for (let i = 0; i < N; i++) {
  const r = records[i]
  if (!r.commonNames.length && r.messier === null) continue
  named.push({
    i,
    designation: r.designation,
    names: r.commonNames,
    messier: r.messier ?? null,
    type: r.type,
    constellation: r.constellation || null,
    raDeg: Math.round(r.raDeg * 1e6) / 1e6,
    decDeg: Math.round(r.decDeg * 1e6) / 1e6,
    vmag: r.vmag,
    bmag: r.bmag,
    majAxArcmin: r.majAx,
    minAxArcmin: r.minAx,
    distancePc: Number.isFinite(r.distancePc) ? Math.round(r.distancePc) : null,
    distanceKind: ['none', 'parallax', 'hubble'][r.distanceKind],
    identifiers: r.identifiers,
  })
}
const withCommonName = named.filter((o) => o.names.length).length
const withMessier = named.filter((o) => o.messier !== null).length
emit('ngc-names.json', `${JSON.stringify({
  count: named.length,
  withCommonName,
  withMessier,
  note: '"i" indexes into ngc.bin. These are the objects search and labels need.',
  objects: named,
  ...provenance,
}, null, 2)}\n`)

emit('outlines.bin', outlinesBin)
emit('outlines.json', `${JSON.stringify({
  format: 'struct-of-arrays',
  endianness: 'little',
  binary: 'outlines.bin',
  outlineCount: O,
  distinctObjects: new Set(outlines.map((o) => o.object)).size,
  byBrightnessLevel: outlines.reduce((a, o) => ({ ...a, [o.level]: (a[o.level] ?? 0) + 1 }), {}),
  ringCount: R,
  pointCount: P,
  totalBytes: outlinesBin.length,
  frame: 'ICRS (J2000 equatorial)',
  epoch: 'J2000.0',
  units: 'degrees after dequantization',
  quantization: {
    scheme: 'per-outline bounding-box centre + per-outline int16 scale',
    dequantize: [
      'o = ringOutline[r]',
      'raDeg  = outlineRaMid[o]  + pointRa[p]  * outlineRaScale[o]   // then wrap into [0,360)',
      'decDeg = outlineDecMid[o] + pointDec[p] * outlineDecScale[o]',
    ],
    worstCaseErrorArcsec: Math.round(worstErrArcsec * 1000) / 1000,
    note: 'RA is unwrapped per outline before quantizing so shapes straddling RA = 0 stay ' +
      'contiguous; dequantized RA may fall slightly outside [0,360) and must be wrapped.',
  },
  traversal: 'for each outline o: for r in [outlineRingStart[o], +outlineRingCount[o]): ' +
    'draw the closed polyline pointRa/pointDec[ringPointStart[r] .. +ringPointCount[r]]',
  fields: outlineFieldMeta,
  outlines: outlines.map((o, i) => ({
    i, file: `${o.stem}.txt`, object: o.object, level: o.level, rings: o.rings.length,
  })),
  methodology: 'Isophote contours traced in Aladin Sky Atlas over DSS2 Color at three ' +
    'brightness levels (lv1 faintest .. lv3 brightest), simplified with shapely. ' +
    'See outlines/metodology.txt in the OpenNGC source.',
  acknowledgement: 'This research has made use of "Aladin sky atlas" developed at CDS, ' +
    'Strasbourg Observatory, France.',
  ...provenance,
  sourceFilePath: 'outlines/objects/*.txt',
}, null, 2)}\n`)

// Columnar (struct-of-arrays) JSON: same convention as the .bin files, and ~4x smaller than
// 157 repeated objects with 30 long keys each.
const GLOBULAR_COLUMNS = [
  'id', 'name', 'raDeg', 'decDeg', 'glDeg', 'gbDeg', 'rSunKpc', 'rGcKpc', 'xKpc', 'yKpc', 'zKpc',
  'feH', 'feHWeight', 'ebv', 'vHB', 'distanceModulusV', 'vMagIntegrated', 'absMagV',
  'colorUB', 'colorBV', 'colorVR', 'colorVI', 'spectralType', 'ellipticity',
  'radialVelocityKmS', 'radialVelocityErrKmS', 'radialVelocityLsrKmS', 'velocityDispersionKmS',
  'concentration', 'coreCollapsed', 'coreRadiusArcmin', 'halfLightRadiusArcmin',
  'centralSurfaceBrightness', 'logCentralDensity',
]
const round6 = (v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v)
const globularColumns = Object.fromEntries(
  GLOBULAR_COLUMNS.map((k) => [k, globulars.map((g) => round6(g[k] ?? null))]),
)

emit('globulars.json', `${JSON.stringify({
  catalogue: 'Milky Way Globular Clusters (Harris 1996, 2010 edition)',
  count: globulars.length,
  revision: 'December 2010',
  sourceName: 'W. E. Harris, McMaster University',
  sourceUrl: HARRIS_URL,
  sourceVersion: '2010 edition (December 2010 revision)',
  sourceSha256: harrisSha,
  retrieved: RETRIEVED,
  licence: HARRIS_LICENCE,
  attribution: HARRIS_ATTRIBUTION,
  citation: 'Harris, W.E. 1996, AJ, 112, 1487 — cite in text as "Harris 1996 (2010 edition)"',
  provenanceKind: 'MEASURED',
  frames: {
    equatorial: 'ICRS / J2000; raDeg, decDeg in degrees',
    galactic: 'glDeg, gbDeg in degrees',
    cartesian: 'xKpc/yKpc/zKpc are Sun-centred galactic Cartesian kiloparsecs: ' +
      '+X toward the Galactic centre, +Y toward Galactic rotation, +Z toward the North ' +
      'Galactic Pole. rGcKpc assumes R_0 = 8.0 kpc.',
  },
  units: {
    rSunKpc: 'kpc', rGcKpc: 'kpc', xKpc: 'kpc', yKpc: 'kpc', zKpc: 'kpc',
    feH: 'dex', ebv: 'mag', vHB: 'mag', distanceModulusV: 'mag (apparent visual)',
    vMagIntegrated: 'mag', absMagV: 'mag', radialVelocityKmS: 'km/s',
    velocityDispersionKmS: 'km/s', coreRadiusArcmin: 'arcmin',
    halfLightRadiusArcmin: 'arcmin', centralSurfaceBrightness: 'V mag/arcsec^2',
    logCentralDensity: 'log10(Lsun/pc^3)', concentration: 'log10(r_t/r_c)',
  },
  format: 'columnar (struct-of-arrays): every entry of "columns" is an array of `count` ' +
    'values; index i of each array refers to the same cluster. Sorted by rSunKpc ascending. ' +
    'null means the Harris catalogue leaves that field blank — it is never estimated.',
  columnOrder: GLOBULAR_COLUMNS,
  columns: globularColumns,
})}\n`)

emit('LICENSE-DATA.md', `# Data licences — \`public/data/deepsky/\`

Generated by \`scripts/build-deepsky.mjs\` on ${RETRIEVED}. Do not edit by hand.

Files in this directory are derived databases. The obligations below travel with them and
**must be displayed in the UI** wherever this data is shown.

---

## 1. OpenNGC — \`ngc.bin\`, \`ngc.json\`, \`ngc-ids.json\`, \`ngc-names.json\`, \`outlines.bin\`, \`outlines.json\`

- **Source:** ${OPENNGC_REPO}
- **Release tag:** \`${OPENNGC_TAG}\` (pinned; tarball sha256 \`${openNgcSha}\`)
- **Retrieved:** ${RETRIEVED}
- **Licence:** Creative Commons Attribution-ShareAlike 4.0 International (**CC BY-SA 4.0**)
  — https://creativecommons.org/licenses/by-sa/4.0/
- **Copyright:** 2023 Mattia Verga <mattia.verga@tiscali.it>
- **DOI:** 10.21938/y.1ejWUD_MQ6b_eDFoVbbw

### Required attribution string (display verbatim)

> ${OPENNGC_ATTRIBUTION}

### ShareAlike obligation

CC BY-SA 4.0 is copyleft **on the derived database**. The files listed above are an adaptation
of OpenNGC and are therefore themselves licensed CC BY-SA 4.0. OmniAtlas' own application code
is unaffected (it is not an adaptation of the database). Two consequences:

1. Never inline these rows into \`src/\` — keep the derived database in this directory so the
   licence boundary is unambiguous.
2. \`scripts/build-deepsky.mjs\` stays in the repository so the "source form" obligation is
   trivially satisfiable.

### Upstream acknowledgements OpenNGC itself carries

OpenNGC is built by merging NASA/IPAC Extragalactic Database (NED), HyperLEDA, SIMBAD,
HEASARC tables and Harold Corwin's NGC/IC Positions and Notes. The following statements are
inherited and should appear in the Sources panel:

> This research has made use of the NASA/IPAC Extragalactic Database (NED) which is operated
> by the Jet Propulsion Laboratory, California Institute of Technology, under contract with
> the National Aeronautics and Space Administration.

> We acknowledge the usage of the HyperLeda database (http://leda.univ-lyon1.fr).

> This research has made use of the SIMBAD database, operated at CDS, Strasbourg, France.

### Nebula outlines

The outlines in \`outlines.bin\` come from the same OpenNGC repository
(\`outlines/objects/*.txt\`) and carry the same CC BY-SA 4.0 licence. They were traced in
Aladin, so OpenNGC's methodology note adds:

> This research has made use of "Aladin sky atlas" developed at CDS, Strasbourg Observatory,
> France.

Note on provenance: Stellarium's nebula-outline data is generated from this same OpenNGC
\`outlines/\` directory via the repository's \`shape.py\`. Stellarium's own code is GPL-2.0-or-later,
but that is not the licence of this data — the data licence is OpenNGC's CC BY-SA 4.0, and that
is the one quoted here.

---

## 2. Harris Milky Way Globular Cluster Catalogue — \`globulars.json\`

- **Source:** ${HARRIS_URL} (sha256 \`${harrisSha}\`)
- **Version:** 2010 edition (December 2010 revision), 157 clusters
- **Retrieved:** ${RETRIEVED}
- **Terms:** ${HARRIS_LICENCE}

### Required attribution string (display verbatim)

> ${HARRIS_ATTRIBUTION}

### Required citation

> Harris, W.E. 1996, AJ, 112, 1487

Cite in running text as **"Harris 1996 (2010 edition)"**.

The catalogue's own copyright notice:

> THE DATA IN THIS CATALOG ARE SUPPLIED FREE OF CHARGE TO ALL USERS. ANY THIRD PARTY WHO
> SUPPLIES THIS CATALOG IN TURN TO OTHER USERS MUST REFER TO THE ORIGINAL SOURCE, WHICH IS
> THIS WEBSITE, AND MUST DO SO WITHOUT CHARGE OF ANY FEE.

---

## Minimum UI credit line

> Deep-sky objects: ${OPENNGC_ATTRIBUTION} · ${HARRIS_ATTRIBUTION}
`)

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

log('')
log('Deep-sky build complete')
log('-----------------------')
log(`  OpenNGC ${OPENNGC_TAG}: ${ngcRows.length} NGC/IC + ${addRows.length} addendum = ${N} records`)
log(`    3D placed .......... ${nParallax + nRedshift}  (Galactic parallax ${nParallax}, extragalactic Hubble ${nRedshift})`)
log(`    direction-only ..... ${nDirectionOnly}  (incl. ${nNegativeZ} blueshifted galaxies)`)
log(`    rejected indicators  ${nParallaxIgnoredExtragalactic} parallaxes on galaxies, ${nRedshiftIgnoredGalactic} redshifts on Galactic objects`)
log(`    low-confidence ..... ${nLowZ} Hubble distances below z = 0.01`)
log(`    record size ........ ${recordBytes} B, ${fields.length} SoA fields`)
log(`  Nebula outlines: ${O} outlines (from ${outlineFiles.length} files), ${R} rings, ${P} points`)
log(`    worst dequant error  ${worstErrArcsec.toFixed(3)} arcsec`)
log(`  Globular clusters: ${globulars.length} (Harris 2010), all 3D-positioned`)
log(`  Named / Messier objects: ${named.length} (${withCommonName} with a common name, ${withMessier} Messier)`)
log('')
let total = 0
for (const [name, bytes] of written) {
  total += bytes
  log(`  ${join(OUT, name)}`.padEnd(74) + `${String(bytes).padStart(9)} B  (${fmtBytes(bytes)})`)
}
log('  '.padEnd(74) + `${String(total).padStart(9)} B  (${fmtBytes(total)}) total`)
log('')
