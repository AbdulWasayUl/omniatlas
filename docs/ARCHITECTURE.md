# System architecture

## Architecture overview

OmniAtlas uses a scale-aware scene shell backed by a catalogue and tile platform. A single browser scene cannot retain useful precision from crater scale to cosmological scale, so navigation crosses explicit reference-frame and renderer boundaries.

```text
UI / directory / timeline
          |
Navigation state + scale router
          |
  +-------+-------------------+
  |                           |
Space renderer            Surface renderer
(Three.js / R3F)          (CesiumJS / globe tiles)
  |                           |
GPU point/mesh tiles      imagery / terrain / 3D Tiles
  +-------------+-------------+
                |
       Catalogue & tile APIs
        /        |          \
 PostgreSQL   object store   cache/CDN
 metadata     tiles/kernels  edge tiles
```

## Client

### Application shell

React owns panels, directory, accessibility, routes, settings, and error boundaries. The directory follows the catalogue hierarchy (system, body, feature category, object), provides explicit back navigation at every level, and switches to global results while searching. Zustand holds small serializable view state. URL state contains selected object, time, active layers, focus frame, and camera pose where practical.

### Space renderer

Three.js through React Three Fiber owns orbital and astronomical views, custom shaders, instanced bodies, GPU point clouds, picking, and camera transitions. The scene is organized by local frames rather than one universal coordinate system.

### Surface renderer

CesiumJS is the preferred surface engine for Earth because it already implements a WGS84 globe, view-dependent imagery/terrain requests, quantized-mesh terrain, lighting normals, water masks, and 3D Tiles. It should be mounted as a separate renderer mode when the user descends below the orbital handoff altitude. Lunar support can use a custom ellipsoid/terrain pipeline or a dedicated quadtree renderer if Cesium constraints make multi-body operation awkward.

The space and surface renderers share navigation contracts and object IDs; they do not share a depth buffer or pretend to be one scene.

### Workers

Web Workers decode catalogue batches, transform coordinate frames, build typed arrays, perform spatial filtering, and prepare tile meshes. Transferable `ArrayBuffer`s avoid copies. Service workers cache the application shell and safe immutable assets, while the renderer maintains its own memory-aware tile cache.

### Current ephemeris layer

The foundation uses Astronomy Engine 2.1.19 in the browser for current geocentric Sun/Moon vectors and the IAU 2015 rotational elements exposed for Earth, Moon, and Sun. EQJ vectors are converted into the Three.js world basis, while the prime-meridian angle and pole vector form each body quaternion. This is suitable for the live exploratory view. The later mission-grade service will replace or validate these calculations with pinned NAIF SPICE kernels and explicit correction metadata.

True-scale mode uses one render unit per mean Earth radius for Sun, Earth, Moon, and both live centre distances. A logarithmic depth buffer spans the resulting near/far range. Exploration mode preserves local body scale while compressing inter-body separation. Camera-to-target range and kilometre-per-pixel are derived continuously from the active camera, so the distance readout and ruler respond to orbiting and zooming rather than repeating a catalogue separation.

Foundation Earth coastlines are preprocessed into one transferable binary array and render in one merged line-segment draw call. Curated crater and continent anchors stay as small catalogue records. Each frame, a body-local camera direction selects the nearest anchor inside a strict angular and zoom threshold, so at most one label mounts. A fixed screen-space callout connects the projected surface anchor to an offset label with a short 45-degree segment and horizontal tail, keeping the feature visible and the geometry stable while the camera moves.

## Backend services

Start as a modular monolith; split only when load demands it.

- **Catalogue API:** object records, aliases, hierarchy, facts, sources, and spatial queries.
- **Search API:** name/alias/autocomplete and catalogue-ID resolution.
- **Ephemeris API:** validated SPICE/Horizons-derived state vectors at requested epochs, returned with frame and correction metadata.
- **Tile API:** signed/versioned URLs for imagery, terrain, point, and model tiles.
- **Ingest jobs:** fetch source releases, validate schemas, normalize units, construct indexes/LODs, and publish immutable snapshots.

REST is sufficient for initial lookup and tiles. Use binary payloads such as Arrow/FlatBuffers for dense catalogue tiles rather than verbose per-star JSON. WebSockets are unnecessary until live shared sessions or telemetry layers exist.

## Storage

### PostgreSQL

