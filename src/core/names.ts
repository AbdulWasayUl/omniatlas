/**
 * Catalogue spellings into something a label can show.
 *
 * Formatting only: no name is invented, and anything unrecognised is passed through
 * untouched. Three modules used to carry their own copy of this and two of them
 * disagreed — the galactic one knew NGC, IC and UGC, the cosmic one also knew UGCA,
 * PGC, DDO and ESO. Both are fed from the same UNGC table, and `oneLabelPerObject`
 * keys on the name, so every row in the gap between them was labelled twice: the
 * Magellanic Clouds, M31, M33 and DDO 210 each carried "DDO210" from one module and
 * "DDO 210" from the other, and a key that differs by a space is not a key that matches.
 *
 * So there is one implementation and the modules import it. The duplicate labels were
 * the visible symptom; the invariant worth keeping is that a dedupe keyed on a rendered
 * string needs exactly one renderer.
 */
export function displayName(name: string): string {
  const messier = /^MESSIER0*(\d+)$/i.exec(name)
  if (messier) return `M${messier[1]}`
  // `UGC` precedes `UGCA`, and the engine backtracks into the longer alternative when
  // the digits fail to match — "UGCA264" takes the UGCA branch, not a UGC branch that
  // would leave an "A" stranded.
  const designation = /^(NGC|IC|UGC|UGCA|PGC|DDO|ESO)0*(\d+.*)$/i.exec(name)
  if (designation) return `${designation[1].toUpperCase()} ${designation[2]}`
  return name
}

/**
 * A catalogue designation carried by a node id, normalised so two spellings of one
 * designation compare equal; null when the id carries none.
 *
 * `ungc:ngc5128` and `ngc:NGC5128` are one galaxy listed in two tables, and the tables
 * disagree about what to call it — "NGC 5128" against "Centaurus A". Leading zeros,
 * case and separators differ too, so the comparison is over the catalogue prefix and
 * the number alone.
 */
export function designationKey(raw: string): string | null {
  const match = /^(NGC|IC|UGCA|UGC|PGC|DDO|ESO|MESSIER|M)[\s_-]*0*(\d+[A-Za-z]*(?:-\d+)?)$/i.exec(raw)
  if (!match) return null
  const prefix = match[1].toUpperCase()
  return `${prefix === 'M' ? 'MESSIER' : prefix}${match[2].toUpperCase()}`
}

/**
 * The designation an id carries, if any.
 *
 * A bare "M" is deliberately not read as a Messier number here: `bh:m87` is the black
 * hole at the centre of M87, not the galaxy, and merging the two would cost the atlas
 * one of them. A module that means the Messier number says so in `designations`, where
 * it is a statement rather than an inference from a naming convention.
 */
export function idDesignationKey(id: string): string | null {
  const body = id.slice(id.indexOf(':') + 1)
  return /^m\d/i.test(body) ? null : designationKey(body)
}
