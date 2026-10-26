# Expanding the atlas beyond the Milky Way

Research pass, 2026-10-26. Four parallel agents on galaxy structure, large-scale
structure, the Milky Way interior, and prior art; 53 datasets assessed. This document
records what is worth doing and in what order, and separates what was **verified against
this repo or the primary source** from what an agent **reported and nobody has checked**.

## 1. The problem is the layer model, not the catalogue

"We cannot go to other galaxies" is architecture, not a missing download.

Verified by reading the code: of the six layers, only `system` and `surface` ever
re-origin. Every `setOrigin` call site in the engine is one of those two
(`Engine.ts:418-419, 496-497, 508-509`). The other four hold a fixed origin, and their
distance bands are measured from it:

| layer | `bandMetres` | measured from |
|---|---|---|
| `galactic` | 0.05 kpc .. **1 Mpc** | the Sun |
| `stellar`  | 0 .. **3 kpc** | the Sun |

So beyond 3 kpc from the Sun the atlas contains no stars at all, in any galaxy, and
beyond ~1 Mpc the galactic layer switches off entirely — Centaurus A at 3.8 Mpc has
nothing but the cosmic layer's catalogue points. There is nothing to arrive at *by
construction*.

**Correction to an earlier claim in this session:** the galactic layer's origin is the
**Sun**, not the Galactic Centre. `src/modules/galaxy/index.ts:53-57` states it — every
OmniAtlas frame shares the solar origin and a frame fixes only axis directions — and the
galactocentric geometry is parented to one group so that vertices stay small. At Mpc
scale the 8 kpc difference changes no conclusion above, but it changes where the
re-origin work lands, so it is worth having right.

The encouraging half: `Layer.setOrigin(worldPosition, frame, anchorId)` is already
generic, and the engine already models "this layer re-origins onto the anchor" as
`bandMetres: null` (`anchorLocal` in `activateLayers`). Making `galactic` follow an
anchored galaxy is an extension of a mechanism that exists and is tested, not a new one.
`galaxy/index.ts:987` already says the quiet part: *"The galactic layer's origin never
moves today, but it costs one float64 subtraction a frame to stop depending on that."*

Precision is **not** the blocker. `galaxy/index.ts:711-714` already does the arithmetic:
M31 at 773 kpc in a kpc-unit layer is 773 render units, where a float32 ULP is ~6e-5
units against a galaxy 60,000 pc across.

## 2. The cheapest win ships today, at zero bytes

Measured directly from the shipped binaries:

- `public/data/deepsky/ngc.bin` — 14,026 rows: **10,682 carry a position angle**, 12,057
  a major axis, 11,089 a minor axis, 10,510 a distance.
- `public/data/universe/ungc.json` — 869 galaxies: **861 carry `axisRatio` and
  `inclinationDeg`**, plus `tType` and `a26ArcMin`.

Every ingredient for an oriented 3D disc — sky position, distance, physical diameter,
inclination, position angle, Hubble type — is already in the cold-boot payload and is
not drawn. Roughly ten thousand galaxies are rendered as direction-only shells or points
while the data to orient them sits in the same file.

This is a renderer change with no download, no build script and no licence question.
It should come before any new dataset.

### The honesty cost, which must ship with it