Store canonical metadata and relationships in PostgreSQL:

- `object`: stable OmniAtlas ID, type, canonical name, parent, status.
- `alias`: normalized alias, namespace, object ID.
- `physical_property`: typed value, unit, uncertainty, method, epoch.
- `state_vector`: object, center, frame, epoch range, ephemeris reference.
- `surface_feature`: body, geometry/lat/lon, dimensions, feature type.
- `source_record`: provider, dataset/version, source ID, URL, license, retrieved time.
- `object_source`: field-level provenance links.

Use PostgreSQL full-text search plus `pg_trgm` for the first search service. Use PostGIS for Earth surface geometry. Store HEALPix cell IDs as indexed integers for sky/catalogue partitioning. Do not use `earthdistance` for precise ellipsoidal geography; its own documentation recommends PostGIS when a spherical Earth is insufficient.

### Object storage and CDN

S3-compatible object storage holds immutable, content-addressed imagery, terrain, 3D Tiles, catalogue batches, thumbnails, and SPICE kernels. A CDN serves versioned public tiles with long cache lifetimes. Metadata rows point to manifests and checksums, not mutable “latest” paths.

### Browser persistence

IndexedDB (Dexie is already available) may cache recent object records, directory indexes, preferences, and offline packs. It is not the system of record and must be partitioned by catalogue snapshot/schema version.

## Coordinate-frame hierarchy

The authoritative store retains double-precision physical coordinates. The render client selects a local origin:

```text
ICRF / barycentric
  -> star or solar-system barycentric frame
     -> planet-moon system frame
        -> body-fixed frame
           -> local east-north-up surface frame
```

At each boundary, the current target becomes the floating origin and nearby positions are converted to GPU-friendly floats. The camera never carries universe-scale coordinates in Three.js `Vector3` values.

## Scale routing

- **Surface:** centimetres to thousands of kilometres; tiled globe renderer.
- **Body/orbit:** kilometres to astronomical units; Three.js meshes and orbital paths.
- **Local stars:** light-years; HEALPix/octree catalogue point tiles with origin rebasing.
- **Galaxy:** parsecs/kiloparsecs; aggregated density volumes and selected resolved stars.
- **Extragalactic:** megaparsecs; catalogue points and uncertainty volumes.

Transitions crossfade or stage through a parent frame. There is never a requirement to render all scales simultaneously.

## API contracts

Every object response includes schema and catalogue snapshot versions. Every state includes its center, frame, epoch, unit, and source. Tile manifests include origin, bounds, geometric error, child availability, content hash, compression, record count, and source snapshot.

## Deployment and operations

- Static React application and public immutable assets on a CDN.
- API and ingest containers deployed independently from tile storage.
- PostgreSQL with point-in-time recovery; object storage versioning enabled.
- CI validates types, lint, unit tests, deterministic ingest fixtures, asset attribution, and performance budgets.
- Metrics: API latency/error rate, tile cache hit rate, bytes by layer, frame time, long tasks, shader failures, and WebGL context loss.
- Structured logs use object IDs and request IDs; avoid raw user search history unless the user opts into diagnostics.

## Security

- Treat catalogue descriptions and imported metadata as untrusted text.
- Allowlist tile/source hosts and enforce CSP.
- Do not put provider secrets or unrestricted service tokens in client bundles.
- Rate-limit search and ephemeris endpoints.
- Validate decompressed size and geometry counts before GPU upload.
- Record licenses and attribution during ingest; block publication when required metadata is absent.

## Key technology decisions

- Three.js documents reverse depth buffers as faster and more accurate than logarithmic depth when `EXT_clip_control` is available; use capability detection, with logarithmic depth as a fallback. Precision is still solved primarily by local frames.
- CesiumJS streams finer terrain based on camera distance and visible regions and separates terrain from imagery, matching the surface-view requirement.
- OGC 3D Tiles 1.1 is the interchange format for massive heterogeneous 3D geospatial content, not the canonical astronomical object schema.
- SPICE supplies state vectors and transformations among named inertial/body-fixed frames; preserve frame and epoch on every computed state.
- HEALPix NESTED cells provide stable hierarchical sky partitions for multi-resolution catalogue delivery.

See [DATA_AND_COORDINATES.md](DATA_AND_COORDINATES.md) for sources and [RENDERING.md](RENDERING.md) for implementation detail.
