---
description: Review or design a data/ML pipeline or architecture for correctness, idempotency, failure modes, and testability
argument-hint: "[pipeline description or code]"
---
Review/design this data/ML pipeline as a skeptical infrastructure reviewer. The goal is a pipeline that fails loudly and recovers cleanly.

Target: $@

Structure your output exactly as:

1. **Data flow map** — inputs → transforms → outputs; where data enters, mutates, and leaves. Note every schema boundary.
2. **Correctness** — are transforms deterministic where they must be? Any silent data loss (dropped rows, NaNs, timezone/dtype coercion, dedup policy)? Is train/eval/test separation leak-proof (no scaling/feature-fit on full data)?
3. **Idempotency & retries** — can every stage be re-run safely after partial failure? What happens on retry: duplicates, double-apply, state drift?
4. **Failure modes** — for each stage: what breaks (empty input, upstream schema change, oom, timeout, downstream outage) and does the pipeline detect it or silently produce bad output? Is there validation on outputs (row counts, ranges, invariants)?
5. **Incremental & backfill** — can the pipeline process only new data? Can it backfill historically without recomputing everything?
6. **Testability & observability** — what tests validate this? Metrics/logs per stage; alerting thresholds; lineage.
7. **Concrete recommendations** — prioritized (blocking vs. nice-to-have), each tied to a specific line/stage.

Rules:
- Ground every claim in the actual code/schema where present — read the files, don't infer from names.
- If something cannot fail (or is asserted to never fail), test that assumption — that is usually where the bug lives.
- Prefer the simplest robust design; flag over-engineering as a maintainability cost.
