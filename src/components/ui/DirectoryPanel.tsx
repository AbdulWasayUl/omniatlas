import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BODIES,
  CATALOG,
  type AtlasEntity,
  type EntityKind,
} from '../../data/catalog'
import { useExplorerStore } from '../../store/useExplorerStore'

type BodyId = AtlasEntity['bodyId']

const categoryNames: Partial<Record<EntityKind, string>> = {
  continent: 'Continents',
  'impact structure': 'Impact structures',
  crater: 'Named craters',
}

function entitySymbol(entity: AtlasEntity) {
  if (entity.kind === 'star') return '☼'
  if (entity.kind === 'planet' || entity.kind === 'moon') return '●'
  return '⊙'
}

function EntityRow({
  entity,
  onClick,
  action = 'Open',
}: {
  entity: AtlasEntity
  onClick: () => void
  action?: string
}) {
  return (
    <button type="button" className="directory-row" onClick={onClick}>
      <span className={`object-symbol object-symbol--${entity.bodyId}`}>
        {entitySymbol(entity)}
      </span>
      <span className="directory-row-copy">
        <strong>{entity.name}</strong>
        <small>{entity.eyebrow}</small>
      </span>
      <span className="directory-kind">{entity.kind}</span>
      <span className="directory-arrow" aria-hidden="true">
        {action === 'Browse' ? '›' : '↗'}
      </span>
    </button>
  )
}

export function DirectoryPanel() {
  const open = useExplorerStore((state) => state.directoryOpen)
  const setOpen = useExplorerStore((state) => state.setDirectoryOpen)
  const inspect = useExplorerStore((state) => state.inspect)
  const [query, setQuery] = useState('')
  const [bodyId, setBodyId] = useState<BodyId | null>(null)
  const [category, setCategory] = useState<EntityKind | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => {
      setQuery('')
      setBodyId(null)
      setCategory(null)
      inputRef.current?.focus()
    }, 50)
    return () => window.clearTimeout(timer)
  }, [open])

  const normalizedQuery = query.trim().toLowerCase()
  const searchResults = useMemo(() => {
    if (!normalizedQuery) return []
    return CATALOG.filter((entity) =>
      `${entity.name} ${entity.eyebrow} ${entity.kind}`
        .toLowerCase()
        .includes(normalizedQuery),
    )
  }, [normalizedQuery])

  const body = BODIES.find((entity) => entity.bodyId === bodyId) ?? null
  const bodyObjects = body
    ? CATALOG.filter((entity) => entity.parentId === body.id)
    : []
  const categories = [...new Set(bodyObjects.map((entity) => entity.kind))]
  const categoryObjects = category
    ? bodyObjects.filter((entity) => entity.kind === category)
    : []
  const title = normalizedQuery
    ? 'Search results'
    : category
      ? categoryNames[category] ?? category
      : body?.name ?? 'Solar System'
  const breadcrumb = [
    'Solar System',
    body?.name,
    category ? categoryNames[category] ?? category : null,
  ].filter(Boolean)

  const goBack = () => {
    if (normalizedQuery) setQuery('')
    else if (category) setCategory(null)
    else setBodyId(null)
  }

  const hasBack = Boolean(normalizedQuery || bodyId || category)

  if (!open) return null

  return (
    <div className="directory-backdrop" onMouseDown={() => setOpen(false)}>
      <section
        id="object-directory"
        className="directory-panel panel"
        aria-label="Object directory"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="directory-header">
          <div className="directory-heading">
            {hasBack && (
              <button
                className="directory-back"
                type="button"
                onClick={goBack}
                aria-label="Go back one directory level"
              >
                ←
              </button>
            )}
            <div>
              <p className="kicker">{breadcrumb.join(' / ')}</p>
              <h2>{title}</h2>
            </div>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close directory"
          >
            ×
          </button>
        </header>

        <label className="directory-search">
          <span aria-hidden="true">⌕</span>
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search the Solar System catalogue…"
          />
          <kbd>/</kbd>
        </label>

        <div className="directory-meta">
          <span>
            {normalizedQuery
              ? `${searchResults.length} matches across the system`
              : category
                ? `${categoryObjects.length} objects`
                : body
                  ? `${bodyObjects.length} child objects`
                  : `${BODIES.length} bodies`}
          </span>
          <span>Hierarchical catalogue</span>
        </div>

        <div className="directory-results">
          {normalizedQuery ? (
            searchResults.length ? (
              searchResults.map((entity) => (
                <EntityRow
                  key={entity.id}
                  entity={entity}
                  onClick={() => inspect(entity.id, entity.bodyId)}
                />
              ))
            ) : (
              <div className="empty-state">
                <strong>No local match</strong>
                <span>Try a body, continent, crater, or impact structure.</span>
              </div>
            )
          ) : category ? (
            categoryObjects.map((entity) => (
              <EntityRow
                key={entity.id}
                entity={entity}
                onClick={() => inspect(entity.id, entity.bodyId)}
              />
            ))
          ) : body ? (
            <>
              <EntityRow
                entity={body}
                onClick={() => inspect(body.id, body.bodyId)}
              />
              {categories.map((kind) => {
                const count = bodyObjects.filter((entity) => entity.kind === kind).length
                return (
                  <button
                    type="button"
                    className="directory-row directory-folder"
                    key={kind}
                    onClick={() => setCategory(kind)}
                  >
                    <span className="directory-folder-icon" aria-hidden="true">⌑</span>
                    <span className="directory-row-copy">
                      <strong>{categoryNames[kind] ?? kind}</strong>
                      <small>{count} objects in {body.name}</small>
                    </span>
                    <span className="directory-kind">Collection</span>
                    <span className="directory-arrow" aria-hidden="true">›</span>
                  </button>
                )
              })}
            </>
          ) : (
            BODIES.map((entity) => (
              <EntityRow
                key={entity.id}
                entity={entity}
                action="Browse"
                onClick={() => setBodyId(entity.bodyId)}
              />
            ))
          )}
        </div>

        <footer className="directory-footer">
          <span>Current path</span>
          <strong>{breadcrumb.join(' › ')}</strong>
          <span className="status-dot">{CATALOG.length} records</span>
        </footer>
      </section>
    </div>
  )
}
