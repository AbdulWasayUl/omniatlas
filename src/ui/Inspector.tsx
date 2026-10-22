import type { CSSProperties } from 'react'
import type { AtlasViewer } from '../core/AtlasViewer'
import type { SceneNodeHandle } from '../core/Engine'
import { classStyle } from '../data/objectClasses'
import { findEntity } from '../data/catalog'
import { DISTANCE_KIND_LABEL, type DistanceKind, formatDistance } from '../format/units'
import type { Provenance } from '../data/scaleLadder'
import { convertFrame, distance3d, vec3d } from '../core/world'
import { useViewStore } from '../state/useViewStore'

/**
 * The honesty fields the catalogue modules already write onto their nodes.
 *
 * They are not on `SceneNodeHandle` yet — `CosmosNode` and `DeepSkyNode` widen it
 * privately — so they are read structurally here rather than being invented. 1,183 of
 * the registry's nodes carry `provenance` and 868 carry `distanceKind` today, and until
 * this panel read them the one chip the product's claim rests on said "Measured" on all
 * of them, including the 35 objects placed on a 100 kpc direction-only shell.
 */
interface NodeProvenance {
  provenance?: Provenance
  distanceKind?: DistanceKind
  /** Only the direction is known: the position is a projection onto a placeholder shell. */
  directionOnly?: boolean
  /** Something the user must be told about this specific object. */
  caveat?: string
  /** A sentence about how the class, rather than the object, was treated. */
  provenanceNote?: string
  distanceSource?: string
}

