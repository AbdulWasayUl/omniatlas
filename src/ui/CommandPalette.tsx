import { useEffect, useMemo, useRef, useState } from 'react'
import type { AtlasViewer } from '../core/AtlasViewer'
import { classStyle } from '../data/objectClasses'
import { CATALOG } from '../data/catalog'
import { formatDistance } from '../format/units'
import { convertFrame, distance3d, vec3d } from '../core/world'
import { useViewStore } from '../state/useViewStore'
import { aliasContains, aliasesFor, foldDesignation } from './searchMatch'

/**
 * Search.
 *
 * The primary way into the atlas, replacing a nested directory. A directory is the
 * wrong shape once the catalogue spans planets to galaxies: nobody wants to expand
 * four levels to reach Europa.
 *
 * Ranking is tiered rather than fuzzy-scored, because for object names a prefix match
 * is almost always what was meant. Typing "mar" must give Mars before Mare Marginis.
 *
 * The other half of this component's job is telling the truth about COVERAGE. The
 * registry is 2,127 objects of which 1,029 are galaxies, 606 are stars and 29 are
 * solar-system bodies — yet an empty query used to list planets, stars and dwarf
 * planets only, capped at twelve, which in practice rendered as eight planets and
 * four stars. Every visitor who opened search before typing was shown a solar-system
 * directory and reasonably concluded that was the whole atlas. The suggestions below
 * span every scale the atlas reaches, in order, and the footer states the real size
 * of the catalogue.
 */

/** Scratch for the per-row frame conversion, hoisted so 40 rows cost no allocation. */
const SCRATCH = vec3d()

/**
 * The scopes, near to far. This is the same journey the scale ladder describes, which
 * is the one ordering of the catalogue a visitor already has a mental model for.
 *
 * `classes` is matched against `objectClass` for registry nodes and against `kind` for
 * static catalogue entries; the two vocabularies overlap but are not identical, so both
 * spellings that occur are listed rather than mapped.
 */
const SCOPES = [
  { id: 'all', label: 'Everything', classes: null },
  {
    id: 'solar',
    label: 'Solar system',
    classes: ['planet', 'dwarf-planet', 'moon', 'asteroid', 'comet', 'spacecraft', 'small-body-field'],
  },
  { id: 'stars', label: 'Stars', classes: ['star'] },
  { id: 'deepsky', label: 'Nebulae & clusters', classes: ['nebula', 'cluster'] },
  { id: 'galaxies', label: 'Galaxies', classes: ['galaxy'] },
  { id: 'exotic', label: 'Black holes', classes: ['black-hole'] },
] as const

type ScopeId = (typeof SCOPES)[number]['id']

/** Group order, near to far. A Map's insertion order is whatever the ranking happened
 *  to produce, which put "Galaxies" above "Planets" as soon as a galaxy outranked a
 *  planet by name length. */
const GROUP_ORDER = [
  'Planets',
  'Dwarf planets',
  'Moons',
  'Small bodies',
  'Stars',
  'Nebulae',
  'Star clusters',
  'Galaxies',
  'Black holes',
  'Other',
]

/**
 * Suggested destinations for an empty query, resolved BY NAME against whatever is
 * registered, with anything that does not resolve silently dropped.
 *
 * By name and not by id on purpose: every star is registered as `star:<row index>`
 * into the AT-HYG binary, so an id here would be a hard reference into a build
 * artifact and Sirius would become some other star the next time the catalogue is
 * rebuilt. Names are the stable key in the data, and a dropped suggestion costs one
 * row rather than a wrong destination.
 */
const SUGGESTIONS: { scope: Exclude<ScopeId, 'all'>; heading: string; names: string[] }[] = [
  {
    scope: 'solar',
    heading: 'In the solar system',
    names: ['Earth', 'Jupiter', 'Saturn', 'Europa', 'Titan', 'Pluto'],
  },
  {
    scope: 'stars',
    heading: 'Nearby and famous stars',
    names: ['Proxima Centauri', 'Sirius', 'Betelgeuse', 'Vega', 'Polaris'],
  },
  {
    scope: 'deepsky',
    heading: 'Nebulae and clusters',
    names: ['Great Orion Nebula', 'Pleiades', 'Crab Nebula', 'Eagle Nebula', 'Flame Nebula'],
  },
  {
    scope: 'galaxies',
    heading: 'Galaxies',
    names: ['Milky Way', 'Andromeda Galaxy', 'Large Magellanic Cloud', 'Triangulum Galaxy'],
  },
  {
    scope: 'exotic',
    heading: 'Black holes and quasars',
    names: ['Sagittarius A*', 'M87*', 'TON 618'],
  },
]

