/**
 * build-exoplanet-systems — orbital parameters for the planets the atlas can show.
 *
 * `exoplanets.json` already records WHICH stars have planets and how many: it is a match
 * manifest, built by `build-stars.mjs`, and it carries no orbit. So the atlas knew that
 * 1,018 of the stars it draws have 1,455 measured planets between them, and could not
 * draw one of them — while immersive mode invented planets around those same stars,
 * which is the one thing this atlas is built not to do.
 *
 * This fills the gap without touching the star tiers. It reads the existing manifest,
 * takes its matches as given, and asks the NASA Exoplanet Archive only for the numbers
 * needed to put a body on an orbit. Keyed on `hostname`, which is the column the manifest
 * matched on, so the two files cannot disagree about which star a planet belongs to.
 *
 * What is measured here is the orbit's SIZE, SHAPE and PERIOD, and the planet's radius
 * and mass. What is not measured, and is not in this file, is where along that orbit a
 * planet is at a given instant: `pscomppars` carries a transit mid-point for some and
 * nothing for most, so the atlas seeds the phase from the planet's name and says so.
 *
 * Run: node scripts/build-exoplanet-systems.mjs
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const OUT_DIR = 'public/data/stars'
const CACHE_DIR = '.cache'
const REFRESH = process.argv.includes('--refresh')
const RETRIEVED = new Date().toISOString().slice(0, 10)

const TAP = 'https://exoplanetarchive.ipac.caltech.edu/TAP/sync'
const TABLE = 'pscomppars'
const COLUMNS = [
  'pl_name',
  'hostname',
  'pl_orbper',    // days
  'pl_orbsmax',   // AU
  'pl_rade',      // Earth radii
  'pl_bmasse',    // Earth masses
  'pl_orbeccen',
  'pl_orbincl',   // degrees
  'pl_eqt',       // equilibrium temperature, K
  'st_teff',      // K
  'st_rad',       // solar radii
  'st_mass',      // solar masses
].join(',')
const LICENCE = 'Public domain (NASA Exoplanet Archive, NASA/Caltech)'

const log = (s) => process.stdout.write(`${s}\n`)
const url = () => `${TAP}?query=${encodeURIComponent(`select ${COLUMNS} from ${TABLE}`)}&format=csv`

async function cached(name, from) {
  const path = join(CACHE_DIR, name)
  if (!REFRESH && existsSync(path) && statSync(path).size > 0) {
    log(`  cache hit  ${name} (${statSync(path).size.toLocaleString()} B)`)
    return readFileSync(path, 'utf8')
  }
  mkdirSync(CACHE_DIR, { recursive: true })
  log(`  downloading ${name} ...`)
  let last
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(from)
      const body = await response.text()
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 300)}`)
      if (body.trim().length === 0) throw new Error('empty response')
      writeFileSync(path, body)
      log(`  saved       ${name} (${body.length.toLocaleString()} B)`)
      return body
    } catch (error) {
      last = error
      log(`  attempt ${attempt} failed (${String(error.message).slice(0, 140)})`)
      await new Promise((r) => setTimeout(r, attempt * 4000))
    }
  }
  throw new Error(`could not retrieve ${name}: ${last?.message}`)
}

/** The archive quotes any field containing a comma; nothing else needs escaping here. */
function parseCsv(text) {
  const rows = []
  const lines = text.split('\n').filter((l) => l.trim().length > 0)
  for (const line of lines) {
    const out = []
    let cur = ''
    let quoted = false
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i]
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i += 1 }
        else if (c === '"') quoted = false
        else cur += c
      } else if (c === '"') quoted = true
      else if (c === ',') { out.push(cur); cur = '' }
      else cur += c
    }
    out.push(cur)
    rows.push(out.map((v) => v.trim()))
  }
  return rows
}

