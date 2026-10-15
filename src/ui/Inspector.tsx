import type { AtlasViewer } from '../core/AtlasViewer'
import { classStyle } from '../data/objectClasses'
import { findEntity } from '../data/catalog'
import { formatDistance } from '../format/units'
import { convertFrame, distance3d, vec3d } from '../core/world'
import { useViewStore } from '../state/useViewStore'

/**
 * The object inspector.
 *
 * Opaque and edge-docked rather than a floating translucent card: over a lit Blue
 * Marble, translucent panel text loses its contrast entirely, and the blur behind it
 * costs a compositor readback of the WebGL layer every frame.
 */
export function Inspector({ viewer }: { viewer: AtlasViewer | null }) {
  const selectedId = useViewStore((state) => state.selectedId)
  const snapshot = useViewStore((state) => state.snapshot)
  const select = useViewStore((state) => state.select)

  if (!selectedId) return null
  const entity = findEntity(selectedId)
  const node = viewer?.engine.node(selectedId) ?? null
  if (!entity && !node) return null

  const name = entity?.name ?? node?.name ?? selectedId
  const style = classStyle(node?.objectClass ?? entity?.kind ?? 'planet')

  // A node with no Three.js object of its own is drawn by the proxy module, which
  // builds a shape from the catalogue radius alone. Say so rather than letting the
  // Measured chip cover the geometry as well as the astrometry.
  const illustratedShape = !!node && !node.object3D && node.radiusMetres > 0
  // The VSOP87/ELP note is true of the planets and moons and of nothing else.
  const ephemerisBody = !!entity && node?.layer === 'helio' && !illustratedShape

  // Live distance from the camera to this object, which is more useful than a
  // catalogue separation because it answers "how far am I from it right now".
  let distanceText: string | null = null
  if (viewer && node) {
    // Through the node's own frame first. Measuring an ICRF or galactic position
    // against an ecliptic camera position reads the obliquity as distance: it put
    // Sagittarius A* 38.6 kly away while the camera sat 2.8 AU from it.
    const nodeInCameraFrame = convertFrame(vec3d(), node.worldPosition, node.frame, viewer.engine.cameraFrame)
    distanceText = formatDistance(distance3d(viewer.engine.cameraWorld, nodeInCameraFrame)).text
  }

  return (
    <aside className="inspector" id="inspector-region" aria-label={`${name} details`}>
      <div className="inspector-head">
        <div className="inspector-class">
          <span className="class-dot" style={{ background: style.color }} aria-hidden="true" />
          <span className="kicker">{entity?.eyebrow ?? style.label}</span>
        </div>
        <h2 className="inspector-title">{name}</h2>
        {distanceText && (
          <div className="hud-sub num" style={{ marginTop: 4 }}>
            {distanceText} from here
          </div>
        )}
      </div>

      <div className="inspector-body">
        {entity?.description && <p className="inspector-prose">{entity.description}</p>}

        <div className="chip-row">
          <button
            type="button"
            className="chip"
            onClick={() => viewer?.focus(selectedId)}
          >
            Fly here
          </button>
          <button type="button" className="chip" onClick={() => select(null)}>
            Close
          </button>
        </div>

        {entity?.facts && entity.facts.length > 0 && (
          <>
            <div className="section-head">Measurements</div>
            <div className="fact-grid">
              {entity.facts.map((fact) => (
                <div key={fact.label} style={{ display: 'contents' }}>
                  <span className="fact-label">{fact.label}</span>
                  <span className="fact-value">{fact.value}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {node && (
          <>
            <div className="section-head">Position</div>
            <div className="fact-grid">
              <span className="fact-label">Reference frame</span>
              <span className="fact-value">{node.frame === 'ecliptic' ? 'J2000 ecliptic' : node.frame.toUpperCase()}</span>
              <span className="fact-label">Mean radius</span>
              <span className="fact-value">
                {node.radiusMetres > 0 ? formatDistance(node.radiusMetres).text : '—'}
              </span>
              {snapshot && (
                <>
                  <span className="fact-label">Epoch</span>
                  <span className="fact-value">{new Date(snapshot.epochMs).toISOString().slice(0, 19)}Z</span>
                </>
              )}
            </div>
          </>
        )}

        <div className="section-head">Evidence</div>
        <div className="chip-row" style={{ marginBottom: 10 }}>
          <span className="provenance" data-kind="measured">
            Measured
          </span>
          {illustratedShape && (
            <span className="provenance" data-kind="illustration">
              Illustrated shape
            </span>
          )}
        </div>
        {entity?.source && (
          <a className="source-link" href={entity.source.url} target="_blank" rel="noreferrer noopener">
            {entity.source.label} ↗
          </a>
        )}
        {ephemerisBody && (
          <p className="hud-sub" style={{ marginTop: 10 }}>
            Position and orientation computed for the displayed instant from astronomy-engine's VSOP87 and ELP
            models and the IAU 2015 rotation elements.
          </p>
        )}
        {illustratedShape && (
          <p className="hud-sub" style={{ marginTop: 10 }}>
            Position and size are measured. The shape you are looking at is not: no resolved image or shape
            model of this object ships with the atlas, so it is drawn from its catalogue radius and a hash of
            its own name. It is the same on every visit, and it is not a picture of this object.
          </p>
        )}
      </div>
    </aside>
  )
}