export function CommandPalette({ viewer, onClose }: { viewer: AtlasViewer | null; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<ScopeId>('all')
  // The cursor is stored against the query it belongs to, so changing the query
  // resets the highlight during render rather than in a follow-up effect that would
  // render once with a stale selection and then render again. The scope is part of
  // that key for the same reason: narrowing to Galaxies with the cursor on row 9 of
  // a 40-row list left it pointing past the end of a 3-row one.
  const [cursorState, setCursorState] = useState({ key: '', index: 0 })
  const cursorKey = `${scope}\u0000${query}`
  const cursor = cursorState.key === cursorKey ? cursorState.index : 0
  const setCursor = (next: number | ((current: number) => number)) =>
    setCursorState({ key: cursorKey, index: typeof next === 'function' ? next(cursor) : next })
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const select = useViewStore((state) => state.select)

  // Take focus on open and hand it back on close. Dropping it to <body> left the next
  // arrow keypress orbiting the camera instead of returning to the search button, and
  // left a screen-reader user at the top of the document with no announcement.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    inputRef.current?.focus()
    return () => opener?.focus?.()
  }, [])

  /**
   * Candidates come from the static catalogue plus whatever the engine has registered,
   * so modules that load their own objects become searchable without registering here.
   */
  const candidates = useMemo(() => {
    type Candidate = { id: string; name: string; kind: string; group: string; lower: string; aliases: string[] }
    const seen = new Map<string, Candidate>()
    const add = (id: string, name: string, kind: string, node: { designation?: string } | null) => {
      if (seen.has(id)) return
      seen.set(id, {
        id,
        name,
        kind,
        group: groupFor(kind),
        lower: name.toLowerCase(),
        aliases: aliasesFor(id, name, node),
      })
    }
    // The REGISTRY first, and it wins every collision. The static catalogue flattens
    // every notable object to `kind: 'star'` — `NOTABLE_ENTITIES` hard-codes it while
    // the source rows carry a real `objectClass` — so with the catalogue added first,
    // TON 618, M87* and Sagittarius A* all arrived as stars, took the star colour, and
    // were filed under Stars in the result list. The registry's `objectClass` is what
    // the renderer draws the object as, so it is also the honest thing to list it as.
    if (viewer) {
      for (const node of viewer.engine.registry.values()) {
        add(node.id, node.name, node.objectClass, node as { designation?: string })
      }
    }
    for (const entity of CATALOG) add(entity.id, entity.name, entity.kind, null)
    return [...seen.values()]
  }, [viewer])

  /** How many candidates each scope holds, so the chips can carry honest counts. */
  const scopeCounts = useMemo(() => {
    const counts: Record<string, number> = { all: candidates.length }
    for (const s of SCOPES) {
      if (!s.classes) continue
      const set = new Set<string>(s.classes)
      counts[s.id] = candidates.reduce((n, c) => n + (set.has(c.kind) ? 1 : 0), 0)
    }
    return counts
  }, [candidates])

  /** Index by name for the suggestion list. Built once, not searched per name. */
  const byName = useMemo(() => {
    const map = new Map<string, (typeof candidates)[number]>()
    for (const c of candidates) if (!map.has(c.name)) map.set(c.name, c)
    return map
  }, [candidates])

  const inScope = useMemo(() => {
    const classes = SCOPES.find((s) => s.id === scope)?.classes
    if (!classes) return candidates
    const set = new Set<string>(classes)
    return candidates.filter((c) => set.has(c.kind))
  }, [candidates, scope])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    // The designation form of the query. "ngc 224" and "NGC0224" are the same ask, and
    // the id tier used to compare a lowercased query against raw mixed-case ids, so the
    // uppercase catalogue part of 201 registered ids was unreachable by any query.
    const qd = foldDesignation(q)
    const scored: { item: (typeof candidates)[number]; tier: number }[] = []
    for (const item of inScope) {
      const name = item.lower
      let tier = -1
      if (name === q) tier = 0
      else if (item.aliases.includes(qd)) tier = 1
      else if (name.startsWith(q)) tier = 2
      else if (qd.length >= 2 && item.aliases.some((a) => a.startsWith(qd))) tier = 3
      else if (name.includes(` ${q}`)) tier = 4
      else if (name.includes(q)) tier = 5
      else if (item.aliases.some((a) => aliasContains(a, qd))) tier = 6
      if (tier >= 0) scored.push({ item, tier })
    }
    scored.sort((a, b) => a.tier - b.tier || a.item.name.length - b.item.name.length)
    return scored.slice(0, 40).map((s) => s.item)
  }, [query, inScope])

  /**
   * With no query and no scope, the list is the curated tour across every scale. This
   * is the view most visitors see first and it is the one that has to say "this is not
   * a solar-system app" without a sentence of marketing.
   *
   * Picking a scope with no query turns it into a browse instead: someone who clicked
   * "Black holes" wants the fourteen of them, not the three that happen to be in the
   * tour. Suggestions lead, so the famous ones stay at the top, and the rest follow in
   * catalogue order.
   */
  const suggested = useMemo(() => {
    if (query.trim()) return []
    if (scope === 'all') {
      return SUGGESTIONS.map((block) => ({
        heading: block.heading,
        items: block.names.map((n) => byName.get(n)).filter((c): c is (typeof candidates)[number] => !!c),
      }))
    }
    const block = SUGGESTIONS.find((s) => s.scope === scope)
    const lead = (block?.names ?? []).map((n) => byName.get(n)).filter((c): c is (typeof candidates)[number] => !!c)
    const leadIds = new Set(lead.map((c) => c.id))
    // Capped: "Galaxies" is 1,029 rows and this list is not a data grid. The footer
    // already states the full count, and typing narrows it.
    const rest = inScope.filter((c) => !leadIds.has(c.id)).slice(0, 60 - lead.length)
    return [{ heading: block?.heading ?? 'In the catalogue', items: [...lead, ...rest] }]
    // `candidates` is only named here for the type guard; `byName` is derived from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, scope, byName, inScope])

  const commit = (id: string) => {
    select(id)
    viewer?.focus(id)
    onClose()
  }

  const grouped = useMemo(() => {
    const map = new Map<string, typeof results>()
    for (const item of results) {
      const list = map.get(item.group) ?? []
      list.push(item)
      map.set(item.group, list)
    }
    return [...map.entries()].sort((a, b) => {
      const ai = GROUP_ORDER.indexOf(a[0])
      const bi = GROUP_ORDER.indexOf(b[0])
      return (ai < 0 ? GROUP_ORDER.length : ai) - (bi < 0 ? GROUP_ORDER.length : bi)
    })
  }, [results])

  /** Flat list in render order, so the arrow keys and Enter agree with what is on screen. */
  const flat = useMemo(
    () => (query.trim() ? grouped.flatMap(([, items]) => items) : suggested.flatMap((block) => block.items)),
    [query, grouped, suggested],
  )

  const sections = query.trim()
    ? grouped.map(([heading, items]) => ({ heading, items }))
    : suggested.filter((block) => block.items.length > 0)

  let flatIndex = -1

  const renderRow = (item: (typeof candidates)[number], index: number) => {
    const style = classStyle(item.kind)
    const node = viewer?.engine.node(item.id)
    // 3,038 NGC/IC objects have a direction and no measured distance, and
    // are drawn on a 100 kpc placeholder shell. The range to that shell is
    // a property of the shell, not of the object: printing it here put
    // "Horsehead Nebula 326 kly" two rows under "Flame Nebula 1.37 kly",
    // in the same column and the same type, 237x out and inviting exactly
    // that comparison. The Inspector says "to its shell projection" and has
    // the room to explain; a 12 px result row does not, so it says the one
    // thing that is true and prints no number.
    const shellProjection = (node as { directionOnly?: boolean } | undefined)?.directionOnly === true
    // Through the node's own frame, exactly as the Inspector does: nodes
    // are registered in four frames, and subtracting an ICRF or galactic
    // position from an ecliptic camera reads the obliquity as distance.
    // It listed Sagittarius A* at 38.6 kly with the camera 2.88 AU away.
    let distance: string | null = null
    if (node && viewer && !shellProjection) {
      convertFrame(SCRATCH, node.worldPosition, node.frame, viewer.engine.cameraFrame)
      distance = formatDistance(distance3d(viewer.engine.cameraWorld, SCRATCH)).text
    }
    return (
      <button
        type="button"
        key={item.id}
        className="palette-row"
        data-active={index === cursor}
        onPointerEnter={() => setCursor(index)}
        onClick={() => commit(item.id)}
      >
        <span className="class-dot" style={{ background: style.color }} aria-hidden="true" />
        <span className="palette-name">{item.name}</span>
        {/* The class, every row, in every scope. A result list of bare names gives
            no clue that "Maia" is a star and "Mel022" a cluster, which is most of
            why the catalogue read as smaller than it is. */}
        <span className="palette-class">{style.label}</span>
        {distance ? (
          <span className="palette-path num">{distance}</span>
        ) : shellProjection ? (
          <span className="palette-path">direction only</span>
        ) : (
          <span className="palette-path" />
        )}
      </button>
    )
  }

  return (
    <div
      className="palette-backdrop"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Search the atlas"
        ref={dialogRef}
        onKeyDown={(event) => {
          // aria-modal is a promise to assistive tech, not a behaviour: without a trap
          // Tab walks straight out of the dialog into the page behind it.
          if (event.key !== 'Tab') return
          const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
            'input, button, [href], [tabindex]:not([tabindex="-1"])',
          )
          if (!focusables || focusables.length === 0) return
          const first = focusables[0]
          const last = focusables[focusables.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }}
      >
        <div className="palette-input">
          <svg className="search-glyph" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="7" cy="7" r="4.6" stroke="currentColor" strokeWidth="1.3" />
            <path d="M10.4 10.4 14 14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            placeholder="Planets, moons, stars, nebulae, galaxies, black holes"
            aria-label="Search the atlas"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setCursor((c) => Math.min(c + 1, flat.length - 1))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setCursor((c) => Math.max(c - 1, 0))
              } else if (event.key === 'Enter' && flat[cursor]) {
                event.preventDefault()
                commit(flat[cursor].id)
              } else if (event.key === 'Escape') {
                // React delegates this to #root, so it bubbles to AppChrome's window
                // listener in the same tick. Without stopping it, the palette's own close
                // and the chrome's layered Escape both fire and the selection behind the
                // palette is cleared along with it.
                event.stopPropagation()
                onClose()
              }
            }}
          />
        </div>

        {/* The scopes are a filter, and they are also the only place the product
            enumerates what it holds. Even untouched they answer the question the old
            empty state answered wrongly. */}
        <div className="palette-scopes" role="group" aria-label="Limit the search">
          {SCOPES.map((s) => (
            <button
              type="button"
              key={s.id}
              className="scope-chip"
              aria-pressed={scope === s.id}
              onClick={() => setScope(s.id)}
            >
              {s.label}
              <span className="scope-count num">{(scopeCounts[s.id] ?? 0).toLocaleString('en-GB')}</span>
            </button>
          ))}
        </div>

        <div className="palette-results">
          {query.trim() && results.length === 0 && (
            <div className="palette-empty">
              <p>Nothing in “{scope === 'all' ? 'the atlas' : SCOPES.find((s) => s.id === scope)?.label}” matches “{query}”.</p>
              {scope !== 'all' && (
                <button type="button" className="chip" onClick={() => setScope('all')}>
                  Search everything instead
                </button>
              )}
            </div>
          )}

          {sections.map((section) => (
            <div key={section.heading}>
              <div className="palette-group">{section.heading}</div>
              {section.items.map((item) => {
                flatIndex += 1
                return renderRow(item, flatIndex)
              })}
            </div>
          ))}
        </div>

        {/* The honest size of the catalogue, always visible. The old copy — "the atlas
            covers the solar system and 329,860 catalogued stars" — appeared only on a
            failed search, named two of the eight things in here, and is the sentence
            the whole misreading came from. */}
        <div className="palette-footer">
          <span>
            {candidates.length.toLocaleString('en-GB')} named objects, from moons to the cosmic web.
          </span>
          <span className="palette-keys">
            <kbd>↑</kbd>
            <kbd>↓</kbd> to move
            <kbd>↵</kbd> to fly
          </span>
        </div>
      </div>
    </div>
  )
}

function groupFor(kind: string): string {
  switch (kind) {
    case 'star':
      return 'Stars'
    case 'planet':
      return 'Planets'
    case 'dwarf-planet':
      return 'Dwarf planets'
    case 'moon':
      return 'Moons'
    case 'asteroid':
    case 'small-body-field':
      return 'Small bodies'
    case 'comet':
      return 'Small bodies'
    case 'galaxy':
      return 'Galaxies'
    case 'nebula':
      return 'Nebulae'
    case 'cluster':
      return 'Star clusters'
    case 'black-hole':
      return 'Black holes'
    default:
      return 'Other'
  }
}
