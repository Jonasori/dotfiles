---
name: getting-unstuck
description: Use when the same fix has failed twice, the same error keeps returning, each fix breaks something else, the solution is turning hacky or sprawling, a bug cannot be reproduced, or you are out of ideas and about to guess again. Also use when the user says "you're going in circles", "step back", or "think about this differently".
---

# Getting Unstuck

Being stuck is almost never a hard problem. It is a wrong assumption or a wrong framing, and
thrashing — trying variations of one idea — is the tell that you're treating it as the other kind.

## First: stop editing

No more changes until you can state the problem in one sentence. Every edit made while confused
adds a variable to a system you already don't understand. If you can't state it in one sentence,
that *is* the diagnosis — you don't have a problem, you have a feeling.

If you've been flailing, your own confused edits are now part of the failure. Save the diff, revert
**your own** edits back to the last good state, start clean.

## Then, in this order

### 1. Zoom out

Re-read the original request verbatim. What am I actually trying to achieve, one level above this?
Does this sub-problem need to exist at all, or is it an artifact of an earlier decision I could
revisit? If I deleted this piece, what would break?

Tension is signal. If the solution feels hacky or keeps growing special cases, the framing is wrong,
not the code. This goes first not because it's likeliest, but because a wrong framing makes the
other three moves worthless — perfectly debugging a problem that shouldn't exist is the most
expensive way to be wrong.

### 2. First principles

Write two lists: what you have **evidence** for — a command you ran, output you read — and what
you're **assuming**. Confidence is not evidence; if you didn't verify it, it goes in the second list.
Then test the cheapest load-bearing assumption. Most stuckness dies here.

The usual culprits, roughly in order:

- The code you're reading is not the code that's running.
- The input is not the shape you think it is.
- The config you edited is not the config being loaded.
- The failure is not where the error message points.
- The function is called from somewhere you haven't looked.
- The thing you "fixed" earlier never took effect.

### 3. Brainstorm wide

Five approaches minimum, fast, no judging while generating. Force in the four you won't reach for
on your own: delete the requirement; do it the dumb way; use what already exists (stdlib, an
installed dep, code already in this repo); invert it. Then take the smallest one that could work.

### 4. Deep dive

Last, because it's the most expensive and it *feels* like real work while you learn things that
don't matter. Read the actual source, not the docs and not your memory of them. Build a minimal
reproduction — strip until the bug vanishes or becomes undeniable. Instrument the boundaries: log
types and shapes, not just values. Bisect: history, input, or pipeline.

## Shortcuts

If the symptom is obvious, start there instead: same error survived two different fixes → 2, your
premise is false. Each fix breaks something else, or it's turning hacky → 1, reframe. Can't
reproduce it → 4, instrument. One idea and it failed → 3.

## Terminate

One pass down the list. If you're back at the top having learned nothing new, stop — a second pass
is just thrashing at a higher altitude. Write it up: what you tried, what you learned, the two best
remaining options, which you'd pick.

## Red flags

- Trying a variation of something that already failed.
- "Let me just try one more thing", for the third time.
- Adding a layer or a flag to route around the problem instead of understanding it.
- Blaming the library, the data or the environment without evidence.
- Rewriting working code because you can't find the bug in it.
- Reaching for the deep dive first because it feels productive.
