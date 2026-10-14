# Data licence — public/data/smallbodies/

## Source

NASA/JPL Small-Body Database (SBDB) Query API
https://ssd-api.jpl.nasa.gov/sbdb_query.api
API documentation: https://ssd-api.jpl.nasa.gov/doc/sbdb_query.html
API version: SBDB Query API 1.0 (2021 August)
Retrieved: 2026-10-14

Files produced from this source:

- `named.json` — 1320 notable named asteroids and comets with full osculating elements
- `belt.bin` + `belt.manifest.json` — 80598 main-belt bodies (H <= 15.2), Float32 struct-of-arrays

## Licence

Public domain (work of the U.S. Government, NASA/JPL-Caltech). Courtesy credit requested.

Data produced by the Jet Propulsion Laboratory, California Institute of Technology,
under contract with NASA, are works of the U.S. Government and are not subject to
copyright protection in the United States. JPL requests courtesy attribution.

See JPL's image/data use policy: https://www.jpl.nasa.gov/jpl-image-use-policy

## Exact attribution string the UI must display

> Orbital and physical data: NASA/JPL Small-Body Database (SBDB), Jet Propulsion Laboratory / California Institute of Technology.

Short form, acceptable where space is constrained:

> Small-body data: NASA/JPL-Caltech SBDB

## Notes

- Elements are **osculating** two-body elements in the heliocentric IAU76/J2000
  ecliptic frame (SBDB `equinox` = J2000). They are valid near their epoch of
  osculation and drift from the true trajectory away from it.
- `belt.bin` shares one epoch for all records; it is in `belt.manifest.json`
  under `epoch.julianDayTdb`.
- `named.json` carries a **per-object** epoch, because comets and NEOs are
  osculated at their own solution epochs.
- Nothing in this directory is fetched at runtime; the SBDB endpoint sends no
  `Access-Control-Allow-Origin` header and cannot be read from a browser.
