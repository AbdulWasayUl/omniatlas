---
name: review-pr
description: Use when reviewing a pull request on OmniAtlas, before approving or merging — mandatory on every PR. Checks all changed files against the rule catalog in best_practices.md, with particular attention to float64/float32 precision, layer and frame handling, provenance honesty, the drawn-implies-clickable invariant, GPU resource lifetime, and behavioural regressions; classifies findings by severity with stable rule IDs, then posts the review back to the PR as a comment.
---

# Review PR

Review all changes on the current branch against its base for OmniAtlas. The rule
catalog lives in **`best_practices.md` at the repo root** — the single source of truth.
Every finding MUST carry a stable rule ID (e.g. `OA-PREC-001`) so it can be referenced,
suppressed (`// oa-disable OA-PREC-001 — <reason>`), and argued with on the PR.

**This skill is mandatory on every pull request.** `CONTRIBUTING.md` and the PR template
both require a PASS verdict before merge. Do not treat a run as advisory, and do not skip
posting.

## Step 1: Gather context

```bash
# Resolve in order: PR base → upstream (only if it names a DIFFERENT branch) → dev.
# Two traps: a pipeline's exit status is its LAST command, so `git rev-parse … | sed`
# exits 0 even when rev-parse fails and a bare `|| echo dev` never fires; and a pushed
# feature branch's upstream is origin/<itself>, which would make MERGE_BASE == HEAD and
# review an empty diff.
CURRENT=$(git rev-parse --abbrev-ref HEAD)
BASE_BRANCH=$(gh pr view --json baseRefName -q '.baseRefName' 2>/dev/null)
if [ -z "$BASE_BRANCH" ]; then
  UP=$(git rev-parse --abbrev-ref '@{upstream}' 2>/dev/null | sed 's|^origin/||')
  [ -n "$UP" ] && [ "$UP" != "$CURRENT" ] && BASE_BRANCH="$UP"
fi
[ -n "$BASE_BRANCH" ] || BASE_BRANCH=dev    # repo default: branches PR back to dev
MERGE_BASE=$(git merge-base "$BASE_BRANCH" HEAD)   # pin to avoid rebase noise
COMMITS=$(git rev-list --count "$MERGE_BASE"..HEAD)
FILES=$(git diff --name-only "$MERGE_BASE"..HEAD | wc -l)
read ADDS DELS < <(git diff --shortstat "$MERGE_BASE"..HEAD \
  | awk '{for(i=1;i<=NF;i++){if($i~/insert/)a=$(i-1);if($i~/delet/)d=$(i-1)} print a+0,d+0}')
echo "Base=$BASE_BRANCH  MergeBase=$MERGE_BASE  Commits=$COMMITS  Files=$FILES  +$ADDS/-$DELS"

# Author intent — respect documented behaviour changes; don't flag them as regressions
gh pr view --json title,body,labels 2>/dev/null
```

Use `$MERGE_BASE..HEAD` (two-dot) for every diff. Never `git diff | wc -l` (counts hunk
headers).

**Base check:** OmniAtlas PRs target `dev`, never `main`. A PR based on `main` that is
not a `dev` → `main` release merge is itself a BLOCKING finding (`OA-SCOPE-001` context,
report it in the Summary).

**Branch hygiene:** if the branch is >20 commits behind base, ask the author to rebase
before deep review — the diff may be stale.

## Step 2: Choose review strategy

```bash
if   [[ $FILES -le 1  && $((ADDS+DELS)) -le 20 ]]; then STRATEGY=trivial
elif [[ $((ADDS+DELS)) -lt 400 && $FILES -lt 15 && $COMMITS -le 10 ]]; then STRATEGY=small
else STRATEGY=large
fi
```