An inclination derived from an axis ratio is sign-ambiguous (+i and −i project to the
same ellipse), and a position angle is defined modulo 180°. That is a four-fold
ambiguity in the reconstructed orientation, and nothing in the data resolves it. Near-IR
axis ratios (OpenNGC's source) trace the old stellar population and read systematically
rounder than optical ones for dusty spirals.

`galaxy/field.json` already sets the standard — *"No point in this file corresponds to
any real star."* A galaxy manifest needs a sentence at the same temperature.

## 3. Licensing is the real blocker, and one existing claim is wrong

**`public/data/universe/LICENSE-DATA.md:10` asserts:** *"The CDS VizieR service makes its
data available under the Creative Commons Attribution 4.0 International licence (CC BY
4.0)."*

**That is incorrect.** Verified against the primary source
(<https://cds.unistra.fr/vizier-org/licences_vizier.html>), which says, verbatim:

> The data retrieved with VizieR are free of usage in a scientific context.

> The commercial usage of the data is subject to rules depending of the origin.

No Creative Commons licence is named anywhere in that document. VizieR is an *access
route*, not a licence grant: each catalogue's terms come from its origin.

This matters twice over. It is a factual error in a shipped file and should be corrected
regardless of whether the atlas expands. And it removes the assumed blanket permission
from most of the expansion candidates, since the majority are VizieR catalogues.

Agent-reported, unverified, and worth checking before relying on any of it:

- Confirmed permissive (CC BY 4.0 on Zenodo): Edenhofer+2024 dust, Dharmawardena 2024,
  UltracoolSheet, Galaxy Zoo DECaLS, Cosmicflows-4 density cube, PHAT XXI.
- No licence stated: Siena Galaxy Atlas, Legacy Survey DR9, Galaxy Zoo 2 / GZ DESI.
- Explicitly copyrighted with no grant: Green's supernova-remnant catalogue.
- CSIRO property: the ATNF pulsar database (only `psrcat` itself is GPL-3).
- CC BY-NC: Planck CMB maps — non-commercial, which fails the repo's stated bar.
- AMNH Digital Universe reserves written permission for redistribution in software.
- Celestia's galaxy templates are GPL-2.0 / NOASSERTION. The *technique* is free to
  reimplement; the PNGs are not free to take.

**Prefer Zenodo and project release pages over VizieR for anything new.** Where only
VizieR has it, either ask the maintainer or fetch at build time from the origin rather
than redistributing.

## 4. What nobody else does

Of every shipping astronomy visualiser studied, **not one resolves real stars in another
galaxy.** Celestia samples sprite clouds from greyscale Hubble-type templates. OpenSpace
and the AMNH Digital Universe draw a point that becomes a photograph of a *different*
galaxy of the same morphological type — 122 images serving 30,159 galaxies — and never
becomes three-dimensional. Stellarium has no fly-to. SpaceEngine's procedural galaxies
are billboards. Gaia Sky alone ships a real parameterised generator (MPL-2.0) and
generates M31 procedurally.

Two consequences. Generating a model galaxy concedes nothing — it matches the best system
in the field. And the one place this atlas could beat all of them is PHAT: HST resolved
photometry of real stars in M31, CC BY 4.0, ~2.6 MB for a 200k-star tier. No tool studied
does that.

The catch is structural and applies to every route into another galaxy: **no catalogue
anywhere gives a line-of-sight distance to an individual object inside M31, M33 or the
LMC.** Position and photometry are measurement; depth is always a disc model. The atlas's
current provenance vocabulary (`measured` / `derived` / `illustration`) does not quite
express "measured in two dimensions, modelled in the third", and should gain a way to.

## 5. Ranked plan

Ordered by value per byte and per unit of risk, not by astronomical interest.

1. **Draw the orientation already shipped.** ~10,700 deep-sky objects and 861 Local
   Volume galaxies become oriented, correctly-sized discs. Zero bytes, no licence
   question. Ship the four-fold-ambiguity note with it.
2. **Let `galactic` re-origin onto an anchored galaxy.** Add it to the `setOrigin` call
   sites and make its band conditional — Sun-relative when un-anchored, `null` when
   anchored on a galaxy, exactly as `system`/`surface` already behave. Revisit the
   near/far derivation at `Layer.ts:350-361`, which already warns that deriving near
   from the origin alone holds only when the camera is near that origin.
3. **Port a parameterised galaxy generator into a Web Worker.** Gaia Sky's is MPL-2.0.
   Generate on arrival from ~200 bytes of parameters rather than shipping ~520 kB of
   points per galaxy; `field.bin`'s own determinism guarantee (mulberry32, seed
   20190885) carries over unchanged. Drive it from the measured type, size, inclination
   and PA from step 1.
4. **The 3D dust volume** (Edenhofer+2024, CC BY 4.0 confirmed): ~2.1 MB as a 128³ uint8
   volume texture, ray-marched in the stellar layer. Reported as the single largest
   available change *inside* the Milky Way — it makes the space between the stars
   visible. Pair with Zucker 2020 (~15 KB) for the names: Orion, Taurus, Perseus.
5. **Open clusters with lazy member loading** (Hunt & Reffert 2024): ~280 KB for 7,167
   objects, 1,924 of them beyond the current 3 kpc wall, plus per-cluster member files
   fetched only on approach. Flying into the Pleiades resolves ~1,300 real Gaia members
   at zero cold-boot cost. De-duplicate its 132 globulars against Harris 2010 first —
   this repo has a history of double-labelling bugs. Use `J/A+A/686/A42`; CDS marked the
   2023 version obsolete.
6. **Shape for the large catalogues.** 2MRS's source table carries `Rext` and `b/a` that
   the build discards (+3 bytes/record, ~134 KB); 2MASX supplies the missing position
   angle on a key join. For CF4, note that `cf4.json`'s own field description says `pgc`
   is *"PGC id of the dominant galaxy in the group"* — so a HyperLeda shape join gives
   that member's shape, not the group's, and the manifest must say so. This settles an
   open question the research left hanging.
7. **Cosmic web structure**: the CF4 density cube (CC BY 4.0, ~2.1 MB as int8) for
   volume rather than points, then Tempel+2014 filaments and a void catalogue. This is
   the most direct answer to "there is nothing to arrive at" at the largest scale.
8. **PHAT, deliberately, last.** The ambitious move, after the generator, not before.

Not recommended: 2M++ without filtering its 3,813 synthetic Zone-of-Avoidance galaxies
(shipping invented objects would break the provenance contract outright); OpenSpace's
Milky Way volume (512 MB uncompressed, ~140× the entire current data budget); GAMA and
2dFGRS (footprints so narrow the user sees the survey's shape, not the universe's).

## 6. Open questions

- Does the licence correction in §3 change what is already shipped, or only what may be
  added? UNGC, CF4 and 2MRS are all in the atlas today under the incorrect claim.
- Is a `photometric_redshift` distance kind needed? Folding photo-z into
  `redshift_space` would misrepresent the error mode — random radial scatter of order
  40 Mpc at z=0.3, not coherent infall.
- How should "measured in two dimensions, modelled in the third" be expressed in the
  provenance vocabulary, given the inspector presents `measured` as a measurement?
