# Product specification

## Product statement

OmniAtlas is an interactive, three-dimensional atlas in which a person can move freely, jump to a known astronomical object, view it from any angle, inspect sourced facts, and move between spatial scales without losing context.

“Universal” describes the navigation model and long-term catalogue scope. It does not mean every object in the physical universe is known. The interface must say “known objects” and expose catalogue coverage rather than imply false completeness.

## Experience principles

1. **Spatial first.** The scene is the primary interface; lists and panels support it.
2. **Truth over spectacle.** Physical radius, position, epoch, and uncertainty remain in canonical data. Readability scaling is opt-in and labeled.
3. **Continuous orientation.** Every jump has an animated arrival and a named focus. Users can always return to a parent system.
4. **Progressive detail.** A body appears immediately at low resolution, then gains texture, terrain, labels, and catalogue detail as bandwidth and zoom allow.
5. **Explain the evidence.** Facts and imagery include provider, product, epoch/date, resolution, and license/usage notes.
6. **Device aware.** Quality adapts without changing the represented facts.

## Primary user journeys

### Explore manually

Open the atlas, orbit the Earth–Moon system, zoom toward a body, focus it, rotate around it, inspect a feature, then return to the system.

### Jump through the directory

Open the directory at the Solar System, drill into a body and then a feature category, inspect an object, and move back through the same hierarchy. Search aliases or catalogue identifiers globally at any level. A result that is known but not renderable still opens its record and shows why.

### Inspect an object

Select a body or feature and see its canonical name, type, dimensions, parent, coordinates/reference frame, epoch, descriptive facts, data sources, and uncertainty where relevant.

### Change time

The foundation follows current UTC and recomputes positions/orientations from its browser ephemeris. A later milestone adds user-controlled simulation time. The UI must distinguish observation time, catalogue epoch, and simulation time.

## Functional requirements

### Navigation

- Orbit, zoom, and pan with mouse, touch, and trackpad.
- Keyboard shortcuts for major destinations and panel dismissal.
- Focus system, body, or surface feature without teleport disorientation.
- Reset view and return to the parent frame.
- Prevent the camera from entering a solid body.
- Preserve a useful view on narrow screens.

### Directory and search

- Present catalogue contents as a navigable system/body/category/object hierarchy with explicit back navigation.
- Search canonical names, aliases, and external catalogue IDs.
- Filter by body, feature, star, system, deep-sky object, and catalogue source.
- Rank exact names first, then prefixes, aliases, and fuzzy matches.
- Virtualize large result sets and paginate server responses.
- Deep-link to an object and view state.

### Object information

- Use typed fields with units instead of arbitrary label/value blobs.
- Separate measured, calculated, and editorial values.
- Cite providers and preserve source record IDs.
- Display missing and uncertain values honestly.
- Show whether distance and size are physical, exaggerated, or compressed.

### Layers

- Surface imagery, cloud/weather, terrain, labels, boundaries, orbits, coordinate grids, and observation footprints are independently switchable when supported.
- Layer availability is body- and zoom-dependent.
- Attribution remains visible whenever a layer is visible.

### Accessibility

- All primary actions are keyboard reachable.
- Buttons have accessible names and visible focus.
- Panels meet WCAG AA contrast targets.
- Reduced-motion preference removes long fly-to animations and decorative rotation.
- Do not encode object type or state by color alone.

## Non-functional requirements

- Initial interactive scene target: under 3 seconds on a typical broadband desktop after caching, under 6 seconds cold on a mid-tier mobile device.
- Maintain 60 fps desktop and 30 fps mobile targets during ordinary orbiting.
- No long main-thread catalogue parsing; use workers and binary batches.
- GPU memory budget targets: 512 MB desktop, 192 MB mobile; tile caches must evict.
- Every ingest is reproducible from a versioned manifest and checksum.
- All API results carry schema version and catalogue snapshot ID.
- Application errors are observable without recording search text or precise user location by default.

## Earth–Moon milestone acceptance criteria

- Real NASA global surface products replace procedural continents and a smooth Moon.
- Current UTC Sun/Moon directions and IAU body rotations drive position, orientation, lighting, and lunar phase.
- The Sun is selectable, uses its physical radius and current distance in true-scale mode, and is clearly disclosed as compressed in exploration mode.
- Earth and Moon radii are shown at their real ratio.
- A control switches between compressed exploration spacing and a shared physical kilometre scale for Sun, Earth, and Moon radii and current centre distances.
- System, Earth, and Moon focus actions move the camera to useful views.
- Both bodies can be selected and inspected.
- Named terrestrial impact structures and lunar craters can be selected from the directory and located on the globe; markers appear only at close zoom and on the viewed hemisphere.
- Natural Earth coastlines, seven continent labels, and 25 curated USGS lunar crater labels use semantic zoom; at most one local continent or crater label is visible at a time, offset from its surface anchor by a leader line.
- The lower-left distance readout reports live camera-to-target range, and its ruler reports the physical kilometres represented on screen.
- Manual orbit/zoom/pan works with mouse and touch.
- Loading, empty, unsupported-WebGL, and narrow-screen states are usable.
- Build and lint pass.

## Explicitly out of scope for milestone 1

- Street maps, buildings, navigation, and user GPS.
- High-resolution tiled terrain and descent to ground level.
- Live weather, live satellites, or mission-grade SPICE ephemerides.
- Accounts, annotations, collaboration, and saved tours.
- Claims of complete star, galaxy, exoplanet, or small-body coverage.

## Solar-system expansion (post–milestone 1)

Delivered ahead of the milestone-4 slot in the roadmap, alongside milestone 1's
own semantic-zoom and menu cleanup work:

- Mercury through Neptune plus Pluto, each with a real NASA/USGS/Solar System
  Scope texture, true relative radius, IAU-derived rotation, and a true
  heliocentric position from `astronomy-engine`'s VSOP-based model for the
  current UTC time.
- A curated set of major moons (both Galilean moons via `JupiterMoons`, and
  Phobos/Deimos, the classical Saturnian and Uranian moons, and Triton via a
  two-body Keplerian propagator seeded with JPL SSD mean elements) — not the
  full moon count of any giant planet.
- Saturn's ring, Venus's cloud deck, and a procedural main asteroid belt with
  four named notable bodies (Ceres, Vesta, Pallas, Hygiea).
- Earth's impact-structure markers are replaced by two much larger real
  datasets: all 242 Natural Earth countries (with boundary outlines) and 1,251
  populated places, both revealed by camera-distance tiers the way a map
  application reveals more labels on zoom, rather than the single-label
  semantic zoom milestone 1 used for continents.
- The Moon's 25 curated craters are replaced by the full 1,615-crater USGS
  Gazetteer named-crater dataset, using the same tiered-reveal approach.
- Country/city/crater labels render as GPU billboarded text (troika SDF text)
  instead of DOM `<Html>` overlays, which is what makes showing dozens of
  simultaneous labels affordable; only the camera's current focus target gets
  per-frame ephemeris refinement; every other body updates on the existing
  ~1 Hz cadence.
- Explore/Real (exploration vs. physical distance) mode is preserved across
  the whole system: Explore compresses inter-body separation with a
  square-root law and keeps every body at its true relative size; Real uses
  one shared kilometre scale for both distances and radii, including on
  moons and small bodies.

This expansion does not change the truth-model, provenance, or "known objects,
not the whole universe" commitments above — the new bodies and labels carry
the same source/fact/coordinate structure as milestone 1's catalogue.
