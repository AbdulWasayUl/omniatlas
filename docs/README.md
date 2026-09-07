# OmniAtlas documentation

These documents define the product before the catalogue and renderer grow beyond the first Sun–Earth–Moon milestone.

1. [PRODUCT_SPEC.md](PRODUCT_SPEC.md) — product boundaries, users, behavior, requirements, and acceptance criteria.
2. [ARCHITECTURE.md](ARCHITECTURE.md) — renderer boundaries, services, persistence, APIs, deployment, and observability.
3. [DATA_AND_COORDINATES.md](DATA_AND_COORDINATES.md) — object schema, reference frames, time, source provenance, and tiling/indexing.
4. [RENDERING.md](RENDERING.md) — precision, levels of detail, materials, lighting, picking, performance, and quality policy.
5. [ROADMAP.md](ROADMAP.md) — sequenced delivery plan and explicit exit criteria.

## Core decisions

- Build a truthful atlas of **known and sourced objects**, not an impossible claim of completeness.
- Keep physical values separate from render-space values. Any compressed distance or exaggerated size must be visible in the UI.
- Use a hierarchy of local coordinate frames and floating origins. Never put metre-scale terrain and megaparsec-scale catalogues in one floating-point scene.
- Use the renderer suited to the scale: Three.js for orbital/interstellar scenes, CesiumJS or an equivalent globe-tile engine for surface terrain.
- Make data provenance, epoch, coordinate frame, uncertainty, and licensing first-class fields.
- Stream and aggregate. The browser must never download an entire billion-row catalogue.

## Milestone 1 status

The repository implements the Sun–Earth–Moon foundation described in the roadmap. It includes a current-UTC browser ephemeris, true Sun/Earth/Moon scale, a camera-derived kilometre ruler, directional sunlight, semantic-zoom coastlines, and single-local-label selection for continents and 25 named lunar craters. It intentionally stops before tiled terrain, mission-grade SPICE kernels, accounts, or a backend catalogue API.