const number = (v) => {
  if (v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
/** Keeps the file small. Six significant figures is far finer than any of these are known. */
const round = (v, sig = 6) => (v === null ? null : Number(v.toPrecision(sig)))

mkdirSync(OUT_DIR, { recursive: true })
log('build-exoplanet-systems — orbits for the planets the atlas already knows about\n')

const manifestPath = join(OUT_DIR, 'exoplanets.json')
if (!existsSync(manifestPath)) throw new Error(`${manifestPath} is missing; run build-stars.mjs first`)
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

// Only hosts that resolved to a star the atlas can actually place. A host in tier L2
// reports `star: null` — L2 carries no global index — so there is nothing to hang a
// planet off even though the star is drawn.
const placeable = new Map()
for (const h of manifest.matchedHosts) {
  if (h.star === null || h.star === undefined) continue
  placeable.set(h.host, h)
}
log(`  ${manifest.matchedHosts.length.toLocaleString()} matched hosts, ${placeable.size.toLocaleString()} with a placeable star index`)

const csv = await cached('nasa_exoplanet_orbits.csv', url())
const rows = parseCsv(csv)
const header = rows[0]
const idx = Object.fromEntries(header.map((name, i) => [name, i]))
for (const required of ['pl_name', 'hostname', 'pl_orbsmax', 'pl_orbper']) {
  if (idx[required] === undefined) throw new Error(`column ${required} missing; the archive schema changed`)
}

const systems = new Map()
let rowsSeen = 0
let withoutOrbit = 0
for (let r = 1; r < rows.length; r += 1) {
  const f = rows[r]
  const host = f[idx.hostname]
  const match = placeable.get(host)
  if (!match) continue
  rowsSeen += 1

  const semiMajorAxisAu = number(f[idx.pl_orbsmax])
  const periodDays = number(f[idx.pl_orbper])
  // A planet with neither a period nor a separation cannot be put on an orbit at all,
  // and a drawn body at a made-up distance is exactly the confusion this file exists to
  // prevent. Counted and dropped rather than guessed.
  if (semiMajorAxisAu === null && periodDays === null) { withoutOrbit += 1; continue }

  let system = systems.get(host)
  if (!system) {
    systems.set(host, (system = {
      host,
      star: match.star,
      tier: match.tier,
      via: match.via,
      teffK: round(number(f[idx.st_teff])),
      radiusSun: round(number(f[idx.st_rad])),
      massSun: round(number(f[idx.st_mass])),
      planets: [],
    }))
  }
  system.planets.push({
    name: f[idx.pl_name],
    semiMajorAxisAu: round(semiMajorAxisAu),
    periodDays: round(periodDays),
    radiusEarths: round(number(f[idx.pl_rade])),
    massEarths: round(number(f[idx.pl_bmasse])),
    eccentricity: round(number(f[idx.pl_orbeccen])),
    inclinationDeg: round(number(f[idx.pl_orbincl])),
    equilibriumK: round(number(f[idx.pl_eqt])),
  })
}

const list = [...systems.values()].sort((a, b) => a.star - b.star)
for (const s of list) s.planets.sort((a, b) => (a.semiMajorAxisAu ?? 1e9) - (b.semiMajorAxisAu ?? 1e9))
const planetCount = list.reduce((n, s) => n + s.planets.length, 0)

const payload = {
  source: 'NASA Exoplanet Archive, `pscomppars` (Planetary Systems Composite Parameters), public TAP sync endpoint',
  sourceUrl: TAP,
  downloadUrl: url(),
  sourceVersion: `${TABLE} as served on ${RETRIEVED}`,
  retrieved: RETRIEVED,
  licence: LICENCE,
  attribution:
    'This research has made use of the NASA Exoplanet Archive, which is operated by the ' +
    'California Institute of Technology, under contract with the National Aeronautics and ' +
    'Space Administration under the Exoplanet Exploration Program.',
  frame: 'orbital elements about the host star; no common reference direction is implied',
  units: {
    semiMajorAxisAu: 'AU',
    periodDays: 'days',
    radiusEarths: 'Earth radii (6,371 km)',
    massEarths: 'Earth masses',
    inclinationDeg: 'degrees, as published — the line of sight, not a shared plane',
    equilibriumK: 'kelvin',
    teffK: 'kelvin',
    radiusSun: 'solar radii',
    massSun: 'solar masses',
  },
  notes: [
    'Keyed on `hostname` against the matches already recorded in exoplanets.json, so the two files cannot disagree about which star a planet orbits.',
    '`star` is the global index into the l0 ++ l1 star concatenation, the same index exoplanets.json uses and the same one the atlas builds its `star:<i>` node ids from.',
    'What is measured here is the size, shape and period of the orbit, plus the planet’s radius and mass where published. WHERE ALONG the orbit a planet is at a given instant is not: pscomppars gives a transit mid-point for some and nothing for most, so the atlas seeds the phase deterministically from the planet name and says so in the inspector.',
    'Published inclination is measured against the line of sight, not against any shared plane, so two planets of one system with the same inclination are not necessarily coplanar on screen. The atlas draws them as published.',
    'A row with neither a period nor a semi-major axis is dropped rather than placed at a guessed distance.',
    'A null field is a value the archive does not publish for that planet. It is carried as null rather than filled in.',
  ],
  systemCount: list.length,
  planetCount,
  droppedWithoutOrbit: withoutOrbit,
  systems: list,
}

const outPath = join(OUT_DIR, 'exoplanet-systems.json')
writeFileSync(outPath, `${JSON.stringify(payload, null, 1)}\n`)

log('')
log(`  rows for placeable hosts  ${rowsSeen.toLocaleString()}`)
log(`  dropped (no orbit at all) ${withoutOrbit.toLocaleString()}`)
log(`  systems written           ${list.length.toLocaleString()}`)
log(`  planets written           ${planetCount.toLocaleString()}`)
log(`  ${outPath}  ${(statSync(outPath).size / 1024).toFixed(1)} KiB`)
