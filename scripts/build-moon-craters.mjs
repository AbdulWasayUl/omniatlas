import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import shapefile from 'shapefile'

const shpPath = process.argv[2]
const dbfPath = process.argv[3]
const jsonOutput = process.argv[4]

if (!shpPath || !dbfPath || !jsonOutput) {
  throw new Error('Usage: node scripts/build-moon-craters.mjs <moon.shp> <moon.dbf> <craters.json>')
}

function clean(value) {
  return typeof value === 'string' ? value.replace(/\0+$/u, '').trim() : value
}

function tierFromDiameter(diameterKm) {
  if (diameterKm >= 150) return 0
  if (diameterKm >= 80) return 1
  if (diameterKm >= 40) return 2
  if (diameterKm >= 20) return 3
  if (diameterKm >= 10) return 4
  return 5
}

const craters = []
const source = await shapefile.open(shpPath, dbfPath, { encoding: 'utf-8' })

while (true) {
  const result = await source.read()
  if (result.done) break
  const { properties } = result.value
  const type = clean(properties.type)
  if (type !== 'Crater, craters') continue

  const name = clean(properties.clean_name) || clean(properties.name)
  const diameterKm = Number(properties.diameter)
  if (!name || !Number.isFinite(diameterKm) || diameterKm <= 0) continue

  const longitude = properties.center_lon > 180 ? properties.center_lon - 360 : properties.center_lon

  craters.push({
    id: `moon-crater-${name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replaceAll(/(^-|-$)/g, '')}`,
    name,
    latitude: properties.center_lat,
    longitude,
    diameterKm: Math.round(diameterKm * 100) / 100,
    tier: tierFromDiameter(diameterKm),
    approvalDate: clean(properties.approvaldt) || null,
    origin: clean(properties.origin) || null,
  })
}

craters.sort((a, b) => a.tier - b.tier || b.diameterKm - a.diameterKm)

mkdirSync(dirname(jsonOutput), { recursive: true })
writeFileSync(jsonOutput, JSON.stringify(craters))
process.stdout.write(`Wrote ${craters.length} lunar crater records to ${jsonOutput}\n`)
