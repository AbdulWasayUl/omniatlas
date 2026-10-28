import { type Vec3d, vec3d } from './world'

/**
 * Turning a measured ellipse on the sky into a disc in three dimensions.
 *
 * A galaxy catalogue states three things about shape: a major axis, a minor axis, and a
 * position angle. Those describe the ELLIPSE WE SEE, not the object. The object, for a
 * disc galaxy, is taken to be a circle seen at an angle, and that is the assumption this
 * module makes explicit — it is an assumption, not a measurement, and everything derived
 * here inherits that.
 *
 * Given the assumption the reconstruction is exact and the arithmetic below is forced:
 * the major axis of the projected ellipse IS the sky-plane direction the disc is not
 * foreshortened along, so it is the disc's own major axis; the minor axis is
 * foreshortened by exactly cos(inclination), which is why the axis ratio IS the cosine
 * and no angle has to be formed or re-trigonometried to use it.
 *
 * ## What cannot be recovered
 *
 * Two independent ambiguities, neither resolvable from a catalogue ellipse:
 *
 *  - **Which edge is nearer.** +i and -i project to the same ellipse. The disc returned
 *    here always tilts the same way; the other tilt is equally consistent with the data.
 *  - **Position angle is modulo 180 degrees.** A major axis is a line, not an arrow, so
 *    the catalogue cannot say which end is which.
 *
 * Together that is a four-fold ambiguity in the orientation. It does not affect the
 * PROJECTED shape at all — all four reconstructions look identical from here, which is
 * precisely why the catalogue cannot distinguish them — and it is why the atlas may draw
 * a galaxy's silhouette with confidence and may not claim to know which way it is facing.
 *
 * Anything calling this is producing DERIVED geometry from MEASURED angles, and must say
 * so where the result is presented, in the same voice `galaxy/field.json` already uses
 * for the Milky Way's own point cloud.
 */
export interface DiscBasis {
  /** The disc's major axis: a unit vector, in the sky plane, at the position angle. */
  u: Vec3d
  /** The in-plane direction perpendicular to `u`, tilted out of the sky by the inclination. */
  v: Vec3d
}

/**
 * The in-plane basis of a disc whose projection is the catalogued ellipse.
 *
 * `axisRatio` is minor over major, in (0, 1]: 1 is face-on, approaching 0 is edge-on.
 * `posAngDeg` is the major axis measured from North towards East, the convention every
 * catalogue the atlas reads uses. Both vectors come back unit length, in the ICRF basis
 * the caller's directions are already in.
 *
 * A point on the rim at parameter t is `centre + radius * (cos(t) * u + sin(t) * v)`,
 * and that expression projects to a sky ellipse with semi-major `radius` along the
 * position angle and semi-minor `radius * axisRatio` across it — which is the property
 * the tests pin, because it is the whole contract.
 */
export function discBasis(raDeg: number, decDeg: number, axisRatio: number, posAngDeg: number): DiscBasis {
  const ra = (raDeg * Math.PI) / 180
  const dec = (decDeg * Math.PI) / 180
  const pa = (posAngDeg * Math.PI) / 180
  const cosRa = Math.cos(ra)
  const sinRa = Math.sin(ra)
  const cosDec = Math.cos(dec)
  const sinDec = Math.sin(dec)

  // The local sky frame at this direction. East is d(direction)/d(RA) normalised, North
  // is d(direction)/d(Dec), which is already unit length; they satisfy east x north =
  // direction, so the triple is right-handed with the third axis pointing AWAY from us.
  const eastX = -sinRa
  const eastY = cosRa
  const eastZ = 0
  const northX = -sinDec * cosRa
  const northY = -sinDec * sinRa
  const northZ = cosDec
  const dirX = cosDec * cosRa
  const dirY = cosDec * sinRa
  const dirZ = sinDec

  // Position angle runs from North towards East, so the major axis is a rotation of
  // North by the position angle, and `across` is that rotated a further 90 degrees.
  const cosPa = Math.cos(pa)
  const sinPa = Math.sin(pa)
  const acrossX = -sinPa * northX + cosPa * eastX
  const acrossY = -sinPa * northY + cosPa * eastY
  const acrossZ = -sinPa * northZ + cosPa * eastZ

  // cos(inclination) IS the axis ratio, clamped because a catalogue minor axis can
  // exceed its major by a hair through independent rounding, and a negative square root
  // would put NaN into a vertex buffer — where it would silently erase the whole draw
  // call rather than fail loudly.
  const cosInc = Math.min(1, Math.max(0, axisRatio))
  const sinInc = Math.sqrt(1 - cosInc * cosInc)

  return {
    u: vec3d(cosPa * northX + sinPa * eastX, cosPa * northY + sinPa * eastY, cosPa * northZ + sinPa * eastZ),
    // The sign on the out-of-sky term is the unresolvable one: flipping it tilts the far
    // edge towards us instead, and projects identically. See the note above.
    v: vec3d(cosInc * acrossX + sinInc * dirX, cosInc * acrossY + sinInc * dirY, cosInc * acrossZ + sinInc * dirZ),
  }
}
