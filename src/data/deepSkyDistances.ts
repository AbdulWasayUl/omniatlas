/**
 * Published distances for the deep-sky objects people actually come looking for.
 *
 * ## Why this file exists
 *
 * OpenNGC, the atlas's deep-sky catalogue, carries a parallax and a redshift and
 * nothing else. For the great majority of famous objects it has neither: there is no
 * useful trigonometric parallax to a nebula 1,300 light years away, and a redshift is
 * meaningless inside our own galaxy. The ETL is right to refuse to invent a distance
 * from what it has — feeding the Orion Nebula's heliocentric redshift to Hubble's law
 * puts it 412 kpc away, outside the Milky Way.
 *
 * The consequence, though, was that 3,038 named objects had no distance at all and
 * were drawn on a 100 kpc direction-only shell. That is defensible as a position, but
 * the renderer then derived each object's physical radius from its angular size and
 * that placeholder distance — so the Orion Nebula, 24 light years across, became
 * 8,000 light years across, and flying to it put the camera 13,700 light years away
 * looking at empty space. A placeholder distance had quietly become a measurement.
 *
 * ## What these values are
 *
 * Standard published distances, rounded to three significant figures, from the
 * general literature — the consensus figures you would find in the object's SIMBAD
 * summary or its NASA/IPAC entry. They are not reduced from a primary dataset inside
 * this repository, and no uncertainty travels with them, which is why objects placed
 * from this table are badged `derived` rather than `measured`, and why their distance
 * source reads `literature` in the inspector.
 *
 * They are a better answer than 100 kpc for every object listed. They are a worse
 * answer than a proper distance-ladder reduction, and replacing this table with one is
 * the right next step.
 *
 * Extragalactic distances here are luminosity distances in the local frame; at these
 * redshifts (z < 0.03) the distinction is under a percent and well inside the rounding.
 */

/** Light years per parsec. */
const LY_PER_PC = 3.261563777

/**
 * Messier number to distance in light years.
 *
 * The Messier catalogue is the natural scope: 110 objects, all of them bright,
 * well-studied and frequently visited, and every one of them has a distance that has
 * been argued over in print for decades.
 */
const MESSIER_LY: Record<number, number> = {
  1: 6500, 2: 37500, 3: 33900, 4: 7200, 5: 24500,
  6: 1600, 7: 980, 8: 4100, 9: 25800, 10: 14300,
  11: 6200, 12: 15700, 13: 22200, 14: 30300, 15: 33600,
  16: 7000, 17: 5500, 18: 4900, 19: 28700, 20: 5200,
  21: 4250, 22: 10400, 23: 2050, 24: 10000, 25: 2000,
  26: 5000, 27: 1360, 28: 17900, 29: 4000, 30: 27100,
  31: 2537000, 32: 2650000, 33: 2730000, 34: 1500, 35: 2800,
  36: 4100, 37: 4500, 38: 4200, 39: 800, 40: 510,
  41: 2300, 42: 1344, 43: 1600, 44: 577, 45: 444,
  46: 5400, 47: 1600, 48: 1500, 49: 56000000, 50: 3200,
  51: 23000000, 52: 5000, 53: 58000, 54: 87400, 55: 17600,
  56: 32900, 57: 2300, 58: 68000000, 59: 60000000, 60: 55000000,
  61: 52500000, 62: 22500, 63: 29300000, 64: 24000000, 65: 35000000,
  66: 36000000, 67: 2700, 68: 33600, 69: 29700, 70: 29300,
  71: 13000, 72: 54600, 73: 2500, 74: 32000000, 75: 67500,
  76: 2500, 77: 47000000, 78: 1600, 79: 42100, 80: 32600,
  81: 11800000, 82: 11500000, 83: 14700000, 84: 60000000, 85: 60000000,
  86: 52000000, 87: 53500000, 88: 47000000, 89: 50000000, 90: 58700000,
  91: 63000000, 92: 26700, 93: 3600, 94: 16000000, 95: 32600000,
  96: 31000000, 97: 2030, 98: 44400000, 99: 50200000, 100: 55000000,
  101: 20900000, 102: 50000000, 103: 8500, 104: 29300000, 105: 32000000,
  106: 23700000, 107: 20900, 108: 46000000, 109: 83500000, 110: 2690000,
}

/**
 * Non-Messier objects famous enough that an atlas which cannot reach them is
 * incomplete. Keyed by OpenNGC designation, which has no space and pads IC numbers.
 */
const DESIGNATION_LY: Record<string, number> = {
  IC0434: 1375, // Horsehead Nebula, in the Orion B cloud
  IC1396: 2400, // Elephant's Trunk
  IC0405: 1500, // Flaming Star Nebula
  IC2944: 6500, // Running Chicken
  IC5146: 2500, // Cocoon Nebula
  NGC0253: 11400000, // Sculptor Galaxy
  NGC0869: 7500, // h Persei, the Double Cluster
  NGC0884: 7500, // chi Persei
  NGC1499: 1000, // California Nebula
  NGC2070: 160000, // Tarantula Nebula, in the LMC
  NGC2237: 5200, // Rosette Nebula
  NGC2244: 5200, // the Rosette's cluster
  NGC2264: 2400, // Cone Nebula / Christmas Tree Cluster
  NGC2392: 6500, // Eskimo Nebula
  NGC3132: 2000, // Eight-Burst Nebula
  NGC3372: 7500, // Carina Nebula
  NGC4565: 42000000, // Needle Galaxy
  NGC4631: 25000000, // Whale Galaxy
  NGC5128: 12900000, // Centaurus A
  NGC5139: 17100, // Omega Centauri
  NGC6543: 3300, // Cat's Eye Nebula
  NGC6726: 500, // Corona Australis reflection complex
  NGC6960: 2400, // Veil Nebula, west
  NGC6992: 2400, // Veil Nebula, east
  NGC7000: 2600, // North America Nebula
  NGC7023: 1300, // Iris Nebula
  NGC7293: 655, // Helix Nebula
  NGC7331: 40000000, // Deer Lick group
  NGC7635: 7100, // Bubble Nebula
  NGC0104: 15800, // 47 Tucanae
  NGC0224: 2537000, // M31, under its NGC designation
  NGC0292: 200000, // Small Magellanic Cloud
}

/**
 * Distance in parsecs for a named deep-sky object, or null when none is published
 * here. `messier` is the catalogue number when the object has one.
 */
export function literatureDistancePc(designation: string, messier?: number | null): number | null {
  const ly = (messier != null ? MESSIER_LY[messier] : undefined) ?? DESIGNATION_LY[designation]
  return ly == null ? null : ly / LY_PER_PC
}

/** How many objects this table can place, for the data manifest. */
export const LITERATURE_DISTANCE_COUNT =
  Object.keys(MESSIER_LY).length + Object.keys(DESIGNATION_LY).length
