<!--
Base this PR on `dev`, not `main`. See CONTRIBUTING.md.
-->

## What this does

<!-- One or two sentences. What changed, and what is now true that was not before. -->

## Why

<!-- The problem, or the issue number. Closes #N -->

## How to see it

<!--
A share URL from the address bar is the fastest way to put a reviewer where you were.
For a non-visual change, say what to run instead.
-->

## Checks

- [ ] `npm run lint` passes
- [ ] `npm test` passes
- [ ] `npm run build` passes (this is what type-checks — a green editor is not a green build)
- [ ] I opened the change in a production preview (`npm run build && npx vite preview`) and looked at it

## Review

- [ ] **`/review-pr` has been run on this branch and the verdict is PASS**

Required before merge, not advisory. See
[.claude/skills/review-pr/SKILL.md](https://github.com/AbdulWasayUl/omniatlas/blob/main/.claude/skills/review-pr/SKILL.md)
and the rule catalog in
[best_practices.md](https://github.com/AbdulWasayUl/omniatlas/blob/main/best_practices.md).
The review posts itself as a comment and updates in place on re-runs. `NEEDS CHANGES`
means fix the blocking findings and run it again; if you disagree with a finding, say so
on the PR citing its rule ID.

## Invariants

Tick the ones this change touches, and say below how it keeps them. Leave the rest blank.

- [ ] **Physical values stay physical** — no render-space fudge folded into a stored SI number
- [ ] **Vertex data stays small** — geometry within ~1e4 of its object origin; huge distances carried as direction × scalar
- [ ] **Provenance travels with the object** — `measured` / `derived` / `illustration` set correctly; no object placed at a distance nobody published
- [ ] **Drawn implies clickable** — everything newly drawn has a registered node, and nothing registered is undrawn
- [ ] **Attribution ships with the data** — licence file beside the data, terms in the manifest, row in the README table
- [ ] **Gaps stay labelled** — anything not built yet is visibly marked, not hidden

<!-- Notes on the ticked invariants: -->