/** What the Evidence chip should say, derived from the node rather than asserted. */
function provenanceChip(node: (SceneNodeHandle & NodeProvenance) | null): { kind: Provenance; text: string } | null {
  if (!node) return null
  // A shell projection is a direction with a placeholder depth. Nothing derived from
  // it — not the distance, not the size — is a measurement of this object.
  if (node.directionOnly) return { kind: 'illustration', text: 'Direction only' }
  const suffix = node.distanceKind ? ` · ${DISTANCE_KIND_LABEL[node.distanceKind]}` : ''
  if (node.provenance) {
    const text = node.provenance === 'measured' ? 'Measured' : node.provenance === 'derived' ? 'Derived' : 'Illustrated'
    return { kind: node.provenance, text: `${text}${suffix}` }
  }
  if (node.distanceKind) {
    const kind: Provenance = node.distanceKind === 'geometric' ? 'measured' : 'derived'
    return { kind, text: `${kind === 'measured' ? 'Measured' : 'Derived'}${suffix}` }
  }
  // The helio bodies are the one set whose astrometry is computed rather than
  // catalogued, and they are the only ones a bare node may still claim for. Anything
  // else that says nothing about itself gets no chip: silence beats a false claim.
  if (node.layer === 'helio') return { kind: 'measured', text: 'Measured' }
  return null
}

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
  const node = (viewer?.engine.node(selectedId) ?? null) as (SceneNodeHandle & NodeProvenance) | null
  if (!entity && !node) return null

  const name = entity?.name ?? node?.name ?? selectedId
  const style = classStyle(node?.objectClass ?? entity?.kind ?? 'planet')

  // A node with no Three.js object of its own is drawn by the proxy module, which
  // builds a shape from the catalogue radius alone. Say so rather than letting the
  // Measured chip cover the geometry as well as the astrometry.
  const illustratedShape = !!node && !node.object3D && node.radiusMetres > 0
  // The VSOP87/ELP note is true of the planets and moons and of nothing else.
  const ephemerisBody = !!entity && node?.layer === 'helio' && !illustratedShape
  const chip = provenanceChip(node)
  const directionOnly = node?.directionOnly === true
  const radiusInFacts = !!entity?.facts?.some((fact) => /radius/i.test(fact.label))

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

  // Flying to the object you are already anchored on is a no-op dressed as a
  // journey. The button says so rather than running a zero-length flight.
  const alreadyHere = snapshot?.anchorId === selectedId

  return (
    <aside
      className="inspector"
      id="inspector-region"
      aria-label={`${name} details`}
      // Picked up by the edge hairline and the class dot's halo. Set here rather
      // than on each element so one assignment colours the whole drawer.
      style={{ '--class-accent': style.color } as CSSProperties}
    >
      <div className="inspector-head">
        <div className="inspector-class">
          <span className="class-dot" style={{ background: style.color }} aria-hidden="true" />
          <span className="kicker">{entity?.eyebrow ?? style.label}</span>
        </div>
        <h2 className="inspector-title">{name}</h2>
        {distanceText && (
          <div className="hud-sub num" style={{ marginTop: 5 }}>
            {/* For a shell projection this is the range to where the glyph was drawn,
                which is not the range to the object. Say which one it is. */}
            {distanceText} {directionOnly ? 'to its shell projection' : 'from here'}
          </div>
        )}
        <button type="button" className="inspector-close" onClick={() => select(null)} aria-label="Close details">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true">
            <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="inspector-body">
        {entity?.description && <p className="inspector-prose">{entity.description}</p>}

        <button
          type="button"
          className="fly-button"
          disabled={alreadyHere}
          onClick={() => viewer?.focus(selectedId)}
        >
          {/* Two states, two marks: a target you are standing on, or an approach to
              one. The arrow stops short of the ring rather than running through it,
              so at 13 px the two shapes stay separate instead of reading as a plus. */}
          {alreadyHere ? (
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="5" stroke="currentColor" strokeWidth="1.3" />
              <circle cx="8" cy="8" r="1.6" fill="currentColor" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true">
              <path d="M1.5 8h5.5M4.8 5.4 7.4 8l-2.6 2.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="11.6" cy="8" r="3" stroke="currentColor" strokeWidth="1.3" />
            </svg>
          )}
          {alreadyHere ? 'You are here' : 'Fly here'}
        </button>

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
              {/* Only when the catalogue has not already given one. The entity facts
                  carry Mars at 3,389.5 km and this row rounds the node's radius to
                  3,390 km: two rows of one panel, both labelled "Mean radius", one
                  measurement, two numbers. The catalogue's is the better figure, so
                  this row stands in for it only where there is none — which is every
                  star, galaxy and NGC object, none of which is in the entity list. */}
              {!radiusInFacts && (
                <>
                  <span className="fact-label">Mean radius</span>
                  {/* A direction-only object's radius is its catalogued angular size
                      times the placeholder shell it was projected onto. That is how big
                      the glyph is, not how big the object is, and this field is read as
                      a measurement. */}
                  <span className="fact-value">
                    {directionOnly
                      ? 'Not measured'
                      : node.radiusMetres > 0
                        ? formatDistance(node.radiusMetres).text
                        : 'Unknown'}
                  </span>
                </>
              )}
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
          {chip && (
            <span className="provenance" data-kind={chip.kind}>
              {chip.text}
            </span>
          )}
          {illustratedShape && (
            <span className="provenance" data-kind="illustration">
              Illustrated shape
            </span>
          )}
        </div>
        {directionOnly && (
          <p className="inspector-note">
            No distance to this object has been measured. Its direction on the sky is real; its depth is a
            placeholder, so it is drawn on a shell at an arbitrary radius. The size it is drawn at follows from
            that shell and is not a size for this object.
          </p>
        )}
        {/* Written by the catalogue modules for the objects that need it, and until now
            displayed by nothing at all. */}
        {node?.caveat && (
          <p className="inspector-note">
            {node.caveat}
          </p>
        )}
        {node?.provenanceNote && (
          <p className="inspector-note">
            {node.provenanceNote}
          </p>
        )}
        {entity?.source && (
          <a className="source-link" href={entity.source.url} target="_blank" rel="noreferrer noopener">
            {entity.source.label} ↗
          </a>
        )}
        {ephemerisBody && (
          <p className="inspector-note">
            Position and orientation computed for the displayed instant from astronomy-engine's VSOP87 and ELP
            models and the IAU 2015 rotation elements.
          </p>
        )}
        {illustratedShape && !directionOnly && (
          <p className="inspector-note">
            {/* Only say the astrometry is measured when the node says so. A quasar placed
                from its redshift has an illustrated shape AND a derived position. */}
            {chip?.kind === 'measured'
              ? 'Position and size are measured. The shape you are looking at is not: '
              : 'The shape you are looking at is not measured: '}
            no resolved image or shape model of this object ships with the atlas, so it is drawn from its
            catalogue radius and a hash of its own name. It is the same on every visit, and it is not a
            picture of this object.
          </p>
        )}
      </div>
    </aside>
  )
}
