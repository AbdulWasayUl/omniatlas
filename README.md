# OmniAtlas

OmniAtlas is a browser-based, explorable atlas of known space. The project deliberately starts with a sourced Sun–Earth–Moon system.

The current milestone renders the Sun, Earth, and Moon as interactive 3D bodies using NASA global surface products and a live browser ephemeris. You can orbit freely, zoom, focus any body, inspect surface datasets, browse a collapsed-by-default hierarchical directory, and switch between a readable exploration layout and one shared physical kilometre scale for all three radii and both current distances.

## Run locally

```bash
npm install
npm run dev
```

Quality checks:

```bash
npm run lint
npm run build
```

## Controls

- Drag to orbit around the current focus.
- Scroll or pinch to zoom.
- Right-drag to pan.
- Use `1`, `2`, `3`, and `4` to jump to the system, Earth, Moon, and Sun.
- Press `/` to open the object directory and `Esc` to close panels.
- Click a body or a visible surface-feature marker to inspect it.
- Surface-feature markers appear progressively only when you focus a body and zoom close to the visible hemisphere.
- Earth coastlines and all seven continent labels reveal at Earth-detail zoom.
- Twenty-five curated, IAU-approved Moon craters use offset leader-line labels; the nearest label appears when its local area is centered at close zoom.
- The lower-left readout reports live camera-to-target range, while its ruler reports the real distance represented on screen.

## Documentation

Start with [docs/README.md](docs/README.md). It links the product definition, system architecture, coordinate/data model, rendering strategy, and staged roadmap.

## Current scope

This is not presented as a complete map of the universe. No such complete catalogue exists. OmniAtlas is designed to grow into a map of known, sourced objects while making catalogue coverage, uncertainty, time, coordinate frame, and visualization scaling explicit.

## Data attribution

- Earth surface: NASA Earth Observatory, Blue Marble: Next Generation with topography and bathymetry.
- Earth clouds: NASA Visible Earth, Blue Marble cloud map.
- Moon color and elevation: NASA Scientific Visualization Studio CGI Moon Kit, derived from LRO WAC and LOLA products.
- Live Sun/Moon vectors and IAU rotational elements: Astronomy Engine 2.1.19.
- Earth coastlines: Natural Earth 1:50m physical vectors.
- Lunar crater names and coordinates: USGS Gazetteer of Planetary Nomenclature.

Full source and usage notes are in [docs/DATA_AND_COORDINATES.md](docs/DATA_AND_COORDINATES.md).
