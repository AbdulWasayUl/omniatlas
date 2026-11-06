# OmniAtlas documentation

These documents define the product: what it is for, how it is built, where its numbers come from, and what is still missing.

1. [PRODUCT_SPEC.md](PRODUCT_SPEC.md) — product boundaries, users, behavior, requirements, and acceptance criteria.
2. [ARCHITECTURE.md](ARCHITECTURE.md) — renderer boundaries, services, persistence, APIs, deployment, and observability.
3. [DATA_AND_COORDINATES.md](DATA_AND_COORDINATES.md) — object schema, reference frames, time, source provenance, and tiling/indexing.
4. [RENDERING.md](RENDERING.md) — precision, levels of detail, materials, lighting, picking, performance, and quality policy.
5. [ROADMAP.md](ROADMAP.md) — sequenced delivery plan and explicit exit criteria.
6. [PERFORMANCE.md](PERFORMANCE.md) — measured network cost of a cold boot, and the ranked work to reduce it.
7. [LIGHTHOUSE.md](LIGHTHOUSE.md) — the Lighthouse baseline, what each finding actually is, and what is worth fixing.

## Branching

Two long-lived branches, both deployed:

| Branch | Deploys to | What it is |
|---|---|---|
| `main` | production | Released work. Only ever receives merges from `dev`. |
| `dev` | preview | Integration. Everything lands here first. |

**Branch from `dev`, merge back into `dev`.** A release is `dev` merged into `main`,
which happens when the work on `dev` has been verified and is wanted live.

Nothing is pushed straight to `main`, and feature branches are deleted once merged, so
the remote carries exactly these two and the hosting provider builds exactly two previews.
Work is verified locally against a production build (`npm run build`, then
`npx vite preview`) before it merges to `dev`, and verified again on the `dev` preview
before it merges to `main`.

## Core decisions

- Build a truthful atlas of **known and sourced objects**, not an impossible claim of completeness.
- Keep physical values separate from render-space values. Any compressed distance or exaggerated size must be visible in the UI.
- Use a hierarchy of local coordinate frames and floating origins. Never put metre-scale terrain and megaparsec-scale catalogues in one floating-point scene.
- Use the renderer suited to the scale: Three.js for orbital/interstellar scenes, CesiumJS or an equivalent globe-tile engine for surface terrain.
- Make data provenance, epoch, coordinate frame, uncertainty, and licensing first-class fields.
- Stream and aggregate. The browser must never download an entire billion-row catalogue.

## Where the build stands

Milestone 1 (the sourced Sun–Earth–Moon foundation) is done and has been built on. The
app now carries the solar system, 329,860 stars, 14,026 deep-sky rows, the exoplanet
archive, a derived Milky Way, the Local Volume and the cosmic web, across eight
coordinate layers.

Still unbuilt: tiled planetary terrain (the `surface` rung), the heliosphere and Oort
cloud rungs, the observable-universe rung, mission-grade SPICE kernels, accounts, and a
backend catalogue API. [ROADMAP.md](ROADMAP.md) sequences them.
