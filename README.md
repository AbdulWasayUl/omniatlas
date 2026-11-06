# OmniAtlas

**[omniatlas-five.vercel.app](https://omniatlas-five.vercel.app)**

A browser-based, explorable atlas of known space. One continuous camera runs from a
city on Earth out to the cosmic web, and every object you can see is one you can click,
with a source behind it.

OmniAtlas does not claim to map the universe. It maps the parts of it that have been
catalogued and published, and it tries to be honest about the difference — about what is
measured, what is modelled, what is only a direction on the sky, and where the view you
are looking at has been scaled to be legible rather than to be true.

## Run locally

```bash
npm install
npm run dev
```

Everything runs in the browser against static files in `public/`. There is no server, no
account, and no API key.

Quality checks:

```bash
npm run lint    # oxlint + the contrast checker
npm test        # 396 unit tests
npm run build   # tsc -b, vite build, asset hashing
```

## What is in it

| | |
|---|---|
| **Stars** | 329,860 from AT-HYG v4.0, streamed in three levels of detail |
| **Deep sky** | 14,026 NGC/IC rows from OpenNGC, 379 traced nebula outlines, 157 globular clusters |
| **Galaxies** | 869 Local Volume (UNGC), 44,599 redshifts (2MRS), 38,053 groups with redshift-independent distances (Cosmicflows-4) |
| **Exoplanets** | 728 systems, 1,062 planets, from the NASA Exoplanet Archive |
| **Small bodies** | 80,598 main-belt asteroids plus the named ones, from JPL's SBDB |
| **Solar system** | Sun, planets and moons on a live browser ephemeris, at true scale |
| **Earth and Moon** | NASA surface products, Natural Earth coastlines and borders, 1,251 cities, 1,615 named craters |
| **The Milky Way** | a 300,000-point realisation of the Reid+2019 arm model — labelled *derived*, because it is not a catalogue of real stars |

## How it works

**One world, in double precision.** Positions are float64 metres in a single SI world
model. The GPU never sees those numbers: the scene is split into eight *layers* —
cosmic, galactic, stellar, galaxy interior, heliosphere, star system, system, surface —
each with its own unit, origin and camera, drawn far-to-near and composited. A floating
origin keeps every vertex buffer inside the range a float32 can represent, which is what
lets the same camera move from a crater rim to a supercluster without the geometry
tearing.

**Provenance is a first-class field.** Every node carries where its numbers came from.
The inspector shows a chip: *measured*, *derived*, or *illustrated*. A deep-sky object
with no published distance is not quietly placed somewhere plausible — it is drawn as a
hollow ring on a fixed direction-only shell, so a bearing never masquerades as a
position.

**Drawn means clickable.** If the renderer puts something on screen, the engine has a
node registered for it and you can select it. That invariant is tested.

Longer versions of all of this are in [docs/](docs/README.md): the architecture, the
coordinate and data model, the rendering strategy, and the roadmap.

## Controls

- **Drag** to orbit, **scroll** or **pinch** to zoom, **right-drag** to pan.
- **Click** anything visible to inspect it.
- `/` or `Cmd`/`Ctrl`+`K` — search everything by name or designation.
- `Esc` — close the top panel, then clear the selection.
- `Space` — pause time. `N` — jump back to now.
- `Backspace` or `U` — up one level: moon to planet, planet to Sun.
- **Arrow keys** orbit, `+` and `-` zoom.
- The **scale ladder** on the right jumps between rungs, from a surface to the observable
  universe. Rungs that are not built yet ship greyed and labelled rather than hidden.

The URL carries the full view — focus, distance, orientation, epoch and time rate — so
any view you reach is a link you can share.

## Current scope

The solar system, the stellar neighbourhood, the Milky Way, the Local Volume and the
cosmic web are navigable now. Four rungs on the scale ladder are not: **surface**
(streamed terrain), **heliosphere**, **Oort cloud** and **observable universe**. They are
visible in the UI precisely so the gaps are legible rather than hidden.

[docs/ROADMAP.md](docs/ROADMAP.md) has the sequenced plan and the exit criteria for each
milestone.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the branch model,
the quality gates, and how a change is reviewed. By taking part you agree to the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Licence and attribution

The code is MIT — see [LICENSE](LICENSE). The data is not: each catalogue keeps its own
terms, and redistributing this repository means honouring them.

| Dataset | Source | Terms |
|---|---|---|
| Stars | AT-HYG v4.0, Astronomy Nexus (David Nash) | CC BY-SA 4.0 |
| Deep sky | OpenNGC, Mattia Verga | CC BY-SA 4.0 |
| Globular clusters | Harris (1996), 2010 edition | free to use, cite the original source |
| Local Volume galaxies | Karachentsev, Makarov & Kaisina (2013), AJ 145, 101 | VizieR terms, cite the authors |
| Galaxy redshifts | 2MRS — Huchra, Macri, Masters et al. (2012), ApJS 199, 26 | VizieR terms, cite the authors |
| Galaxy groups | Cosmicflows-4 — Tully, Kourkchi, Courtois et al. (2023), ApJ 944, 94 | VizieR terms, cite the authors |
| Exoplanets | NASA Exoplanet Archive (`pscomppars`), NASA/Caltech | public domain |
| Small bodies | JPL Small-Body Database, NASA/JPL-Caltech | public domain, courtesy credit requested |
| Earth and Moon surfaces | NASA Earth Observatory, NASA Visible Earth, NASA SVS CGI Moon Kit | public domain |
| Coastlines and borders | Natural Earth 1:50m | public domain |
| Crater names | USGS Gazetteer of Planetary Nomenclature | public domain |
| Ephemeris | Astronomy Engine 2.1.19 | MIT |

Per-dataset licence files sit beside the data in `public/data/*/`, and the full usage
notes are in [docs/DATA_AND_COORDINATES.md](docs/DATA_AND_COORDINATES.md).
