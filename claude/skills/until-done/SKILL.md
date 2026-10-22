---
name: until-done
description: Use when the user invokes /until-done, or asks for work to be run to completion autonomously without check-ins - "keep going until it works", "don't stop until it's done", "work autonomously", "finish it end to end", "hard mode", "take your time and get it right".
---

# Until Done

Work slowly, methodically and rigorously until the task is actually complete. Do not stop to check in.

## Start

Before anything else, write the goal as the first task and keep it in progress until you stop:
what done looks like, in a sentence the user would agree with, and what is out of scope. Reread it
after each commit, whenever you see a compaction summary, and before you decide you're finished. Long runs drift, and this is how you notice.
When the context is getting full, add a note to yourself there: what is verified, what is in
flight, what comes next.

## Working

Read before you touch anything. Trace the real flow, reproduce the current behavior yourself.
No vibes, no memory, no confident guessing — the cost of understanding is bounded, the cost of a
confident wrong fix is not.

Smallest change that fits what is already there. Verify each step before starting the next; never
stack unverified work, because a bug three steps back costs ten times more to find.

Work in a worktree on its own branch, and commit each step once it is verified, so an interrupted
run loses nothing and the user can review or revert one step at a time. If the task builds on
uncommitted changes in the current checkout, work there instead and commit only your own hunks.
Other sessions may be working in the same repo: leave their files, branches and worktrees alone.

An experiment still needs a result that would change what you do next. Checking your own change is
not an experiment; that always runs.

## When you think you're done, you aren't

If the deliverable is an answer (research, a diagnosis, a review), done means the question asked
has an answer, which may be "unresolved, and here is what would settle it", and every claim in it
has been checked against the primary material: the code, the data, the log. The rest of this
section is for code.

Thinking you're done is where the work starts. Attack your own code:

- **Boundaries** — empty, one, many, huge, zero, negative, off-by-one.
- **Malformed input** — wrong type, wrong encoding, unicode, nulls, whitespace, duplicates.
- **Error paths** — force every failure branch to actually execute. Untriggered error handling is unverified code.
- **State** — run it twice, from clean, out of order, interrupted.
- **Real data** — not the toy example you developed against.
- **Name versus behavior** — does each function actually do what its name claims? A sort running
  backwards passes every other test you can write.
- **Hostile diff read** — reread your own diff as someone trying to get it rejected.

Fix what you find at the root, not the symptom — grep every caller, or the same bug comes back next
week wearing a different hat. Then stress test again: fixes create bugs, and re-run everything, not
just the check that failed.

Repeat until you get a pass where you genuinely tried to break it and found nothing. A clean pass
straight after a pass that found bugs is luck, not evidence — get another one.

Evidence has to postdate your last edit. Output from before your most recent change is a memory.

## Clean before you call it done

Cleaning is part of complete, not polish afterwards. On the code you wrote or changed:

- Delete dead code, unused parameters, debug prints, commented-out code.
- Collapse one-caller abstractions, one-implementation interfaces, config for values that never change.
- Inline single-use helpers. Delete the wrappers and shims you added.
- Remove defensive `try/except` and fallbacks that hide bugs rather than surface them.
- Keep comments that say *why*. Delete the ones restating the code.

Pre-existing mess you did not touch: mention it, don't fix it.

Then stress test again — cleaning is a code change like any other.

## Stopping

Two ways to stop. Nothing else counts.

1. **It's complete** — you ran the checks, they pass, the code is clean, and you cannot name a
   single path you failed to test. Actually try to name one. If you can, go test it. For an
   answer: every claim is checked, and you cannot name one you didn't check.
2. **A true blocker** — you need something only the user has, *and* guessing would be unsafe or
   would make the work worthless if wrong.

**Not blockers:** ambiguity you could resolve by reading the code; a design choice with an obvious
default (pick it, record it as a ruling, move on); something you could just try and see; being tired of it;
a long context; the job turning out bigger than you expected.

"Want me to keep going?" is not a stopping condition — you already know the answer. Before asking
anything real, finish everything the question doesn't block, then ask it all at once with your
recommended default for each.

Record each ruling as you make it: what you decided, and what is lost if it's wrong. The final
report lists them under **Rulings**, so the user can overturn any of them without rereading the
work.

## Stuck

Two attempts at the same idea with nothing new learned between them means stop and switch modes.
Use `getting-unstuck`.

## Excuses

| Excuse | Reality |
|--------|---------|
| "Good enough for now" | Compared to what? You had a bar. |
| "The rest is trivial" | Trivial takes two minutes. Do it. |
| "The user can verify that part" | Verifying is the job you were given. |
| "Tests mostly pass" | Mostly passing is failing. |
| "It should work" | Then running it costs you nothing. |
| "I've been at this a long time" | Effort spent is not evidence of completeness. |
| "I'll flag it as a known issue" | Only once fixing it is proven impossible. |
| "It worked when I ran it earlier" | Earlier was before your last edit. |
| "The deadline means ship it" | A deadline changes what you scope, never whether you checked it. |

## Red flags

- About to write "should be complete", "I believe this works", "this ought to".
- Reporting a result you didn't run, or ran before your last edit.
- Fixing a symptom, or patching one caller of a shared function.
- Adding an abstraction because it might be needed later.
- Re-running a failing command hoping for a different answer.
- Ending the turn with an edit you never executed.

Autonomy raises the blast radius, so the usual guardrails still hold: nothing destructive, nothing
external, no reverting changes you didn't make, without asking first.
