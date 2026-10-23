# Data, coordinates, and provenance

## Truth model

OmniAtlas distinguishes four things that visual prototypes often collapse:

1. **Identity:** what object or feature a record describes.
2. **Physical state:** a value in a stated unit, coordinate frame, epoch, and uncertainty.
3. **Observation/catalogue record:** what a provider measured or published.
4. **Render representation:** a mesh, point, label, or tile that may use readable scaling.

A render position is never written back as an astronomical position.

## Stable identifiers

OmniAtlas IDs are namespaced and never derived from display names:

- `body:399` — Earth (NAIF body code when applicable).
- `body:301` — Moon.
- `feature:moon:tycho` — curated surface feature.
- `gaia:dr3:5853498713190525696` — provider-scoped catalogue record.

Merges and splits retain redirect/tombstone records so shared links remain interpretable.

## Object model

Required common fields:

- ID, type, canonical name, aliases, parent/host.
- lifecycle/status: active, candidate, retracted, merged, historical.
- one or more source records.
- optional description and editorial tags.

Physical properties use `{ value, unit, uncertainty, method, epoch, sourceId }`. Coordinates use `{ center, frame, representation, epoch, value, covariance?, sourceId }`.

Do not flatten conflicting provider values into one undocumented number. A curated preferred value may point to one source record while alternatives remain available.

## Reference frames and time

- Use ICRF/J2000-compatible inertial frames for solar-system and stellar interchange where appropriate.
- Use SPICE body-fixed frames such as `IAU_EARTH` and `IAU_MOON` for general body data; use higher-accuracy Earth frames such as ITRF when the dataset requires it.
- Lunar precision work may require a principal-axis frame and the exact orientation kernel used by the source.
- Earth surface products declare their CRS, usually geographic WGS84 or a product-specific spherical grid.
- Time-dependent states specify UTC input plus the computational time scale/ephemeris time used internally.
- Store original epoch and propagate only when the model supports it. Never silently present catalogue J2016 positions as “live.”

NAIF SPICE is the preferred solar-system frame and ephemeris foundation. Its frame subsystem explicitly transforms between inertial, body-fixed, and mission frames, and SPK kernels provide target states relative to a center, frame, epoch, and correction choice.

## Spatial partitioning

### Sky catalogues

Partition angular data with HEALPix NESTED indices. Its equal-area cells and parent/child numbering support multi-resolution server aggregates and detailed child tiles. Add radial shells or an octree key for records with reliable distance.

Catalogue tile levels return aggregates when far away, sampled bright/important objects at middle levels, and complete source rows for only the selected cell and magnitude limit when close enough.

### Planetary surfaces

Use quadtree imagery/terrain tiles with a body-specific tiling profile. Earth surface vectors live in PostGIS. Stream meshes using quantized mesh or 3D Tiles where suitable. The tile manifest states ellipsoid/reference radius, projection, height datum, error, and attribution.

## Source plan by domain

| Domain | Preferred sources | Notes |
|---|---|---|
| Earth imagery | NASA Earth Observatory/Visible Earth; later NASA GIBS for time layers | Keep acquisition/composite date and resolution. |
| Earth elevation | Copernicus DEM, NASA SRTM/ASTER where licensing and coverage fit | Build a tiled terrain pyramid; document vertical datum. |
| Lunar imagery/elevation | LRO WAC color mosaics and LOLA/SLDEM products via NASA/PDS | Use PDS products for science; CGI Moon Kit is suitable for the current visual base. |
| Planetary names | IAU/USGS Gazetteer of Planetary Nomenclature | Preserve feature type, approval status, coordinates, and diameter. |
| Solar-system bodies | JPL Horizons and NAIF SPICE kernels | Cache computed states with kernel/version metadata. |
| Stars | ESA Gaia releases | DR3 alone contains about 1.812 billion sources; never ship it as one client file. |
| Cross-identification | CDS SIMBAD/VizieR under their terms | Keep provider IDs and match confidence. |
| Exoplanets | NASA Exoplanet Archive | Candidate/confirmed status changes over time; snapshot it. |
| Galaxies/deep sky | Curated catalogues first, survey releases later | Apparent imagery, redshift distance, and 3D position uncertainty are distinct. |

## Assets in milestone 1

