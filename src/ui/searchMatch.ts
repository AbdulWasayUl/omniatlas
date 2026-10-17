/**
 * Matching a typed query against a catalogue designation.
 *
 * Separate from the palette component because it is pure, order-sensitive string
 * work whose failures are invisible in a screenshot: the list still looks like a
 * list when every row in it is wrong.
 */

/**
 * Fold a catalogue designation to its comparable core.
 *
 * Case, spaces, dots and hyphens are presentation, not identity: "NGC 224", "ngc0224"
 * and "NGC-224" are the same object to everyone except a string comparison. Leading
 * zeros are stripped only from the number immediately after a catalogue prefix, so
 * "NGC0224" folds to "ngc224" while an id like "ic2431 ned02" keeps its second part.
 */
export function foldDesignation(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s.\-_]/g, '')
    .replace(/^([a-z]+)0+(\d)/, '$1$2')
}

/**
 * Alias strings a query may legitimately arrive as, for one candidate.
 *
 * Everything here is synthesised from data the node already carries. The catalogue
 * modules know much more — Messier numbers for the NGC/IC objects, Bayer letters and
 * HD/HIP numbers for the named stars — and when they start publishing it as
 * `designations` this folds it in without another change here. Until then "m45" and
 * "alpha cen" still find nothing, because nothing registered knows those names.
 */
export function aliasesFor(id: string, name: string, node: { designation?: string; designations?: string[] } | null): string[] {
  // The catalogue part only, never the whole id. Every star is registered as
  // `star:<n>`, so with the full form in here a query of "star" prefix-matched 600 of
  // them at a tier above any name match and the result list filled with Ain, Ran, Kui
  // and Gar while "Barnard's Star" and "Kapteyn's Star" fell off the end of it. The
  // part after the colon is what makes "ngc224" reachable; the prefixed form is not
  // something anyone types.
  const out = [id.slice(id.indexOf(':') + 1)]
  if (node?.designation) out.push(node.designation)
  if (node?.designations) out.push(...node.designations)
  // "M31" and "Messier 31" are the same request; only one of them is ever registered.
  const messier = /^m\s?(\d+)\b/i.exec(name) ?? /^messier\s*(\d+)\b/i.exec(name)
  if (messier) out.push(`m${messier[1]}`, `messier${messier[1]}`)
  return [...new Set(out.map(foldDesignation))].filter(Boolean)
}
/**
 * Does an alias contain the query, without one catalogue number swallowing another?
 *
 * The folded forms have had their spaces taken out, so a plain `includes` lets the
 * digits of one designation match the start of a longer one: "ngc 224" folds to
 * "ngc224", which is a substring of "ngc2244", and the Andromeda Galaxy was listed
 * with the Rosette's NGC 2244 under it. A digit run in the query may end an alias or
 * run into a non-digit, but may not be the head of a longer run.
 */
export function aliasContains(alias: string, qd: string): boolean {
  const lastIsDigit = qd.charCodeAt(qd.length - 1) >= 48 && qd.charCodeAt(qd.length - 1) <= 57
  for (let from = 0; ; from++) {
    const at = alias.indexOf(qd, from)
    if (at < 0) return false
    const next = alias.charCodeAt(at + qd.length)
    if (!lastIsDigit || !(next >= 48 && next <= 57)) return true
    from = at
  }
}
