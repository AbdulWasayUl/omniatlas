# Delivery roadmap

The order is intentionally conservative. Every milestone leaves a usable product and creates foundations needed by the next one.

## Milestone 0 — definition and technical spike

Status: complete.

- Audit and remove the procedural mock universe.
- Define scope, truth model, coordinate hierarchy, renderer boundaries, and data provenance.
- Validate NASA Earth and Moon products in a browser GPU scene.
- Establish build/lint checks.

Exit: architecture docs accepted and no invented catalogue data remains in the rendered experience.

## Milestone 1 — Sun–Earth–Moon orbital atlas

Status: implemented in this repository.

- True 3D Earth and Moon with real global textures and correct radius ratio.
- Live current UTC Sun/Moon directions, IAU body rotations, Sun-driven lighting, and lunar phase.
- Selectable shader Sun with compressed exploration presentation and physical radius/distance in true-scale mode.
- Semantic-zoom Natural Earth coastlines plus single-local-label selection for seven continents and 25 named lunar craters.
- NASA LOLA-driven lunar bump detail and cloud/atmosphere layers for Earth.
- Manual orbit, zoom, pan, reset, and animated focus.
- System/Earth/Moon destinations and object directory.
- Curated impact features on both bodies with semantic-zoom, hemisphere-aware anchors and information panels.
- Exploration-versus-true-scale control, dynamic kilometre ruler, and explicit disclosure.
- Responsive, keyboard-accessible UI and asset attribution.

Exit: all acceptance criteria in the product specification pass on desktop and mobile-class viewport testing.

## Milestone 2 — planetary surface framework

- Introduce the surface-renderer boundary and CesiumJS proof of concept for Earth.
- Stream Earth imagery and quantized terrain by screen-space error.
- Implement surface camera collision, coordinate readout, terrain picking, and tile attribution.
- Ingest the complete supported Earth impact-structure source under its terms.
- Build lunar quadtree terrain from PDS LOLA/SLDEM and LRO imagery.
- Add layer manager, cache budget, offline pack manifest, and visual regression suite.

Exit: descend from orbit to a selected Earth or Moon feature without precision loss; visible terrain is tiled and source-attributed.

## Milestone 3 — mission-grade time controls and Earth–Moon system

- Replace/validate the live browser ephemeris with a service backed by pinned NAIF SPICE kernels.
- UTC/TDB handling, body orientations, lunar libration, real Sun direction, orbit trail, and eclipse geometry.
- Timeline with now/pause/rate/date and clear model coverage.
- Deep links that reproduce time, frame, camera, and layers.

Exit: reference-state tests agree with JPL/NAIF fixtures within a documented tolerance.

## Milestone 4 — solar system

- Ingest Sun, planets, major moons, dwarf planets, and a curated small-body subset.
- Hierarchical system directory and scale router.
- LOD body models/materials and orbit uncertainty display.
- On-demand Horizons lookup for objects outside the packaged ephemeris set.
- Never draw all small bodies as individual meshes; use instanced/point tiles.

Exit: navigate from Earth surface to any supported major body with correct frames, time, units, and sources.

## Milestone 5 — local stellar neighborhood

- Gaia ingest prototype, HEALPix NESTED partitioning, magnitude LODs, and binary point tiles.
- Catalogue API, aliases/cross-matches, fuzzy search, and result virtualization.
- Proper motion propagation with epoch/quality handling.
- Floating-origin transitions from heliocentric to local-star frames.

Exit: browse and search a versioned Gaia subset with stable frame time and bounded memory; no whole-catalogue client download.

## Milestone 6 — galaxy and extragalactic atlas

- Multi-scale Milky Way density model plus resolved catalogue objects.
- Nebulae, clusters, galaxies, quasars, survey footprints, and wavelength layers.
- Redshift/distance method and uncertainty visualization.
- Aggregate tiles and progressive disclosure at every scale.

Exit: transitions remain spatially understandable and every rendered catalogue layer declares coverage and selection effects.

## Milestone 7 — platform features

- Accounts only if saved places/tours require them.
- Shareable tours, annotations, educational narratives, and embed API.
- Public dataset/layer SDK with schema validation and attribution enforcement.
- Internationalization, robust offline packs, and expanded accessibility testing.

## Work rules

- A new object class needs a schema, source, coordinate-frame rule, LOD policy, and test fixture before renderer work.
- A new data layer needs license/attribution, update cadence, cache policy, and failure state before release.
- A scale transition needs a precision budget and parent/child frame contract before animation polish.
- Performance targets are gates, not post-release cleanup.
- “Complete” always means complete for a named catalogue snapshot and filter, never complete for the physical universe.
