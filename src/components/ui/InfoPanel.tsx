import { findEntity } from '../../data/catalog'
import { useExplorerStore } from '../../store/useExplorerStore'

export function InfoPanel() {
  const selectedId = useExplorerStore((state) => state.selectedId)
  const select = useExplorerStore((state) => state.select)
  const entity = findEntity(selectedId)

  if (!entity) return null

  return (
    <aside className="info-panel panel" aria-label={`${entity.name} details`}>
      <header className="info-header">
        <div className="info-heading">
          <span className={`object-symbol object-symbol--${entity.bodyId}`}>
            {entity.kind === 'star' ? '☼' : entity.kind === 'planet' || entity.kind === 'moon' ? '●' : '⊙'}
          </span>
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
