# Contributing to OmniAtlas

Thanks for looking. OmniAtlas is a map of catalogued space that tries not to lie about
what it knows, so most of what follows is about keeping that true while the code grows.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Getting set up

```bash
npm install
npm run dev
```

Node 20 or newer. Everything runs against the static files in `public/` — no server, no
account, no API key. The data build scripts in `scripts/` re-fetch the upstream
catalogues; you do not need to run them to work on the app.

## The branch model

Two long-lived branches, both deployed:

| Branch | Deploys to | What it is |
|---|---|---|
| `main` | production | Released work. Only ever receives merges from `dev`. |
| `dev` | preview | Integration. Everything lands here first. |

**Branch from `dev`, open the pull request against `dev`.** A release is `dev` merged
into `main`, once the work on `dev` has been seen working on the preview. Nothing is
pushed straight to `main`. Feature branches are deleted once merged, so the remote
carries exactly those two.

## Before you open a pull request

All three must pass:

```bash
npm run lint    # oxlint, plus the contrast checker for any UI colour
npm test        # the unit suite
npm run build   # tsc -b and a production build
```

`npm run build` is the one that type-checks: `tsconfig.app.json` is the config that
actually covers `src/`, and `tsc -b` is what runs it. A green editor is not a green
build.

Then look at it. Run `npm run build && npx vite preview` and open the thing you changed.
A render change that was never rendered is not finished.

## What a change has to respect

These are the invariants the codebase is built on. A pull request that breaks one needs
to say so and say why.

**Physical values stay physical.** Positions are float64 metres in SI. Anything
compressed, exaggerated or scaled for legibility is a render-space value, is kept
separate, and is visible in the UI. Never fold a fudge factor into a stored number.

**Vertex data stays small.** The GPU sees float32. Every geometry keeps its coordinates
within about 1e4 of its own object origin, and the floating origin does the rest. Where a
catalogue needs a huge distance, store a unit direction and a scalar and multiply in the
shader, the way the deep-sky buffers do.

**Provenance travels with the object.** A node says where its numbers came from —
`measured`, `derived`, or `illustration` — and the inspector shows it. An object with no
published distance is drawn on the direction-only shell as a hollow ring. Do not place
something at a plausible-looking distance to make a view prettier.

**Drawn implies clickable.** If the renderer puts a thing on screen, there is a
registered node behind it and a click selects it. The reverse also holds: a registered
node that nothing draws is dead weight. `tests/unit/deepsky-clickable.test.ts` pins this
for the deep-sky module; new catalogue modules should pin it too.

**Attribution is part of the data.** A new dataset ships with its licence file beside it
in `public/data/<set>/`, its terms recorded in the manifest, and a row in the README
table. Check the terms allow redistribution before adding anything.

**Honesty about gaps.** A feature that is not built yet is labelled as not built, not
hidden. That is why four scale-ladder rungs ship greyed.

## Code style

- TypeScript throughout; `any` needs a reason in a comment.
- oxlint is the linter and its config is `.oxlintrc.json`. Do not add a second one.
- Comments explain *why*, not *what*. The codebase leans on long rationale comments at
  the points where the reasoning is not recoverable from the code — keep that habit, and
  keep them true: a comment that describes its own consumer wrongly is a bug.
- Tests live in `tests/unit/`. They run in Node with no browser, so they test maths,
  data shape, state and module wiring rather than pixels.

## Commits

One idea per commit. Write the subject as what the change *does*, in the present tense,
as a sentence — the log reads that way already:

```
Draw the rows with a published distance at that distance
Answer a hover on a halo with the broken ring, not a closed one
```

## Review

**Every pull request is reviewed with the `/review-pr` skill before it is merged.** It
is not optional and not advisory — see
[.claude/skills/review-pr/SKILL.md](.claude/skills/review-pr/SKILL.md). It checks the
diff against the rule catalog in [`best_practices.md`](best_practices.md), tags each
finding with a stable rule ID, and posts the review to the PR.

Run it yourself before asking for a human look:

```
/review-pr
```

The verdict must be **PASS** before merge. `NEEDS CHANGES` means fix the blocking
findings and re-run; the review comment updates in place. If you disagree with a finding,
say so on the PR with the rule ID — the catalog is meant to be argued with and edited,
not worked around.

## Reporting things

Bugs and ideas both go to [Issues](https://github.com/AbdulWasayUl/omniatlas/issues).
For a wrong position, a wrong label or a mis-sourced object, the templates ask for the
share URL from the address bar — it carries the exact view, so it is usually enough to
reproduce the problem on the first try.
