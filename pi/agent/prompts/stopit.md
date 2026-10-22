---
description: Make a behavioral correction permanent — "never do that again" becomes a sticky learned rule
argument-hint: "<what you want different>"
---
The user invoked /stopit to make a correction permanent. Their words: "$@"

If their words are empty or missing (plain "/stopit" with nothing after it), do NOT call any tool. Reply that /stopit always requires a description of what should be different — an empty claim pins nothing.

Otherwise:

1. Distill what they said into ONE line: "Never X. Instead: Y." — the behavior to stop, then what replaces it. General enough to apply beyond this task, specific enough to recognize when it recurs.
2. Call sticky_rule with action=add and rule=<that one line>.
3. If the tool reports the rule is already covered, quote the existing line and say it is already sticky.
4. Reply with one line confirming what is now pinned (and the running total if the tool reported one). Do not editorialize.
