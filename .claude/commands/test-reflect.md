---
description: Self-audit the tests you just wrote — deepen or delete. Run after any phase that added or changed tests.
---

Before we call this done: are there any HIGH VALUE tests that would catch actual bugs? We are NOT optimizing for coverage — only for tests that would fail when the behaviour they guard breaks. Take a step back. Now you have the whole picture.

If the current tests are shallow, either remove them or make them test what they are supposed to test. The bar isn't "passing"; it's "passing the right thing".

Audit every test you added or touched in this phase, plus related tests you read, against `CLAUDE.md` → Testing. **A test earns its place only if it would FAIL when the behaviour it guards breaks.**

For EACH test:

1. **Would it fail if the behaviour broke?** Mutate — mentally, or for real with a saved copy and `sed` — the guard it claims to protect: flip the condition, drop the check, return the wrong shape, coerce `auto` to `1:1`, remove the `.default()`. Does the test catch it, or pass anyway (theater)? **When you run a mutation for real, the kill criterion is a COUNTED failure — `N failed` — never a non-zero exit code.** A filter that matched no tests exits non-zero too. Read the count and check it against the tests you meant to run.
2. **Does it exercise the real path?** Tool behaviour through `connectTestClient()` (the real SDK validation runs), not by calling the handler's helpers directly. A mock that skips the seam under test masks exactly the layer being tested.
3. **Through the interface**, not implementation internals a refactor would legitimately change (error ordering, `undefined`-key presence, internal call order).
4. **Exact assertions where values are deterministic** — no bare truthiness where a value belongs; assert the discriminating value, not just "no exception". Remember the SDK returns schema failures as `isError: true`, not a rejection.
5. **Archetype, not duplicate.** One test proves a pattern shared by both tools. Don't test what `tsc` already verifies (`Record<ImageModel, ...>` completeness, enum membership) or what Zod, the MCP SDK, or Node already guarantee.
6. **Does an absence assertion prove anything?** "X must not be called / must not appear" passes for FREE against a mock that was never wired, an empty response, or a fixture that was never populated. Every "must not" needs a **presence assertion in the same medium** beside it, proving the medium could have shown X.

**Restore a mutation by writing the saved original back, never by `git checkout -- <file>`** — on a dirty tree that command also wipes your uncommitted work in the file, and the "restored" run goes red for a reason that reads like a real catch.

Then act, don't report intentions:

- **DEEPEN** any test a real bug would slip past — add the failure-path case, sharpen the assertion.
- **DELETE** any test that cannot catch a real bug — coverage padding is debt, not armor.
- **Log which** (test name → deepened/deleted/added → why, and the mutation results with counts) in your summary to the user.

"Green" is not the claim; "green and discriminating" is.
