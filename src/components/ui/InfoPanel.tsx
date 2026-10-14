import { useMemo } from 'react'
import {
  CITIES_URL,
  COUNTRIES_URL,
  MOON_CRATERS_URL,
  cityToEntity,
  countryToEntity,
  craterToEntity,
  findEntity,
  type AtlasEntity,
  type CityRecord,
  type CountryRecord,
  type CraterRecord,
} from '../../data/catalog'
import { useRemoteJson } from '../../data/remoteAssets'
import { useExplorerStore } from '../../store/useExplorerStore'

function symbolFor(entity: AtlasEntity) {
  if (entity.kind === 'star') return '☼'
  if (entity.kind === 'planet' || entity.kind === 'moon' || entity.kind === 'dwarf-planet') return '●'
  if (entity.kind === 'country') return '▧'
  if (entity.kind === 'city') return '◈'
  return '⊙'
}

export function InfoPanel() {
  const selectedId = useExplorerStore((state) => state.selectedId)
  const select = useExplorerStore((state) => state.select)

  const countries = useRemoteJson<CountryRecord[]>(COUNTRIES_URL)
  const cities = useRemoteJson<CityRecord[]>(CITIES_URL)
  const craters = useRemoteJson<CraterRecord[]>(MOON_CRATERS_URL)

  const entity = useMemo<AtlasEntity | null>(() => {
    if (!selectedId) return null
    const staticEntity = findEntity(selectedId)
    if (staticEntity) return staticEntity
    const country = countries?.find((item) => item.id === selectedId)
    if (country) return countryToEntity(country)
    const city = cities?.find((item) => item.id === selectedId)
    if (city) return cityToEntity(city)
    const crater = craters?.find((item) => item.id === selectedId)
    if (crater) return craterToEntity(crater)
    return null
  }, [selectedId, countries, cities, craters])

  if (!entity) return null

  return (
    <aside className="info-panel panel" aria-label={`${entity.name} details`}>
      <header className="info-header">
        <div className="info-heading">
          <span className={`object-symbol object-symbol--${entity.bodyId}`}>{symbolFor(entity)}</span>
          <div>
            <p className="kicker">{entity.eyebrow}</p>
            <h2>{entity.name}</h2>
          </div>
        </div>
        <button className="icon-button" type="button" onClick={() => select(null)} aria-label="Close details">
          ×
        </button>
      </header>

      <div className="info-body">
        <p className="entity-description">{entity.description}</p>
        <div className="fact-list">
          {entity.facts.map((fact) => (
            <div className="fact-row" key={fact.label}>
              <span>{fact.label}</span>
              <strong>{fact.value}</strong>
            </div>
          ))}
        </div>
      </div>

      <footer className="info-footer">
        <span>Primary reference</span>
        <a href={entity.source.url} target="_blank" rel="noreferrer">
          {entity.source.label} <span aria-hidden="true">↗</span>
        </a>
      </footer>
    </aside>
  )
}
