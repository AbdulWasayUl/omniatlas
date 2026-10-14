import { useEffect, useMemo, useRef, useState } from 'react'
import type { AtlasViewer } from '../core/AtlasViewer'
import { classStyle } from '../data/objectClasses'
import { CATALOG } from '../data/catalog'
import { formatDistance } from '../format/units'
import { distance3d } from '../core/world'
import { useViewStore } from '../state/useViewStore'

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
  const select = useViewStore((state) => state.select)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  /**
   * Candidates come from the static catalogue plus whatever the engine has registered,
   * so modules that load their own objects become searchable without registering here.
   */
  const candidates = useMemo(() => {
    const seen = new Map<string, { id: string; name: string; kind: string; group: string }>()
    for (const entity of CATALOG) {
      seen.set(entity.id, { id: entity.id, name: entity.name, kind: entity.kind, group: groupFor(entity.kind) })
    }
    if (viewer) {
      for (const node of viewer.engine.registry.values()) {
        if (!seen.has(node.id)) {
          seen.set(node.id, { id: node.id, name: node.name, kind: node.objectClass, group: groupFor(node.objectClass) })
        }
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
    const scored: { item: (typeof candidates)[number]; tier: number }[] = []
    for (const item of candidates) {
      const name = item.name.toLowerCase()
      let tier = -1
      if (name === q) tier = 0
      else if (name.startsWith(q)) tier = 1
      else if (name.includes(` ${q}`)) tier = 2
      else if (name.includes(q)) tier = 3
      else if (item.id.includes(q)) tier = 4
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
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search the atlas">
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
                const distance =
                  node && viewer ? formatDistance(distance3d(viewer.engine.cameraWorld, node.worldPosition)).text : null
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
                    {distance && <span className="palette-path num">{distance}</span>}
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