- **trivial** — typo / flag / one-liner. Apply only §3.1, §3.13, §3.14, §3.16. Skip the rest.
- **small** — `git diff "$MERGE_BASE"..HEAD`; full checklist in one pass.
- **large** — do NOT dump the full diff. Instead:
  1. **Scope first.** `git diff --numstat "$MERGE_BASE"..HEAD` for per-file churn; read
     only the changed regions plus enough surrounding context to judge them.
  2. Group files by layer (`git diff --name-only "$MERGE_BASE"..HEAD`):
     - **Engine/core** → `src/core/` (Engine, Layer, world, labels, camera, render, names, scheduling)
     - **Catalogue module** → `src/modules/*/`
     - **Data & build** → `src/data/`, `src/format/`, `src/generators/`, `scripts/`, `public/data/`
     - **UI & state** → `src/ui/`, `src/state/`, `src/styles/`
     - **Tests & config** → `tests/`, `tsconfig*.json`, `vite.config.ts`, `vitest.config.ts`, `package.json`, `vercel.json`, `.oxlintrc.json`
  3. Dispatch one subagent per non-empty group using Appendix A. **Always pass
     `model: "sonnet"`** on every `Agent` call — review is parallel work across many
     files and Sonnet is the right cost/quality point. Do NOT inherit Opus from the parent.
  4. **Mandatory cross-layer synthesis subagent** (Appendix B) — finds contract
     mismatches the parallel reviewers cannot see. Also `model: "sonnet"`.
  5. Synthesise into one review (the orchestrator stays on whatever model was invoked).

## Step 3: Review checklist

**The rule catalog is `best_practices.md` at the repo root.** Read it and apply every
`OA-*` rule. Do not duplicate the rules here; this skill owns the *workflow*,
`best_practices.md` owns the *rules*. When a rule changes, edit that file only.

Output format per finding: `**[SEVERITY][RULE-ID]** path:LINE — short`.

Section map (used by the strategy above and the appendices):

| § | Domain | ID prefix |
| --- | --- | --- |
| 3.0 | Severity & scope | `OA-SCOPE-*` |
| 3.1 | Logic correctness & edge cases | `OA-LOGIC-*` |
| 3.2 | TypeScript & React | `OA-TS-*` |
| 3.3 | Precision & the world model | `OA-PREC-*` |
| 3.4 | Layers, frames & the camera | `OA-LAYER-*` |
| 3.5 | Provenance & honesty | `OA-PROV-*` |
| 3.6 | Registry, picking & labels | `OA-PICK-*` |
| 3.7 | three.js resources & the GPU | `OA-GL-*` |
| 3.8 | Data, assets & loading | `OA-DATA-*` |
| 3.9 | State & UI | `OA-UI-*` |
| 3.10 | Performance | `OA-PERF-*` |
| 3.11 | Styling & accessibility | `OA-A11Y-*` |
| 3.12 | Code quality & reuse | `OA-QUAL-*` |
| 3.13 | Comments & documentation | `OA-DOC-*` |
| 3.14 | Regression & contract changes | `OA-REG-*` |
| 3.15 | Tests | `OA-TEST-*` |
| 3.16 | Security & supply chain | `OA-SEC-*` |
| 3.17 | Valid exceptions (do NOT flag) | — |

**Trace impact with `Grep`/`Read`.** Before flagging duplication, search for the existing
implementation and cite it. Before flagging a contract change, search for the call sites.
Findings cite evidence, not assumptions (`OA-SCOPE-003`).

### Mechanical passes — run on every diff

Cheap, high-yield, and scoped to the changed files only. Repo-wide counts are known debt
and reporting them is noise (`OA-SCOPE-001`).

