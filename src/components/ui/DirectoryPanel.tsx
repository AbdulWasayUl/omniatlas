import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BODIES,
  CATALOG,
  CITIES_URL,
  COUNTRIES_URL,
  MOON_CRATERS_URL,
  NOTABLE_SMALL_BODIES,
  cityToEntity,
  countryToEntity,
  craterToEntity,
  findEntity,
  moonsOf,
  type AtlasEntity,
  type CityRecord,
  type CountryRecord,
  type CraterRecord,
} from '../../data/catalog'
import { useRemoteJson } from '../../data/remoteAssets'
import { useExplorerStore } from '../../store/useExplorerStore'

function entitySymbol(entity: AtlasEntity) {
  if (entity.kind === 'star') return '☼'
  if (entity.kind === 'planet' || entity.kind === 'moon' || entity.kind === 'dwarf-planet') return '●'
  if (entity.kind === 'country') return '▧'
  if (entity.kind === 'city') return '◈'
  return '⊙'
}

interface Category {
  key: string
  label: string
  count: number
}

function EntityRow({
  entity,
  onClick,
  action = 'Open',
}: {
  entity: AtlasEntity
  onClick: () => void
  action?: 'Open' | 'Browse'
}) {
  return (
    <button type="button" className="directory-row" onClick={onClick}>
      <span className={`object-symbol object-symbol--${entity.bodyId}`}>{entitySymbol(entity)}</span>
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

function CategoryRow({ label, count, onClick }: { label: string; count: number; onClick: () => void }) {
  return (
    <button type="button" className="directory-row directory-folder" onClick={onClick}>
      <span className="directory-folder-icon" aria-hidden="true">⌑</span>
      <span className="directory-row-copy">
        <strong>{label}</strong>
        <small>{count} objects</small>
      </span>
      <span className="directory-kind">Collection</span>
      <span className="directory-arrow" aria-hidden="true">›</span>
    </button>
  )
}

export function DirectoryPanel() {
  const open = useExplorerStore((state) => state.directoryOpen)
  const setOpen = useExplorerStore((state) => state.setDirectoryOpen)
  const inspect = useExplorerStore((state) => state.inspect)
  const [query, setQuery] = useState('')
  const [bodyPath, setBodyPath] = useState<string[]>([])
  const [category, setCategory] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const countries = useRemoteJson<CountryRecord[]>(COUNTRIES_URL)
  const cities = useRemoteJson<CityRecord[]>(CITIES_URL)
  const craters = useRemoteJson<CraterRecord[]>(MOON_CRATERS_URL)

  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => {
      setQuery('')
      setBodyPath([])
      setCategory(null)
      inputRef.current?.focus()
    }, 50)
    return () => window.clearTimeout(timer)
  }, [open])

  const normalizedQuery = query.trim().toLowerCase()

  const searchResults = useMemo(() => {
    if (!normalizedQuery) return []
    const staticMatches = CATALOG.filter((entity) =>
      `${entity.name} ${entity.eyebrow} ${entity.kind}`.toLowerCase().includes(normalizedQuery),
    )
    const countryMatches = (countries ?? [])
      .filter((item) => item.name.toLowerCase().includes(normalizedQuery))
      .slice(0, 40)
      .map(countryToEntity)
    const cityMatches = (cities ?? [])
      .filter((item) => item.name.toLowerCase().includes(normalizedQuery))
      .slice(0, 40)
      .map(cityToEntity)
    const craterMatches = (craters ?? [])
      .filter((item) => item.name.toLowerCase().includes(normalizedQuery))
      .slice(0, 40)
      .map(craterToEntity)
    return [...staticMatches, ...countryMatches, ...cityMatches, ...craterMatches].slice(0, 150)
  }, [normalizedQuery, countries, cities, craters])

  const currentBodyId = bodyPath[bodyPath.length - 1] ?? null
  const currentBody = currentBodyId ? findEntity(currentBodyId) : null

  const categoriesForCurrentBody = useMemo<Category[]>(() => {
    if (!currentBodyId) return []
    const list: Category[] = []
    const moons = moonsOf(currentBodyId)
    const moonCount = moons.length + (currentBodyId === 'earth' ? 1 : 0)
    if (moonCount > 0) list.push({ key: 'moons', label: 'Moons', count: moonCount })
    if (currentBodyId === 'earth') {
      list.push({ key: 'countries', label: 'Countries', count: countries?.length ?? 0 })
      list.push({ key: 'cities', label: 'Cities', count: cities?.length ?? 0 })
    }
    if (currentBodyId === 'moon') {
      list.push({ key: 'craters', label: 'Named craters', count: craters?.length ?? 0 })
    }
    if (currentBodyId === 'sun') {
      list.push({ key: 'small-bodies', label: 'Notable small bodies', count: NOTABLE_SMALL_BODIES.length })
    }
    return list
  }, [currentBodyId, countries, cities, craters])

  function hasChildren(bodyId: string): boolean {
    if (bodyId === 'earth' || bodyId === 'moon') return true
    if (bodyId === 'sun') return true
    return moonsOf(bodyId).length > 0
  }

  const categoryItems: AtlasEntity[] = useMemo(() => {
    if (!currentBodyId || !category) return []
    if (category === 'moons') {
      const moons = moonsOf(currentBodyId)
      return currentBodyId === 'earth' ? [...CATALOG.filter((e) => e.id === 'moon'), ...moons] : moons
    }
    if (category === 'countries') return (countries ?? []).map(countryToEntity)
    if (category === 'cities') return (cities ?? []).map(cityToEntity)
    if (category === 'craters') return (craters ?? []).map(craterToEntity)
    if (category === 'small-bodies') return NOTABLE_SMALL_BODIES
    return []
  }, [currentBodyId, category, countries, cities, craters])

  const title = normalizedQuery
    ? 'Search results'
    : category
      ? (categoriesForCurrentBody.find((entry) => entry.key === category)?.label ?? category)
      : (currentBody?.name ?? 'Solar System')

  const breadcrumb = [
    'Solar System',
    ...bodyPath.map((id) => findEntity(id)?.name ?? id),
    category ? categoriesForCurrentBody.find((c) => c.key === category)?.label : null,
  ].filter(Boolean) as string[]

  const goBack = () => {
    if (normalizedQuery) {
      setQuery('')
    } else if (category) {
      setCategory(null)
    } else if (bodyPath.length) {
      setBodyPath((path) => path.slice(0, -1))
    }
  }

  const hasBack = Boolean(normalizedQuery || category || bodyPath.length)

  function enterBody(id: string) {
    setBodyPath((path) => [...path, id])
    setCategory(null)
  }

  function openEntity(entity: AtlasEntity) {
    inspect(entity.id, entity.bodyId)
  }

  function rowAction(entity: AtlasEntity): 'Open' | 'Browse' {
    return hasChildren(entity.id) ? 'Browse' : 'Open'
  }

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
              <button className="directory-back" type="button" onClick={goBack} aria-label="Go back one directory level">
                ←
              </button>
            )}
            <div>
              <p className="kicker">{breadcrumb.join(' / ')}</p>
              <h2>{title}</h2>
            </div>
          </div>
          <button className="icon-button" type="button" onClick={() => setOpen(false)} aria-label="Close directory">
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
            placeholder="Search planets, moons, countries, cities, craters…"
          />
          <kbd>/</kbd>
        </label>

        <div className="directory-meta">
          <span>
            {normalizedQuery
              ? `${searchResults.length} matches`
              : category
                ? `${categoryItems.length} objects`
                : currentBody
                  ? `${categoriesForCurrentBody.length} collections`
                  : `${BODIES.length} bodies`}
          </span>
          <span>Hierarchical catalogue</span>
        </div>

        <div className="directory-results">
          {normalizedQuery ? (
            searchResults.length ? (
              searchResults.map((entity) => (
                <EntityRow key={entity.id} entity={entity} onClick={() => openEntity(entity)} />
              ))
            ) : (
              <div className="empty-state">
                <strong>No match</strong>
                <span>Try a planet, moon, country, city, or crater name.</span>
              </div>
            )
          ) : category ? (
            categoryItems.map((entity) => (
              <EntityRow
                key={entity.id}
                entity={entity}
                action={rowAction(entity)}
                onClick={() => (rowAction(entity) === 'Browse' ? enterBody(entity.id) : openEntity(entity))}
              />
            ))
          ) : currentBody ? (
            <>
              <EntityRow entity={currentBody} onClick={() => openEntity(currentBody)} />
              {categoriesForCurrentBody.map((entry) => (
                <CategoryRow
                  key={entry.key}
                  label={entry.label}
                  count={entry.count}
                  onClick={() => setCategory(entry.key)}
                />
              ))}
            </>
          ) : (
            BODIES.map((entity) => (
              <EntityRow key={entity.id} entity={entity} action="Browse" onClick={() => enterBody(entity.id)} />
            ))
          )}
        </div>

        <footer className="directory-footer">
          <span>Current path</span>
          <strong>{breadcrumb.join(' › ')}</strong>
          <span className="status-dot">
            {(countries?.length ?? 0) + (cities?.length ?? 0) + (craters?.length ?? 0) + CATALOG.length} records
          </span>
        </footer>
      </section>
    </div>
  )
}
