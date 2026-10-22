# pi-specific instructions

Global rules live in `~/.pi/agent/AGENTS.md` (symlinked to `dotfiles/AGENTS.md`); pi loads them into
every session as `<project_context>`. Do not copy them here. This file is only for behavior specific
to pi, or for rules that need to sit earlier in the system prompt than project context does. Where
this file and the AGENTS.md block disagree, this file wins.

- Name the repository and the paths you worked in before you conclude, and confirm they are the ones
  the task meant. Answering the wrong repo with full confidence is a failure this setup has actually
  produced.