```bash
# Type looseness — OA-TS-001 / -002 / -003
git diff "$MERGE_BASE"..HEAD -U0 -- '*.ts' '*.tsx' | grep '^+' | grep -nE \
  '\bas any\b|: any\b|\bany\[\]|as unknown as|@ts-ignore|@ts-expect-error|\)!|\]!|\w!\.'

# Per-frame allocation — OA-GL-004. Check each hit's enclosing function: update(),
# preRender(), a raycast loop and a label pass are per-frame; init() is not.
git diff "$MERGE_BASE"..HEAD -U0 -- 'src/**/*.ts' | grep '^+' | grep -nE \
  'new THREE\.(Vector[234]|Matrix[34]|Quaternion|Euler|Color|Box3|Sphere|Ray)\('

# GPU lifetime — OA-GL-001 / -002. Anything created must be disposed somewhere.
git diff "$MERGE_BASE"..HEAD --name-only -- 'src/**/*.ts' | while read -r f; do
  [ -f "$f" ] || continue
  made=$(grep -cE 'new THREE\.(.*Geometry|.*Material|.*Texture|WebGLRenderTarget)\(' "$f")
  gone=$(grep -cE '\.dispose\(\)' "$f")
  [ "$made" -gt 0 ] && [ "$gone" -eq 0 ] && echo "$f: creates $made GPU resources, disposes none"
done

# Asset paths — OA-DATA-001. Every data/texture URL goes through assetUrl().
git diff "$MERGE_BASE"..HEAD -U0 -- 'src/**/*.ts' 'src/**/*.tsx' | grep '^+' | grep -nE \
  "fetch\(['\"\`]/|['\"\`]/(data|textures)/" | grep -v 'assetUrl'

# Hard-coded colour — OA-A11Y-002
git diff "$MERGE_BASE"..HEAD -U0 -- 'src/**/*.tsx' 'src/**/*.css' | grep '^+' | grep -nE \
  '#[0-9a-fA-F]{3,8}\b|\brgba?\(' | grep -v '\-\-'

# Left-behind logging in hot paths — OA-PERF-004
git diff "$MERGE_BASE"..HEAD -U0 -- 'src/**/*.ts' | grep '^+' | grep -n 'console\.'
```

**Precision pass — `OA-PREC-*`.** For every changed file that writes a buffer attribute
or a world position, read the surrounding code and answer two questions explicitly in
the review, even when the answer is "fine":

1. What is the largest magnitude that can land in a float32 vertex buffer here? If it can
   exceed ~1e4 from its object origin, that is `OA-PREC-001`, CRITICAL.
2. Is the camera-relative subtraction done in float64, before any downcast? If not, that
   is `OA-PREC-003`.

**Provenance pass — `OA-PROV-*`.** For any change that places, sizes or labels a
catalogue object: what distance was used, who published it, and does the node's
`provenance` say so? An object placed at a distance nobody published is `OA-PROV-001`,
CRITICAL, and it is the one defect this project exists to prevent.

**Clickability pass — `OA-PICK-001` / `-002`.** For any change that draws something new:
is there a registered node behind it, and does the node name every layer that draws it
(`alsoDrawnIn`)? For any change that registers something: does anything draw it? Both
directions.

**Comment-truth pass — `OA-DOC-001`.** For every changed function, read the comments
above and inside it. A comment that names its own consumer, its own caller, or a count,
where the PR changed that fact, is BLOCKING. This codebase's rationale comments are load
bearing; a confidently wrong one is worse than none.

**Test-value pass — `OA-TEST-*`.** Read the production behaviour and search existing
coverage before judging value or duplication. Cite exact test names and the failure each
protects against; recommend keeping, extending an existing case, or consolidating, with
evidence. Do not demand a test solely because the PR is a fix or adds a file — existing
coverage can satisfy the gate without a test delta.

## Step 4: Output

Per finding: `**[SEVERITY][RULE-ID]** path/file.ts:LINE — short name` then `Issue:` and
`Fix:` on the next two lines. **Blank line between findings.**

Emit sections only when non-empty (always emit Summary + footer):

1. **Summary** — 2–3 sentences: what the PR does, and the overall quality.
2. **Critical & Blocking Violations** — grouped by severity, at the top.
3. **Precision & World Model** (§3.3)
4. **Provenance & Honesty** (§3.5)
5. **Clickability & Labels** (§3.6)
6. **GPU Resources** (§3.7)
7. **Regression & Contract Changes** (§3.14) — flag for author confirmation when intentional.
8. **Data & Licensing** (§3.8, §3.16)
9. **Reuse / Duplication** (§3.12) — name the existing implementation.
10. **Comments & Docs** (§3.13)
11. **Accessibility** (§3.11)
12. **Performance Notes** (§3.10)
13. **Tests** (§3.15)
14. **Suggestions** — top 5 only; non-blocking.

