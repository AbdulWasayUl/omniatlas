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
 */

/** Scratch for the per-row frame conversion, hoisted so 40 rows cost no allocation. */
const SCRATCH = vec3d()

export function CommandPalette({ viewer, onClose }: { viewer: AtlasViewer | null; onClose: () => void }) {
  const [query, setQuery] = useState('')
  // The cursor is stored against the query it belongs to, so changing the query
  // resets the highlight during render rather than in a follow-up effect that would
  // render once with a stale selection and then render again.
  const [cursorState, setCursorState] = useState({ query: '', index: 0 })
  const cursor = cursorState.query === query ? cursorState.index : 0
  const setCursor = (next: number | ((current: number) => number)) =>
    setCursorState({ query, index: typeof next === 'function' ? next(cursor) : next })
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
    for (const entity of CATALOG) add(entity.id, entity.name, entity.kind, null)
    if (viewer) {
      for (const node of viewer.engine.registry.values()) {
        add(node.id, node.name, node.objectClass, node as { designation?: string })
      }
    }
    return [...seen.values()]
  }, [viewer])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) {
      return candidates
        .filter((c) => c.kind === 'planet' || c.kind === 'star' || c.kind === 'dwarf-planet')
        .slice(0, 12)
    }
    // The designation form of the query. "ngc 224" and "NGC0224" are the same ask, and
    // the id tier used to compare a lowercased query against raw mixed-case ids, so the
    // uppercase catalogue part of 201 registered ids was unreachable by any query.
    const qd = foldDesignation(q)
    const scored: { item: (typeof candidates)[number]; tier: number }[] = []
    for (const item of candidates) {
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
  }, [query, candidates])

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
    return [...map.entries()]
  }, [results])

  let flatIndex = -1

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
        <input
          ref={inputRef}
          value={query}
          placeholder="Search planets, moons, stars…"
          aria-label="Search the atlas"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setCursor((c) => Math.min(c + 1, results.length - 1))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setCursor((c) => Math.max(c - 1, 0))
            } else if (event.key === 'Enter' && results[cursor]) {
              event.preventDefault()
              commit(results[cursor].id)
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

        <div className="palette-results">
          {results.length === 0 && (
            <div className="palette-empty">
              Nothing in the current catalogue matches “{query}”.
              <br />
              The atlas covers the solar system and {(329_860).toLocaleString('en-GB')} catalogued stars.
            </div>
          )}

          {grouped.map(([group, items]) => (
            <div key={group}>
              <div className="palette-group">{group}</div>
              {items.map((item) => {
                flatIndex += 1
                const index = flatIndex
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
                    {distance ? (
                      <span className="palette-path num">{distance}</span>
                    ) : shellProjection ? (
                      <span className="palette-path">direction only</span>
                    ) : null}
                  </button>
                )
              })}
            </div>
          ))}
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
    case 'galaxy':
      return 'Galaxies'
    case 'nebula':
      return 'Nebulae'
    default:
      return 'Other'
  }
}
