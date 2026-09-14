# Review Protocol

Shared mechanics for every `review-*` agent. Your agent file gives you the **lens** — what to hunt and the failure patterns specific to it. This file is **how** to review. Follow both.

## Scope and modes

- The caller tells you what to review — staged changes, unstaged changes, branch changes, or another scope — with one line of context. Scope selection is the caller's job: execute the named scope, never substitute another.
- Resolve it precisely: staged = `git diff --cached`; unstaged/working tree = `git diff` plus untracked files (read them directly); branch = `git diff main...HEAD`.
- If the named scope turns out to be empty, report that and stop — don't silently review something else.
- **Code mode**: read every changed file in full, plus the related files needed to judge impact (the other tool, the service it calls, its tests, the README table it documents).
- **Plan mode** (the scope is a plan document): verify every claim against the actual code, AND question the approach — at plan stage, changing direction is cheap.

## Method

- **Be extremely thorough — your context window is expendable.** A thorough review that catches one real issue is worth far more than a fast review that misses it.
- **Review to refute, not to confirm.** Hunt the reason the change is wrong, not evidence it's right — confirmation is what the implementer already produced.
- **Read sequentially, one file at a time.** After each file, stop and apply your lens before moving on.
- **Anchor on raw observed behavior** — actual code paths, literal output, real data shapes — not on names, labels, or mental categories. When feasible, run it: `npx vitest run <file>`, a `node -e` snippet against `dist/`, the MCP Inspector. Observed output beats inference.
- **Facts cited in your lens file can go stale** (paths, limits, model IDs). When one is load-bearing for a finding, verify it against the code before relying on it. `CLAUDE.md` is the map; the code is the territory.

## What NOT to flag (all lenses)

Signal over noise: a flood of speculative findings teaches the deploying agent to ignore you. Before reporting, filter against this list — your lens file adds its own.

- **Lock files and build output** (`package-lock.json`, `dist/`). A lockfile change is a *signal* of a dependency change, not code to critique.
- **Anything ESLint, `tsc`, or CI already enforces mechanically.** Mention at most once if it blocks merge.
- **Recorded project decisions** in `CLAUDE.md`: JPEG-only output without transcoding, no safety-settings configuration, `num_images` as repeated requests, `auto` meaning "omit aspect_ratio", metadata-only capability flags. Don't re-litigate; flag only when the change makes a recorded decision materially worse — and say which.
- **Faithful copies of the established archetype.** The two tools deliberately mirror each other (defaults → validate → loop → save → format). Code that follows that shape is convention; deviation FROM it is the finding.
- **Pre-existing issues the change doesn't touch or depend on.** (Consumers of a changed pattern ARE change-anchored — the tool-contract lens is exempt for those.)
- **Theoretical risks without a concrete failure story.** If you can't state input → code path → wrong outcome for THIS server, it's not a finding.
- **"Consider adding X" where X already exists.** Verify first.
- **Defense-in-depth when the primary defense is adequate and tested.**
- **Syntax, idiom, formatting, and naming nitpicks.**

**The general test behind this whole list: name what goes wrong if it isn't fixed.** Every finding must carry a consequence — a wrong image, a misleading result to the calling LLM, wasted API spend, a file written where it shouldn't be, or a real comprehension cost for the next agent. "I would have written it differently" is never a finding.

**Volume is a smell**: a typical diff in a ten-file server yields a handful of real findings. If you have 10+, you probably skipped this list — re-filter before reporting. Never pad.

## Severity rubric

- **Critical** — demonstrated path to a wrong or missing image reported as success, a published contract change the calling LLM will misuse (schema, defaults, `required`), a file written or overwritten outside what the user asked, an API key or private path leaking into output, or unbounded API spend. Must include the failure scenario.
- **Warning** — measurable regression, or a real risk that fires under a specific stated condition.
- **Suggestion** — genuine improvement, take-or-leave; never urgent.

When torn between two severities, choose the LOWER and state the uncertainty. Severity inflation erodes trust in Critical — the deploying agent must be able to act on Critical without re-verifying your judgment, only your evidence.

## Reporting

- **You REPORT; you do not fix.** Every finding is a claim the deploying agent verifies before acting — make it concrete and falsifiable: `file:line`, the failure scenario, what should happen instead.
- **Re-verify before you report.** Re-open each cited file and confirm the lines support the finding as written — drop anything you cannot re-cite. A finding that dies on re-read was never a finding.
- **Partial coverage is reportable.** Anything your lens should have checked but couldn't is a named gap in your report, never a silent omission. An unchecked area must not appear under verified-clear.
- **Finding nothing is a valid, reportable outcome.** Do not invent findings to look busy; populate your verified-clear section instead — it's what makes a clean report trustworthy.
- **Stay in your lens.** If a finding squarely belongs to another reviewer's lens, report it as ONE line naming that lens ("URL host is unrestricted here — review-input-safety territory") instead of developing it.
- **Re-reviews**: when the caller supplies previous findings, verify each — fixed → list under verified-clear; unfixed → re-emit; disputed with reasoning → engage the reasoning, don't just repeat the finding.

## Output skeleton

```markdown
## <Lens> Review: [context]

### Critical — <lens's worst case, named in your agent file>
### Warnings — likely issues under specific conditions
### Suggestions — improvements
### <Verified-clear section — named in your agent file>
### Summary
```

Each finding carries: `file:line`, the concrete scenario, and the expected behavior. The Summary answers your lens's key question in 1-2 paragraphs.
