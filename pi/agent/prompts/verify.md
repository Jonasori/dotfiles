---
description: Rigorously verify a model result, claim, or finding — cross-check against actual data/files, force empirical checks, surface uncertainty
argument-hint: "[claim or find a claim to verify]"
---
Verify the following rigorously. Adopt the stance of a skeptical senior colleague, not a cheerleader.

Target: $@

Structure your output exactly as:

1. **Restated claim** — one sentence, precise enough that it could be falsified.
2. **Independent cross-check** — run it, don't eyeball it. Use `bash`/`read`/`ctx` to re-derive or re-compute against the actual data or code. If the claim came from a model output, reproduce the computation yourself from first principles or with a clean script.
3. **Assumptions & failure modes** — what had to be true for the claim to hold; where it breaks (units, scale, distributions, leakage, data errors).
4. **Confidence per claim** — `HIGH` (empirically reproduced), `MEDIUM` (internally consistent, unverified), `LOW` (plausible but unsupported), `UNSUPPORTED` (no evidence found / contradictory).
5. **Anything unsupported or likely hallucinated** — call it out plainly; do not soften findings.

Rules:
- Every empirical assertion must be backed by an actual command you ran and its output. Never fabricate results.
- If you cannot verify, say exactly what data/access/code would be needed, rather than guessing.
- Distinguish "claim contradicts data" from "claim is unverifiable with current access" — they are different findings.
- If the claim involves statistics, apply the statistical audit template's lens (significance, effect size, multiplicity).
