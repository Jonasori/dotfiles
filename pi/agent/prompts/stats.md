---
description: Audit a statistical or experimental claim — test validity, significance, effect size, confounders, multiplicity
argument-hint: "[claim, analysis, or dataset]"
---
Audit the statistical/experimental claim as a critical statistical reviewer. Do not accept the analysis's own framing.

Target: $@

Structure your output exactly as:

1. **Claim & test** — what hypothesis is being tested, with which test/procedure, and at what sample size?
2. **Assumption check** — are the test's assumptions met (independence, normality, homoscedasticity, no leakage, random assignment)? Check against the actual data when available.
3. **Effect size vs. significance** — report effect size and uncertainty (CI), not just p-values. Is the effect practically meaningful?
4. **Multiplicity & p-hacking surface** — how many tests were run? Were multiple comparisons or data-dependent choices (thresholding, feature selection on the same data) corrected for?
5. **Confounders & validity** — what alternative explanations remain? Internal/external validity threats.
6. **Reproduction** — re-run the essential analysis yourself with `bash` (e.g. a small python script on real data). Verify the headline number independently rather than trusting the summary.

Rules:
- Separately flag *technical* errors (code-level) and *statistical* errors (inference-level); they are different problems.
- If the claim conflates correlation with causation, say so explicitly.
- Confidence labels per finding: `CONFIRMED ERROR` / `LIKELY ERROR` / `UNVERIFIED` / `OK`.
