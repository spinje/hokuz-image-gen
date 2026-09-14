---
name: deep-review
description: "Deploy specialized review agents to find bugs that general code review misses. Runs 1-4 focused lenses scaled to the diff, evaluates their findings, and produces a concrete action plan. The falsifier (real API, paid) runs only on explicit opt-in."
argument-hint: "[N] [staged|unstaged|branch] [--falsify]"
---

# Deep Review — Specialized Multi-Agent Review

You are the orchestrator for this repo's review battery: deploy the lenses, evaluate their findings, produce a concrete action plan. This complements a general code review — deep-review targets the blindspot categories general review misses.

## Assess Scope

Honor an explicit ask (`staged`, `unstaged`, `branch`). Otherwise check `git status --porcelain`: both staged AND unstaged with nothing saying which → ambiguous, STOP and ask. Only staged → staged; only unstaged → unstaged (untracked files count); clean tree → branch vs `main`. Name the chosen scope in the review instruction — per `REVIEW-PROTOCOL.md` agents execute the named scope, never infer one.

**An empty target diff is a dispatch error, not a clean result.** When `--stat` for the chosen scope is empty, stop and fix the scope before launching anything.

## Scale the Battery — 1-4 lenses, never more

Gauge with `git diff --stat` (or `--cached --stat`, or `main...HEAD --stat`):

| Tier | Scope | Lenses |
|---|---|---|
| Trivial | ≤10 lines, ≤2 files | 1, or skip deep-review |
| Lite | ≤100 lines | 2-3 |
| Full | >100 lines, or a PR-ready branch | 3-4 |

Counts are **ceilings**: deploy only lenses whose dimension the diff actually touches. A docs-only diff gets `review-tool-contract` alone. A standalone number in the invocation (`3`) overrides the tier as an exact count.

**Sensitive changes get Full tier regardless of size:** anything in `file-utils.ts` (paths, fetch, writes), `gemini-client.ts` request building, or a schema/description change. Those must include `review-input-safety` or `review-tool-contract` respectively.

**Protect your context window.** Never read the diff or whole files yourself — the subagents have expendable windows. The `--stat`, the file list, and small targeted verification reads are the exceptions.

## Selecting Lenses

| Lens | Pick when the diff touches... |
|---|---|
| `review-silent-failures` | Response building, the request loop, `parseInteraction`, error mapping, fallbacks, tooling config — **strong default for most scopes** |
| `review-tool-contract` | Schemas, `TOOL_DESCRIPTION`s, `DEFAULTS`/`LIMITS`/models, README, CLAUDE.md, error text — **mandatory for any schema or description change** |
| `review-test-fidelity` | New or changed tests, bug fixes, tooling config |
| `review-input-safety` | `file-utils.ts`, anything that reads/writes/fetches, error strings, new dependencies — **mandatory for sensitive-set changes in that file** |
| `review-simplicity` | Full tier only, code mode, multi-step work |
| `review-falsifier` | **Outside the cap, paid, opt-in only** — see below |

## The Review Instruction

One or two sentences; it becomes each agent's prompt. Name the scope and the change:
`Review the staged changes (adding a seed parameter to both tools).` or `Review all changes on this branch vs main (tooling gate and CLAUDE.md rewrite).`

## Dispatch

Launch the selected lenses with the `Agent` tool, `subagent_type` set to the lens name, **all in one parallel call**. Each agent has detailed built-in instructions and follows `REVIEW-PROTOCOL.md`; don't restate any of it. Wait for every result before evaluating.

## The Execution Gate: `review-falsifier`

The one lens that RUNS the change against the real Gemini API. It costs money (its file carries the cap: Lite model, 1K, ≤8 calls). Dispatch it **only** when the invocation includes `--falsify` or the user explicitly asked in this conversation; never as a default and never in the same launch as the reading lenses. Run it LAST, after the reading battery's confirmed fixes have landed, so it attacks the state that will ship. Requires `GEMINI_API_KEY` in the environment and a fresh `npm run build`. Skip it when the diff carries no user-facing promise (docs, tooling, tests).

## Evaluate Findings

**Do not blindly trust the reviews** — agents can be wrong, miss context, or misread the code.

**1 — Inventory.** Per finding: what / where / severity / which lens(es). Merge duplicates, keeping the better evidence; two lenses on one area is strong signal. A lens with NO findings is signal — record its dimension under Areas Verified Clean. A lens that errored or returned nothing usable is NOT clean — name the coverage gap.

**2 — Verify Criticals** (and high-confidence Warnings) before accepting: open the cited file and confirm the claim — reviewers hallucinate lines and misread functions. Check the proposed fix against `CLAUDE.md`'s recorded decisions; a finding that re-litigates one is disputed by default. **Disputing a Critical takes the same rigor as confirming one**: a `file:line` counter-citation, never memory.

**3 — Classify** each finding:

| Verdict | Meaning |
|---|---|
| **Confirmed** | Real, proposed fix is sound |
| **Confirmed, different fix** | Real, but a better fix exists |
| **Disputed** | Doesn't exist or reviewer misunderstood — say why with evidence |
| **Needs investigation** | Can't determine without deeper analysis or user input |

**4 — Surface ambiguity; never silently resolve it**: findings under 90% confidence, fixes touching code you don't fully understand, decisions that belong to the user, findings that contradict each other.

## Present Action Plan

```markdown
## Review Summary

**Scope**: [staged/unstaged/branch — description]
**Lenses deployed**: [names]
**Findings**: [N confirmed, N disputed, N needs investigation]
**Verdict**: [ship / ship after confirmed fixes / needs work]

### Action Plan (ordered by priority)

#### 1. [Title] — [Confirmed / Confirmed, different fix]
- **Found by**: [lens(es)]
- **Issue**: [what's wrong]
- **File(s)**: [exact paths]
- **Fix**: [concrete enough to implement]
- **Tests**: [what to add or change]

### Disputed Findings
#### [Title] — Disputed
- **Found by** / **Claimed issue** / **Why it's wrong** (code evidence)

### Needs Investigation
### Suggestions
### Areas Verified Clean
```

**The verdict rubric is biased toward ship.** Suggestions never gate. Isolated warnings don't either — list them as follow-ups. "Needs work" requires a confirmed Critical, or multiple confirmed warnings forming a pattern. Don't let volume of minor findings masquerade as severity.

**After presenting** — conversational session: wait for approval before implementing (the user may reprioritize, dispute, or skip). Autonomous: implement confirmed fixes in priority order; skip disputed findings if uncertain.

## Re-Reviews

Reviewing a scope that already had a deep-review (new commits after fixes): give each lens its prior findings with the scope, plus: fixed → omit and note as resolved; unfixed → re-emit; user-rejected → respect, re-raise only if materially worsened. New code gets full scrutiny; unchanged verified-clean areas don't need re-reading.

## Running One Lens

A single specialist is fine when you suspect a specific issue class — one `Agent` call with the lens name.