### Checklist footer (always)

```text
Files reviewed:        N
Critical:              N
Blocking:              N
Warning-tier findings: N
Suggestions:           N

Verdict: PASS / NEEDS CHANGES / CRITICAL ISSUES
```

- **PASS** — no Critical/Blocking. Suggestions optional.
- **NEEDS CHANGES** — Blocking violations must be fixed before merge.
- **CRITICAL ISSUES** — correctness, precision, data-truth or security defects needing
  immediate attention.

## Step 5: Post the review to the PR (MANDATORY — always)

Posting the review as a PR comment is a **required final step of every review — not
optional.** Whenever a PR exists for the current branch you MUST post it; **never ask the
user for confirmation first, and never stop at "printing only" when a PR exists.** (Print
it to the user as well.) The only case where nothing is posted is when no PR exists for
the branch — then print the review and say so.

First write the full review you just produced — Summary → sections → footer/verdict — to
`/tmp/oa-review-body.md` (use the Write tool). Then run:

```bash
PR=$(gh pr view --json number -q .number 2>/dev/null) || PR=""
if [ -n "$PR" ]; then
  read OWNER REPO < <(gh repo view --json owner,name -q '"\(.owner.login) \(.name)"')
  # Prepend a stable marker so re-runs find & update THIS comment (not just the last one)
  { printf '<!-- oa-review -->\n\n'; cat /tmp/oa-review-body.md; } > /tmp/oa-review.md
  # PR-level comments live under the issues API
  CID=$(gh api "repos/$OWNER/$REPO/issues/$PR/comments" --paginate \
    --jq 'map(select(.body | startswith("<!-- oa-review -->"))) | last | .id // empty')
  if [ -n "$CID" ]; then
    # Update in place — atomic, no delete window. --raw-field reads the file as the value.
    gh api -X PATCH "repos/$OWNER/$REPO/issues/comments/$CID" --raw-field body="$(cat /tmp/oa-review.md)" >/dev/null
  else
    gh pr comment "$PR" --body-file /tmp/oa-review.md
  fi
else
  echo "No PR for this branch — printing review only, nothing posted."
fi
```

- **Idempotent by marker:** re-runs locate the previous comment via `<!-- oa-review -->`
  and `PATCH` it, so there is always exactly one review comment. Do **not** use
  `--edit-last` — it targets the author's most-recent comment regardless of content and
  can clobber an unrelated one.
- **Inline comments (Critical & Blocking only):** for findings whose `path:LINE` lies in
  the diff, also post line-level comments so they attach to the code:

  ```bash
  read OWNER REPO < <(gh repo view --json owner,name -q '"\(.owner.login) \(.name)"')
  HEAD_SHA=$(git rev-parse HEAD)
  # per finding: path=FILE, line=LINE
  gh api "repos/$OWNER/$REPO/pulls/$PR/comments" -X POST \
    -f body="**[SEVERITY][RULE-ID]** short — Issue / Fix" \
    -f commit_id="$HEAD_SHA" -f path="$FILE" -F line="$LINE" -f side=RIGHT
  ```

  Skip any finding whose line is not in the diff (the API rejects those) and leave it in
  the summary comment only. Don't inline Warnings or Suggestions — they bury the diff.
- Posting to a PR is an outward-facing action; it runs only when a PR exists for the
  current branch. Never invent a PR number.

---

## Done gate

- [ ] Every finding: `**[SEVERITY][OA-XXX-NNN]** path:line` + Issue + a copy-paste-ready
      Fix. No invented IDs — every ID exists in `best_practices.md`.
- [ ] The precision, provenance, clickability and comment-truth passes were each run and
      are each answered in the review, even where the answer is "no findings".
- [ ] Pre-existing debt in lightly-touched files demoted to Suggestion (`OA-SCOPE-001`).
- [ ] Verdict is exactly PASS / NEEDS CHANGES / CRITICAL ISSUES per the rubric.
- [ ] Review posted to the PR idempotently (marker + PATCH flow in Step 5).

