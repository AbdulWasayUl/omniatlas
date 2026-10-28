# Data sources and attribution — public/data/universe/

Everything in this directory was produced by `scripts/build-universe.mjs` on 2026-10-14.
The UI MUST display the attribution strings below wherever these layers are rendered.

## Service acknowledgement (required for all three catalogues)

> This research has made use of the VizieR catalogue access tool, CDS, Strasbourg, France (DOI: 10.26093/cds/vizier). The original description of the VizieR service was published in A&AS 143, 23 (2000).

VizieR does not place the catalogues it distributes under one blanket licence. Data retrieved
through it are free to use in a scientific context, on the condition that the original authors and
the publishing journal are cited; VizieR is explicit that omitting a pertinent author or reference
is unacceptable, and that this applies to press releases, websites and podcasts as much as to
papers. Whether a copyright applies to a given catalogue depends on that catalogue's origin and is
recorded, where one exists, in its VizieR ReadMe. Commercial use is governed by those same
origin-specific terms rather than by VizieR. Each catalogue used here is cited individually below.

## ungc.json — Updated Nearby Galaxy Catalog

- VizieR catalogue: `J/AJ/145/101`, table `catalog`
- Reference: Karachentsev I. D., Makarov D. I., Kaisina E. I. (2013), *Updated Nearby Galaxy Catalog*,
  AJ 145, 101. Bibcode 2013AJ....145..101K.
- **Attribution string:** `Updated Nearby Galaxy Catalog — Karachentsev, Makarov & Kaisina (2013), AJ 145, 101, via VizieR (CDS)`

## cf4.bin / cf4.json — Cosmicflows-4 group catalogue

- VizieR catalogue: `J/ApJ/944/94`, table `groups` (published tables 3 and 4, merged by CDS)
- Reference: Tully R. B., Kourkchi E., Courtois H. M., Anand G. S., Blakeslee J. P., Brout D.,
  de Jaeger T., Dupuy A., Guinet D., Howlett C., Jensen J. B., Pomarede D., Rizzi L., Rubin D.,
  Said K., Scolnic D., Stahl B. E. (2023), *Cosmicflows-4*, ApJ 944, 94. Bibcode 2023ApJ...944...94T.
- **Attribution string:** `Cosmicflows-4 — Tully et al. (2023), ApJ 944, 94, via VizieR (CDS)`

## 2mrs.bin / 2mrs.json — 2MASS Redshift Survey

- VizieR catalogue: `J/ApJS/199/26`, table `table3`
- Reference: Huchra J. P., Macri L. M., Masters K. L., et al. (2012), *The 2MASS Redshift Survey —
  Description and Data Release*, ApJS 199, 26. Bibcode 2012ApJS..199...26H.
- 2MRS is built on the Two Micron All Sky Survey, a joint project of the University of Massachusetts
  and IPAC/Caltech, funded by NASA and the NSF. 2MASS requires this acknowledgement.
- **Attribution string:** `2MASS Redshift Survey — Huchra et al. (2012), ApJS 199, 26, via VizieR (CDS); 2MASS: UMass / IPAC-Caltech, NASA / NSF`

## cosmology.json — Planck 2018 cosmological parameters

- Reference: Planck Collaboration, Aghanim N. et al. (2020), *Planck 2018 results. VI. Cosmological
  parameters*, A&A 641, A6. arXiv:1807.06209. Bibcode 2020A&A...641A...6P.
- H0-tension alternative: Riess A. G. et al. (2022), ApJ 934, L7. Bibcode 2022ApJ...934L...7R.
- Parameter values are numerical facts quoted from the published papers; derived distances in the
  file are computed by this repository from those values.
- **Attribution string:** `Cosmology: Planck 2018 VI (Planck Collaboration 2020, A&A 641, A6); H0 tension: Riess et al. (2022), ApJ 934, L7`

## Distance-kind contract

No record in this directory carries a bare "distance". Every one declares its kind:

| kind | meaning |
|---|---|
| `trgb_cepheid` | tip-of-the-red-giant-branch or Cepheid; the best rungs of the ladder |
| `geometric` | maser or detached eclipsing binary; no ladder assumed |
| `luminosity_distance` | from a distance modulus / secondary standard candle |
| `inherited` | adopted from the host group, not measured for this object |
| `redshift_space` | from recession velocity and a Hubble-flow model; contains peculiar-velocity distortion |
| `comoving` | integrated from the frozen cosmology (cosmology.json); used only for the CMB shell |
