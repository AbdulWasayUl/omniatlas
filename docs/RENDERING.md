# Rendering strategy

## Renderer choice

The initial orbital scene uses Three.js through React Three Fiber. It provides direct control over materials, shaders, GPU buffers, instancing, picking, and frame rebasing while fitting the existing React application.

High-resolution surface descent is a different problem. CesiumJS is reserved for that mode because it already selects view-dependent terrain detail, separates terrain from imagery, consumes terrain providers, and handles globe-scale camera/precision concerns. Adding Cesium to the orbital milestone would increase bundle and integration cost without providing value at the current altitude.

## Physical space versus render space

Canonical values use SI or documented astronomical units in double precision. Each scene frame converts nearby values to a small render space.

For the Earth–Moon scene:

- 1 render unit = Earth display radius for stable interaction.
- Moon radius = 1,737.5 / 6,371 ≈ 0.27272 units.
- Real mean separation = 385,000 / 6,371 ≈ 60.43 units.
- Exploration separation and Sun size are compressed to keep all bodies visible, while local Earth/Moon scale remains physical and the UI labels the distortion.
- True-scale mode uses the same Earth-radius unit for all three physical radii and the live Earth–Moon and Earth–Sun distances.

Later frames select different origins and unit scales. A galaxy is not positioned millions of Earth-render units from the same origin.

## Depth and precision

Use these measures in order:

1. local coordinate frames and floating-origin rebasing;
2. tight per-mode camera near/far planes;
3. separate scenes/passes for incompatible ranges;
4. reverse depth buffer where supported;
5. logarithmic depth only as fallback because Three.js notes its early-fragment-test performance cost.

CPU transforms remain 64-bit. GPU high/low position pairs are an option for dense far-field catalogues, not a substitute for frame routing.

## Body representation

### Orbital level

- Sufficiently tessellated ellipsoid/sphere mesh.
- Color/albedo texture in sRGB.
- Linear-data bump/normal/roughness maps where available.
- Physically based standard material with directional sunlight.
- Thin atmosphere shell for Earth using view-angle and sun-angle scattering approximation.
- Independent cloud shell slightly above Earth, transparent and depth-write disabled.
- Low-intensity cool ambient fill keeps the night hemisphere legible without erasing the terminator or competing with directional sunlight.

The current Moon geometry uses a global LOLA elevation map for lighting detail. It does not displace the silhouette aggressively at orbital distance. Twenty-five curated named craters use callout anchors: after a strict zoom threshold, the renderer selects only the closest centered crater and offsets its text along a fixed screen-space 45-degree leader with a short horizontal tail. Surface mode will use terrain tiles where crater topography is geometry rather than only bump shading.

### Surface level

- Quadtree tiles selected by screen-space geometric error.
- Crack-free neighbor LOD transitions, skirts or edge stitching.
- Separate imagery, terrain, vector label, and 3D feature layers.
- Horizon/ellipsoid occlusion and frustum culling.
- Height exaggeration is optional and visibly labeled.

## Lighting and time

The foundation recalculates geocentric Sun/Moon vectors and IAU body rotations from the current UTC time once per second. The Sun vector drives the directional light, producing the current Earth terminator and lunar phase. Exploration mode compresses the visible Sun; true-scale mode renders its physical radius at its current geocentric distance and provides constant-size locator labels because the real bodies become only a few screen pixels in the full-system view.

The mission-grade ephemeris milestone will validate or replace browser calculations with pinned SPICE state/orientation kernels, expose time controls, and add documented eclipse tolerances. Shadowing/eclipses must use consistent time and frame data.

## Stars and deep catalogues

- Render stars as GPU points or instanced quads, not sphere meshes.
- Partition by HEALPix plus radial/LOD bins.
- Encode compact typed attributes: relative position, magnitude, color/temperature proxy, object index.
- Apply magnitude limits and density aggregation based on screen footprint.
- Pick via spatial index or offscreen ID buffer rather than ray-testing a billion points.
- Synthetic random distributions may be used only as a labeled performance fixture, never as atlas content.

## Labels and picking

3D marker anchors are transformed with their body. Screen-space labels are a UI layer and may occlude/cull based on depth, horizon, priority, and collision. Only important or selected labels render by default.

Surface-feature markers use semantic zoom: they stay hidden in system/body overview views, fade in below a body-relative camera-distance threshold, and remain culled on the far hemisphere. Selected directory results may appear slightly earlier so a fly-to destination is never lost. Offset screen labels connect to their projected surface anchors with fixed-angle screen-space leaders.

Picking uses broad-phase body bounds, then feature/tile indexes. Selection IDs resolve back to typed catalogue records; renderer objects never contain the only copy of facts.

## Performance budgets

- Adaptive device pixel ratio: 1–2 desktop, lower under sustained frame pressure.
- Reuse geometries/materials and instance repeated markers.
- Load base textures immediately; defer high-resolution layers.
- Compress production textures to KTX2/Basis with mipmaps after the asset pipeline is in place.
- Use anisotropic filtering within device capability for oblique surfaces.
- Pause decorative updates when the tab is hidden or reduced motion is enabled.
- Dispose evicted textures, geometries, render targets, and worker buffers.
- Track draw calls, triangles, texture memory estimate, shader compile time, and moving frame-time percentiles.

## Quality levels

| Quality | Pixel ratio | Base texture | Terrain/feature density | Target |
|---|---:|---|---|---|
| Low | 1.0 | 1–2K | sparse | older mobile / power saving |
| Medium | up to 1.5 | 2–4K | moderate | default mobile/laptop |
| High | up to 2.0 | 4–8K/tiled | full visible | discrete GPU |

Quality changes representation only. Physical data and labels do not become less accurate.

## Visual validation

- Golden screenshots: system, Earth day/night limb, Moon near/far side, narrow mobile.
- Seam check at ±180° longitude and poles.
- Marker coordinate check against known reference features.
- Radius-ratio and real-distance numerical assertions.
- Automated check for missing texture requests and WebGL errors.
- Manual test for context loss, slow network, touch navigation, reduced motion, and panel keyboard flow.

## References

- [Three.js WebGLRenderer](https://threejs.org/docs/pages/WebGLRenderer.html)
- [React Three Fiber performance scaling](https://r3f.docs.pmnd.rs/advanced/scaling-performance)
- [CesiumJS terrain guide](https://cesium.com/learn/cesiumjs-learn/cesiumjs-terrain/)
- [CesiumJS 3D Tileset reference](https://cesium.com/learn/cesiumjs/ref-doc/Cesium3DTileset.html)
- [OGC 3D Tiles 1.1](https://docs.ogc.org/cs/22-025r4/22-025r4.html)
