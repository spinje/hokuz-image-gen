# Agent maintenance notes

Maintainer-facing. NOT loaded by the agents themselves — runtime mechanics live in `REVIEW-PROTOCOL.md`; dispatch and evaluation live in `.claude/skills/deep-review/SKILL.md`.

## Shape of the battery

Six lenses, direct `Agent` launch only. Five read; one (`review-falsifier`) executes. Error-surface, validation-consistency, and impact-completeness concerns are folded into `review-tool-contract`, because in a two-tool MCP server they are one question: do the LLM-facing surfaces agree?

## Model and effort

No lens pins a `model`; each inherits the session's model. If review quality on a cheaper session model turns out to matter, pin `model: opus` on the open-ended lenses first (`silent-failures`, `falsifier`, `input-safety`) — those do reasoning beyond their checklist. `test-fidelity`, `simplicity`, and `tool-contract` are well-scaffolded and tolerate a mid model.

## Fact freshness

Lens files embed verified facts about this codebase (limits, model IDs, which functions own which behavior, the "known pre-existing behaviors" lists). They decay. Per root `CLAUDE.md`'s instruction-file rule, a task that invalidates a fact a lens cites updates that lens as part of the task. `review-tool-contract` treats these files as one of the hand-maintained surfaces it checks.

## The falsifier costs money

`review-falsifier` calls the real Gemini API. Its own file carries the cost rails (Lite model, 1K, a hard call cap). Never dispatch it as a default; the deep-review skill requires an explicit opt-in per run.
