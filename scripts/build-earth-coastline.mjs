import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const source = process.argv[2]
const output = process.argv[3]

if (!source || !output) {
  throw new Error('Usage: node scripts/build-earth-coastline.mjs <coastline.geojson> <output.bin>')
}

const geojson = JSON.parse(readFileSync(source, 'utf8'))
const positions = []

function cartesian([longitude, latitude]) {
  const phi = (latitude * Math.PI) / 180
  const theta = (longitude * Math.PI) / 180
  const radius = 1.012
  return [
    radius * Math.cos(phi) * Math.cos(theta),
    radius * Math.sin(phi),
    -radius * Math.cos(phi) * Math.sin(theta),
  ]
}

function addLine(coordinates) {
  for (let index = 1; index < coordinates.length; index += 1) {
    positions.push(...cartesian(coordinates[index - 1]), ...cartesian(coordinates[index]))
  }
}

for (const feature of geojson.features) {
  const { geometry } = feature
  if (geometry.type === 'LineString') addLine(geometry.coordinates)
  if (geometry.type === 'MultiLineString') geometry.coordinates.forEach(addLine)
}

mkdirSync(dirname(output), { recursive: true })
const floats = Float32Array.from(positions)
writeFileSync(output, Buffer.from(floats.buffer))
process.stdout.write(`Wrote ${floats.length / 6} coastline segments to ${output}\n`)