| Local asset | Source | Purpose |
|---|---|---|
| `public/textures/earth/blue-marble-december.webp` | [NASA Blue Marble: Next Generation](https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-topography-bathymetry/) | 5400×2700 global visual surface with topography/bathymetry shading. |
| `public/textures/earth/clouds.webp` | [NASA Visible Earth Blue Marble clouds](https://www.visibleearth.nasa.gov/images/57747/blue-marble-clouds) | 2048 global cloud alpha/detail layer. |
| `public/textures/moon/lroc-color-4k.webp` | [NASA SVS CGI Moon Kit](https://svs.gsfc.nasa.gov/4720/) | Converted from the 4096×2048 LRO WAC color TIFF for browser delivery. |
| `public/textures/moon/lola-elevation-4ppd.webp` | [NASA SVS CGI Moon Kit](https://svs.gsfc.nasa.gov/4720/) | Converted from the 4-pixel/degree unsigned LOLA elevation TIFF for bump shading. |
| `public/textures/moons/triton.webp` | Triton global map by Askaniy Anpilogov from NASA/JPL-Caltech/ASI/USGS Voyager 2 imagery, [CelestiaContent](https://github.com/CelestiaProject/CelestiaContent) `textures/hires/triton.jpg`, CC BY 3.0 | 2048×1024 equirectangular, downsampled from 4096×2048. Replaces a file that was not a map projection at all but an oblique rendered view of the globe, which sampled as equirectangular smeared one crescent of terrain over the whole sphere. Unimaged longitudes carry a neutral fill baked into the source, so the shader's `unimagedFill` substitution is switched off for this body. |
| `public/data/earth/coastline-50m.bin` | [Natural Earth 1:50m coastlines](https://www.naturalearthdata.com/downloads/50m-physical-vectors/50m-coastline/) | 58,987 preprojected line segments in one transferable binary buffer. Public domain. |

### Texture encoding

Body maps ship as WebP at quality 82, which measured 56 per cent smaller than the JPEGs
they replaced across the set (10.90 MB to 4.81 MB). The saving is very uneven and follows
the imagery rather than the file size: Neptune is 93 per cent smaller and Uranus 89,
being smooth low-detail maps that JPEG's 8x8 blocks handle badly, while Callisto and
Enceladus came out *larger* in WebP and are therefore still JPEG. The rule is per file,
not per format: keep whichever encoding is smaller, and record which.

No fallback path is shipped. Every browser that can run this atlas supports WebP by a
wide margin: the app needs WebGL2, `build.target: 'esnext'` and top-level await, which
together require Safari 15+, Chrome 89+ or Firefox 89+, while WebP has been in Safari
since 14, Chrome since 32 and Firefox since 65.

Re-encoding is a one-off on the committed asset, the same as the Triton replacement
above, because these are third-party downloads that were already hand-processed into the
repository rather than products of a script in `scripts/`. The recipe is Pillow's WebP
encoder at `quality=82, method=6`, writing the result only where it is smaller than the
original.

NASA SVS describes the Moon color product as an aesthetic map and directs scientific applications to the source LRO/PDS data. This milestone therefore labels it a global visual base, not an analysis-grade measurement layer.

## Ingest pipeline

1. Fetch an immutable provider release or record the upstream checksum/date.
2. Quarantine and validate file type, dimensions, CRS/frame, units, null conventions, and license.
3. Normalize into staging tables without destroying original values.
4. Resolve identities and aliases with confidence/review flags.
5. Generate search indexes, HEALPix/radial partitions, and render tiles.
6. Run numerical, coverage, duplicate, and visual seam tests.
7. Publish a versioned manifest atomically.
8. Retain the previous snapshot for rollback and reproducibility.

## Data quality rules

- Source URLs and provider IDs are mandatory for published facts.
- Units are machine-readable; formatted strings are presentation only.
- Unknown is `null`, never zero.
- Angular values specify convention and range.
- Distances derived from parallax include the method and uncertainty; negative/low-quality parallaxes are not naïvely inverted.
- “Current position” always states time, frame, light-time/aberration corrections, and kernel/model version.
- Synthetic stars or invented catalogue records are forbidden outside clearly isolated test fixtures.

## Authoritative references

- [NASA Earth facts](https://science.nasa.gov/earth/facts/)
- [NASA Moon facts](https://science.nasa.gov/moon/facts/)
- [NASA Earth–Moon comparison](https://science.nasa.gov/moon/by-the-numbers/)
- [NASA SVS CGI Moon Kit](https://svs.gsfc.nasa.gov/4720/)
- [NAIF SPICE reference frames](https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/FORTRAN/req/frames.html)
- [NAIF SPK ephemeris documentation](https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/C/req/spk.html)
- [ESA Gaia DR3 documentation](https://gea.esac.esa.int/archive/documentation/GDR3/)
- [HEALPix primer](https://healpix.sourceforge.io/doc/html/intro.htm)
- [OGC 3D Tiles 1.1](https://docs.ogc.org/cs/22-025r4/22-025r4.html)
- [Astronomy Engine](https://github.com/cosinekitty/astronomy)
