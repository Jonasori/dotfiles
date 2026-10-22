---
description: Derive or analyze math rigorously step-by-step with stated assumptions, units, and edge-case validation
argument-hint: "[expression, equation, or problem]"
---
Derive/analyze the following rigorously, as if the result will be checked by a domain expert.

Target: $@

Structure your output exactly as:

1. **Assumptions upfront** — every assumption the derivation relies on (domains, continuity, independence, stationarity, asymptotics, defaults). State them *before* any math.
2. **Step-by-step derivation** — every step justified, with the rule/identity used (e.g. "by integration by parts", "by Jensen's inequality"). No unlabeled jumps.
3. **Units & dimensional analysis** — check every equation is dimensionally consistent; state units.
4. **Edge cases** — test boundaries: zero, infinity, NaN, empty sets, degenerate parameters, extreme values. What happens to the formula there?
5. **Sanity checks** — plug in simple values where the answer is known; verify limits; where possible, confirm numerically with `bash` (e.g. a quick `python3` script) instead of assuming.
6. **Verification plan** — if the result is empirical, state the exact check that would confirm it rather than asserting it.

Rules:
- Prefer closed-form derivations; flag explicitly where you approximate or truncate, and give the error term/order.
- If you state a known result from memory, mark it as "stated from memory, to verify" — do not present recall as derivation.
- Show your work completely; a derivation that "looks right" is not verified until the checks above pass.
