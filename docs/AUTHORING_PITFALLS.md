# Authoring pitfalls

A deterministic macro is only as good as the assumptions frozen into its
handler. A macro passes its recorded fixtures, clears the benchmark, ships —
and then fails the first time it meets a surface that is stricter, more
stateful, more multi-tenant, or larger than the one it was recorded against.

None of these failures are reasoning failures. The weak model routed
correctly every time. They are *encoding* failures: the strong model that
wrote the handler baked in something that was true at record time and false at
run time. That is exactly the class of bug the pattern is supposed to make
cheap — you pay to fix it once, in the macro, instead of once per request — so
it is worth naming the recurring shapes.

This document is the field complement to [`THE_PATTERN.md`](THE_PATTERN.md): the
theory says *move the reasoning offline*; these are the seven ways the offline
encoding silently rots, and the authoring rule that closes each.

---

## 1. Freeze nothing the target owns

**The failure.** A handler that drives a third-party surface captures values at
record time — a dropdown's option label, a category ID, a shipping-template
name, a tenant-specific token, a locale-dependent enum (`"normal"` vs `"普货"`,
`"No"` vs `"否"`). Recorded in tenant or locale A, the macro writes those exact
strings into tenant or locale B, where they are not valid options. The surface
does not error helpfully — it drops the field, rejects the row, or silently
substitutes a default.

This is the most common way a macro that "works" fails in production, and it is
a refinement of the pattern's own claim. Recording at the *semantic* level —
typed tool calls with named arguments — is necessary but not sufficient. The
argument *values* a handler writes into a target must be resolved at run time
from the target's own candidate set, not frozen from the recording.

**The rule.** Treat every record-time capture of a target-owned value as an
*example*, not a constant. At handler time, read the live candidate set — the
dropdown's current options, the API's enum, the account's actual templates —
and select from it (exact match, then a documented fallback). Validate every
value you are about to submit against that live set *before* the irreversible
step. A macro that writes a value the target did not offer is a latent
multi-tenant bug.

## 2. Validate emitted artifacts against the real consumer

**The failure.** A macro produces a file or payload — a spreadsheet, an
archive, a structured document — that a strict downstream parser then ingests.
The artifact opens cleanly in a lenient local viewer, so it looks correct. The
strict consumer rejects it and answers with an *ambiguous non-error*:
"ignored," "0 rows processed," a queued job that never registers. Days are lost
because "it opens on my machine" was mistaken for "it is valid."

Archive and document builders are repeat offenders: a zip writer that skips
dotfiles silently omits a required metadata entry (`_rels/.rels` in OOXML, a
manifest, a relationship file); an entry-ordering change breaks a parser that
expects the directory first. Lenient viewers repair these on the fly; strict
backends do not.

**The rule.** Validate emitted artifacts against the *actual* consumer, or a
faithful proxy of its parser, inside the macro's test fixtures — not against a
forgiving local application. If the real consumer is reachable, a recorded
round-trip that asserts "the downstream registered/accepted it" is worth more
than a hundred assertions about the bytes. "Opens locally" is a false positive.

## 3. Make every UI step idempotent

**The failure.** A handler re-invokes an action whose effect already happened.
It clicks "open panel" on an already-open panel and closes it; it re-runs a
claim and toggles it back to unclaimed; a retry after a flaky step double-fires
a toggle. The macro reports success while having undone its own work — the
worst kind of silent failure, because the failure context is empty.

**The rule.** Read state before you act. Gate every toggling or
already-may-have-happened step on an observed precondition: open the panel only
if it is closed; submit only if not already submitted; claim only if not
already claimed. Idempotency is not optional in a handler that can be retried —
and in a weak-model deployment, handlers are retried.

## 4. Size your transfers

**The failure.** A handler passes a large value — an inlined file, a big base64
blob, a long DOM payload — through a transport with an undocumented size
ceiling (a single `eval`, one RPC frame, an inline argument limit). Small
inputs work in every test; the first multi-megabyte real input is silently
truncated or rejected, and the failure looks like a content bug rather than a
size bug.

**The rule.** Do not assume a single round-trip for variable-size data. Chunk
large payloads, or stream them, and test the macro with an input at the high
end of the real distribution — not the convenient small fixture.

## 5. Budget timeouts per operation, not globally

**The failure.** A single dispatcher-wide timeout (say 60 seconds) kills a step
that is *legitimately* long — a multi-minute import poll, a slow third-party
render, a large export. The macro is correct; the budget is wrong. The symptom
(a timeout) misdirects debugging toward the transport.

**The rule.** Budget timeouts per macro and per step. A step that polls a slow
backend declares its own budget; the global default is for the common fast
case, not the ceiling. Make the budget a parameter of the handler, visible in
review.

## 6. Fail honestly; never let the model fabricate success

**The failure.** Two halves, and a deployment hits both:

- **The handler collapses a real failure into "done."** A bulk operation
  returns "0 of 1 published" or per-row rejection reasons, and the handler
  reports success anyway. The failure-context contract (THE_PATTERN §3) exists
  precisely to carry these — squashing them blinds the recovery loop.
- **The weak model parrots a prior success.** Asked to perform a step, the
  model emits a confident "done!" copied from an earlier success in the
  conversation history, having run no tool at all. This is the weak-model
  failure mode the bail-out detector is built to catch — and the deterministic
  route is the cure: when the turn maps to a macro with zero runtime reasoning,
  there is no inference for the model to hallucinate from.

**The rule.** The handler must surface the downstream's *actual* outcome —
including ambiguous "ignored" states and per-item rejection reasons — in
structured failure context, never a flattened boolean. And the surrounding
runtime must route success-bearing operations deterministically, so the report
the user sees comes from the tool, not from the model's reading of the chat.

## 7. Treat reference data as perishable

**The failure.** A macro filters or classifies against a lookup table — a
blocklist, a category tree, an allow-set — and silently passes anything the
table does not cover. The table is never complete: new entities appear that no
one has added yet, and the gap is invisible because "not in the blocklist"
reads identically to "verified safe."

Macrokit ships [`@macrokit/reference-data`](../packages/reference-data) with
versioned, signed bundles for exactly this reason — but versioning solves
*provenance*, not *coverage*. A signed bundle can still be stale.

**The rule.** Build a coverage discipline around any reference set a macro
depends on. A macro that classifies against a list should *log what it could
not classify* rather than silently pass it, so the uncovered tail is visible
and the bundle gets refreshed on a cadence. Assume every reference table is out
of date by exactly the entities you most need it to contain.

---

## Why the benchmark can't show these

A pre-registered synthetic benchmark answers "can a weak model route to the
right macro?" — and the answer is yes. None of the seven pitfalls above are
routing failures. They surface only when a real handler meets a real surface
that is strict (pitfall 2), stateful (3), multi-tenant or multi-locale (1),
large (4), slow (5), partial (6), or open-ended (7).

That is the deeper reason the [distillation gate](THE_PATTERN.md#5-the-distillation-gate)
matters. Each of these is a one-time encoding cost — paid once, in the macro,
and amortized across every future execution. The discipline is what converts a
production incident into a permanent property of the library, instead of a
lesson the next author re-learns.

## Further reading

- [`THE_PATTERN.md`](THE_PATTERN.md) — the full argument, including §8 honest
  limitations.
- [`CONTRIBUTING_MACROS.md`](../CONTRIBUTING_MACROS.md) — packaging and
  publishing a macro library.
- [`WHY_IT_WORKS.md`](WHY_IT_WORKS.md) — the cognitive-science framing.