## Appendix A — Per-layer subagent prompt

**Dispatch with `model: "sonnet"` on the `Agent` tool call.** Never omit the override —
the parent may be Opus, but review work runs on Sonnet.

```text
You are reviewing a subset of a TypeScript + three.js + React PR for OmniAtlas, a
browser-based 3D atlas of catalogued space.

Base branch: {BASE_BRANCH}
Merge base:  {MERGE_BASE}
Your files:  {FILE_LIST}
Layer:       {LAYER_NAME}   # Engine/core | Catalogue module | Data & build | UI & state | Tests & config

Context you need before judging anything:
- Positions are float64 metres in SI. The GPU sees float32. The scene is split into
  eight layers, each with its own unit, origin and camera, and a floating origin keeps
  every vertex buffer within ~1e4 of its object origin.
- Every object carries provenance: measured / derived / illustration. An object with no
  published distance is drawn as a hollow ring on a direction-only shell, never placed
  at an invented distance.
- Anything drawn has a registered, clickable node behind it, and vice versa.

Steps:
1. git diff {MERGE_BASE}..HEAD -- {FILE_LIST}
2. Read the current version of each file (size + context), and read the doc comments —
   they carry the reasoning and they are part of the contract.
3. Apply the rule catalog in best_practices.md (repo root) §3, focusing on:
   - Engine/core        → 3.1, 3.3, 3.4, 3.6, 3.7, 3.10, 3.13, 3.14
   - Catalogue module   → 3.1, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.13
   - Data & build       → 3.5, 3.8, 3.14, 3.16
   - UI & state         → 3.2, 3.9, 3.11, 3.12, 3.13
   - Tests & config     → 3.15, 3.12 (QUAL-007), 3.16
4. Before flagging duplication: Grep for an existing implementation and cite path:line.
5. Before flagging a contract change: Grep for callers and import sites to confirm impact.
6. For any changed buffer write or world position, state the largest magnitude that can
   reach a float32 buffer, and whether the camera-relative subtraction happens first.

Output strictly (nothing else):
  **[SEVERITY][RULE-ID]** path:line — short name
  Issue: ...
  Fix: ...
  <blank line>
If no findings for your files, return exactly: NO_FINDINGS
```

## Appendix B — Cross-layer synthesis prompt

**Dispatch with `model: "sonnet"` on the `Agent` tool call.**

```text
You are performing cross-layer contract synthesis for an OmniAtlas PR.

Merge base: {MERGE_BASE}
Layer findings already collected: {COLLECTED_FINDINGS}

Find ONLY contract mismatches between layers:
1. A field added to or re-meant on SceneNodeHandle / AtlasModule / LayerConfig /
   FrameContext (src/core/Engine.ts, src/core/Layer.ts) vs. every module that writes or
   reads it. Pay particular attention to radiusMetres / framingRadiusMetres /
   drawnRadiusMetres / shapeRatio — the four are not interchangeable and each one's doc
   comment says why.
2. A module draws something in a layer its node does not name, including via alsoDrawnIn
   (silently unclickable content).
3. A data file layout changed in scripts/build-*.mjs vs. the decode in src/modules/* and
   the manifest in public/data/*/ — all three must move together.
4. A node id, designation key or search key changed vs. src/state/urlState.ts and
   anything that resolves ids from a share URL (share links break).
5. A URL parameter added, renamed or re-meant vs. its reader and writer in urlState.ts.
6. A label-engine constant or scoring change vs. the tests that pin label and hit
   behaviour (tests/unit/label-*.test.ts, hover-feedback.test.ts).
7. A style token changed in src/styles/tokens.css vs. scripts/check-contrast.mjs and the
   ratios stated in that file's comments.

Tools: Grep (call sites, import sites, id usages repo-wide), Read (confirm shapes).
Do NOT re-run layer checks.

Output in the same strict format as Appendix A, with a blank line between findings.
```
