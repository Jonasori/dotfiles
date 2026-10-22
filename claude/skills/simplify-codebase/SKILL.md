---
name: simplify-codebase
description: 'Use when a codebase has accumulated temporary agent artifacts, dead code, backwards-compatibility shims, silent data truncations, or over-abstraction and needs to be burned down to only the load-bearing parts, then made faster without growing.'
triggers:
  - user
---

# Simplify Codebase

A clean codebase is one where every file and function is load-bearing. This is a deep, codebase-wide
pass: remove scaffolding and temporary junk, simplify over-abstraction, make the layout obvious, and
strip every cap that quietly computes on part of the data. Then a performance pass makes it faster
without making it bigger.

For cleaning up after a single task, use `until-done` instead. Under `until-done`, this skill sets
the scope: the whole repo counts as code you touch.

## What we are hunting

### Silent data truncation

Not a simplification — a correctness hunt, and the highest-consequence one in this skill. A cap that
drops rows before a computation makes every number downstream wrong in a way nothing later can see:
the run succeeds, the output is plausible, and the real denominator is gone. Agents add these
constantly, to make a slow thing fast or a large thing printable, then reason over the result as if
it were whole. Find every one and make it justify itself.

Tells:

- pandas/numpy: `.head(`, `.tail(`, `.sample(`, `.nlargest(`/`.nsmallest(`, `.iloc[:n]`, `df[:n]`, `nrows=` on a reader.
- Spark: `.limit(`, `.take(`, `.first(`, `.sample(`, `TABLESAMPLE`.
- SQL: `LIMIT`, `TOP n`, `FETCH FIRST`, `SAMPLE`, and date or partition predicates that are there to keep the query cheap rather than because the question is about that window.
- Plain Python: `[:n]` on a list or iterator, `islice`, `break` on a counter, `range(n)` bounding a loop over something longer, `glob(...)[:n]`, `sorted(...)[:n]`.
- Text: `text[:n]`, `max_chars`, `max_tokens`, a `…` ellipsis on content that is then read, classified, or summarized. A prefix of a document is not the document.
- Signatures: a `limit`, `max_rows`, `max_files`, `n_samples`, `top_k`, or `max_results` parameter with a numeric default. The default is where truncation hides, because no call site shows it.

**Justified or convenient?** A cap is legitimate in four cases only:

- The cap is the deliverable. "Top 10 by revenue" is an answer, not a subset.
- Pagination that loops to exhaustion. The limit is a page size, not a ceiling.
- A resource guard that raises when the data exceeds it. That is a failure, not a quiet trim.
- A sample drawn on purpose: seeded, sized for the estimate it feeds, and reported with its denominator and the population it was drawn from.

Everything else goes. "The full run is slow" is a performance problem — push the filter down,
vectorize, chunk, or run it anyway; it is never a reason to shrink the input. "Just to check it
works" is a scratch run that was committed. Printing `df.head()` to look at data is fine; the line
is whether the truncated value flows into a result.

Two more checks on the ones that survive. Determinism: `.head()` on an unsorted frame, `LIMIT`
without `ORDER BY`, or `.sample()` without a seed returns an arbitrary subset that changes between
runs. Honesty: a partial result reported without its real n is the same failure as the truncation
itself.

**How:** grep for `head(|tail(|sample(|limit(|nlargest|nsmallest|iloc\[|islice|nrows=|top_k|max_rows|max_results|LIMIT |TOP |TABLESAMPLE` and for `[:` followed by a digit, then read every hit — this is the one category where a hit count is not the output. Grep is the start, not the sweep: a counter-and-`break`, a `range(n)` over a longer sequence, and a truncating default buried in a signature all pass it, so read the data path of anything that loads a table or a directory. For each, trace the value forward and say whether it reaches something reported. List every hit in the task list with a verdict against the four cases above; removing a cap changes what the code computes, so get the full-data result before and after where you can.

### A fact stated in more than one place

A condition, key expression, hash, threshold or query fragment written out twice drifts: one
copy gets fixed and the other doesn't.

Tells:

- The same SQL predicate or join key in two queries, or one query derived from another by string surgery (`.replace(...)`, searching SQL text for a parameter name).
- Two functions computing the same value under different names.
- A constant restated as a literal somewhere else.
- A rule stated in code and again in a prompt or fixture that won't follow it when it changes. A doc or prompt that can't import the source points to it rather than restating it.

**How:** when you read a definition, grep for its distinctive part (a column name, a literal, a
pattern) and read every hit. If the copies agree, make one the source, have the rest use it, and
show the generated SQL or output is identical before and after. If they differ, the difference is
a bug: decide which is right, fix it as a bug (Phase 2), then merge.

### Agent and exploration artifacts

- Markdown outside a clear docs tree. Standard root files (`README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `LICENSE.md`, `SECURITY.md`, `AGENTS.md`, `CLAUDE.md`) and package `README.md` files are expected; almost everything else is suspect.
- Temporary note names: `NOTES.md`, `SUMMARY.md`, `PLAN.md`, `scratchpad.md`, `analysis.md`, `research.md`, `prompt.md`, `draft.md`, `*_COMPLETE.md`, `CHANGES.md`.
- Scratch and demo scripts: `scratch.*`, `try_*.py`, `experiment.*`, `demo.*`, `prototype.*`, `*.tmp`, `*.bak`, `*.log`.
- Temporary directories that are not the product's own: `tmp/`, `scratch/`, `drafts/`, `experiments/`, `old/`, `bak/`, `backup/`, `output/`, `results/`, `outputs/`.
- Tracked generated or cache files: `__pycache__/`, `.pytest_cache/`, `.mypy_cache/`, `.ruff_cache/`, `node_modules/`, `dist/`, `build/`, `.next/`, `coverage/`, `htmlcov/`.
- Editor and OS droppings: `.DS_Store`, `Thumbs.db`, `*.swp`, `*.swo`, `*~`.

**How:** map the tree to depth 2 or 3 (`tree -L 2 -I '.git|node_modules|__pycache__'`), then match
against the names above. Preserve standard files and any project config in active use.

### Dead code and backwards compatibility

- Unused functions, classes, methods, variables, and constants.
- Unused imports, including star re-exports.
- Commented-out code, and stale `TODO`/`FIXME` comments that no longer describe real work.
- Backwards-compatibility shims: `try/except ImportError` fallbacks, `deprecated_*` aliases, `__getattr__` re-exports, forwarding wrappers.
- Old config kept after a migration: `setup.py`/`setup.cfg` when `pyproject.toml` is the source, `requirements.txt` if `uv.lock` is the lockfile, `mypy.ini`/`pytest.ini`/`tox.ini` after the config moved into `pyproject.toml`.
- Empty modules, unnecessary empty `__init__.py`, broken symlinks, tests for removed features.

**How:** run the project's own tools first — `uv run ruff check`, `uv run mypy .`, `npm run lint`,
`cargo clippy`, `go vet`. Grep for callers of each candidate. Public exports and documented API are
load-bearing unless the user says otherwise.

### Historical commentary

Comments describing the edit instead of the code — what it used to be, what changed, why it was
fixed. Agents produce these constantly. The reader has no access to the previous version and does
not need it; that is what git is for.

**The test:** would this make sense to someone who has never seen another version of this file? If a
sentence only parses because you know what the code used to say, it is historical.

Triggers: `was`, `were`, `used to`, `previously`, `formerly`, `originally`, `no longer`, `replaced`,
`migrated`, `switched`, `renamed`, `changed from`, `this fixes`, `now correctly`, `note: we`,
`per review`, `as discussed`, `as requested`; bare dates or ticket ids carrying nothing else.

Two filters, because most hits are false positives:

- **Code or data?** `was`/`were` are the noisiest triggers. "whether one generation was slow" is past tense about runtime, not about a previous version of the program.
- **Whose history?** Our own prior state → rewrite. An external system's prior behavior → keep it; `# Pre-3.13 returned None instead of an empty list` is why a shim exists, and cutting it breaks the code's explanation of itself.

**Rewrite forward, don't delete.** Most of these have a real rationale buried inside. Keep the
durable fact, put it in present tense, drop the transition:

```python
# before
# Queue, results and index in one Delta table. This replaced a UC Volume of
# .md files: the Volume needed the index kept in sync with the files by
# hand, and readers needed their own UC grant on it.

# after
# One Delta table keeps queue, results and index consistent without a
# hand-maintained index or a separate UC grant.
```

Delete outright only when nothing survives the rewrite: changelog entries, narration of a bug that
no longer exists, review-response notes, comments whose only content is that a fix happened.

**How:** grep the triggers across comments and docstrings, tests included, then apply both filters.
Record each replacement line in the task list as you go, with its before and after text.
Leave markdown docs alone; changelogs and migration notes belong there.

### Hacks and patch layers

Low-entropy code states each fact once, in one place. A hack is a correction applied downstream of
whatever produced the wrong value, and corrections stack: each one becomes load-bearing for the next,
until none of them can be removed alone and nobody can say what the code is supposed to do.

Tells:

- A value computed and then immediately adjusted — `x = compute()` followed by `if edge_case: x -= 1`.
- A special-case branch that exists for exactly one caller or one input.
- The same fact enforced at two depths: normalized at the boundary, then normalized again in the consumer.
- Round-tripping — serialize then re-parse, format then re-extract, string surgery on structured data.
- `try/except` standing in for a condition you could have tested.
- Sentinel returns and magic values that let a caller skip a case.
- A flag threaded through a signature to switch off a behavior for one call site.
- Retries or sleeps wrapped around something that fails deterministically.
- Functions named `fix_*`, `patch_*`, `ensure_*`, `force_*`, `sanitize_*`, `*_workaround`, running after the step that should have been correct.
- Comment vocabulary: `hack`, `workaround`, `for now`, `temporary`, `quick fix`, `shouldn't happen`, `just in case`, `safety net`.

**Designed or accreted?** A scheduled reconciliation job, or an idempotent `CREATE TABLE IF NOT
EXISTS` behind an `ensure_*` name, is one deliberate mechanism — it trips the vocabulary without
being a patch. A patch layer is accreted: added after the fact to correct one observed failure.
Ask whether the redundancy was chosen or accumulated.

**The question for each one:** what produced the value that needs correcting? The fix belongs there,
not here. If the answer is an external system you do not control, the guard is legitimate — put it
at the boundary, once, and let everything inside trust the shape.

**How:** grep the comment vocabulary and the function-name prefixes above, then trace one suspect
value from where it enters to where it is used and count how many places touch it. More than one
correction on a single path is the signal. Removing a patch layer changes behavior at the edges, so
get a test covering the case first, then remove — this is the riskiest category in this skill.

### Unnecessary complexity

- One-line functions with a single call site.
- Interfaces or abstract base classes with one implementation.
- Classes used only as namespaces.
- Constants or config values used in exactly one place and not exposed as configuration.
- Duplicate helpers that should be one function.
- Premature generic wrappers, feature toggles, or layers added for later use.

**How:** grep each helper, interface or constant by name. One call site and a body you can read
at a glance means inline it; one implementation means the interface goes too. Inlining is meant to
preserve behavior, so let the existing tests say whether it did.

### Loops that should be vectorized

- `.iterrows()`, `.itertuples()`, `.apply(axis=1)`, `for i in range(len(df))`.
- Appending to a list in a loop and building the array or DataFrame at the end.
- Manual accumulation that is a `groupby`/`agg`, or nested loops that are a join.
- Python loops doing elementwise work over numpy arrays.
- Spark: `.collect()` or `.toPandas()` followed by a loop, or a Python UDF where a native column expression exists.

Not this: loops over files, network calls, or anything with side effects; loops where n is small and
fixed and the loop reads better; and — the common false positive — `range(len(...))` over a plain
Python list, or any loop whose body is control flow such as a search or an early return rather than
elementwise arithmetic. Vectorizing applies to frames and arrays, not to every index.

**How:** grep for `iterrows|itertuples|apply(|range(len(|collect()|toPandas()`. Vectorizing changes
behavior at the numeric edges — NaN handling, dtypes, empty frames — so compare against the old
output on real data before replacing.

### Layout clutter

- Files in the repo root that belong in `src/`, `tests/`, `scripts/`, `docs/`, or `examples/`.
- Near-empty modules that no longer justify a file.
- Inconsistent naming within a group of related files.
- Multiple config files for the same tool.
- Public files in private directories, or private files at the top level.

**How:** check whether `.vscode/` and `.idea/` are committed, but do not assume they are junk.

## How to run it

This usually runs while the user is away, so work without check-ins: everything goes on one
branch, in commits small enough to revert one at a time, and the user's review is the merge. Ask
only before what reverting the branch would not undo: any write outside the repo (a table, a
database, Slack, a ticket, an MR), deleting data, changing a public interface or a schema another
repo reads, pushing, or deploying. Leave those out of the branch, list them for the user, and carry
on. Profiling and output captures run read-only or against a scratch target.

This skill is the structural task AGENTS.md's Structure and cleanup hands over, and its gates apply
to each commit with two differences: where no test covers the code, an identical-output comparison
stands in for tests, and a commit may delete the tests of code it deletes. It also fixes the bugs
the sweep finds, which AGENTS.md would only report.

### Phase 1: Investigate

1. **Set up.** Other sessions may be working in this repo, so create a worktree on a new branch from `HEAD` and work there; leave other sessions' files, branches and worktrees alone. Note what `git status --short` and `git worktree list` show in the main checkout: it belongs to someone else unless the user says otherwise.
2. **Baseline.** Run the project's lint, typecheck, and test commands from `AGENTS.md`, `CLAUDE.md`, or the readme. If something fails, record exactly what and carry on; the bar becomes no new failures, and the report leads with the baseline.
3. **Work each category above**, using its **How** line, read-only. Write each finding into the task list with its path, why it goes, and the action (delete / inline / merge / move / rewrite / fix).

### Phase 2: Clean

1. **Structural first.** One commit per batch (a category, or one area of the code), each behavior-preserving. Run the relevant lint, typecheck, or tests after each batch; do not stack unverified edits. Where no test covers the code, show the output is unchanged (identical SQL, rows, or rendered page) and say how you checked. Vectorizing belongs here: compare outputs on real data, including NaN, dtype and empty-frame cases. Untracked files aren't on the branch; list them in the report rather than deleting them.
2. **Then everything that changes behavior:** every bug the sweep found (a cap that changes a result, a non-deterministic tie, rounding that hides a value, an error path that swallows a failure), and removing a cap, a patch layer or a fallback, or merging copies that disagree. Each goes in its own commit after the structural ones, with a test that fails before it; in a repo with no test runner, a script or query run before and after, quoted in the commit message. A bug whose right answer is a product choice, not clear from the code and data, goes under what needs the user.

### Phase 3: Performance

Faster, with the same outputs.

1. **Profile first,** on real data and the real runtime: timers around stages, the warehouse's query history, a profiler, request timings. Rank by what a user or a job waits on. Don't optimize from reading alone.
2. **Capture outputs before each change** on real data, and compare after it. The aim is identical results; any difference is a bug until explained. Say what you compared and how many rows.
3. **Common wins:** a join that runs as a cartesian product, reading rows or columns that are never used, independent I/O run one after another, a polling interval far longer than the work, responses sent without compression or cache headers.
4. **Measure before and after** on the same data, and report both.

**The limit.** A speedup adds no state the code keeps (a cache, a stored copy, a new column), no
second code path, and no change to a table or interface another component reads, and it leaves
the code about the same size or smaller and no harder for a person to follow. Anything else is a
proposal: describe it in the report with its gain, and don't build it. Stop when the top item in
the profile can only be sped up by a proposal.

### Phase 4: Review and report

1. **Fresh review.** Give a fresh subagent this file's path, the branch and its base commit, and have it review the diff for structural commits that change behavior, behavior changes without a failing check, performance changes without an equivalence check, and anything missed. Fix what holds up; if that changed anything, have one more fresh review of the new commits.
2. **Report:** the baseline if it failed; the commits by phase; each performance change with its before and after numbers and how equivalence was checked; every truncation found, with its verdict; the **Rulings**, recorded as you went (each cap judged justified, each export judged public or dead, each bug where you chose the right answer), each with what is lost if it's wrong; the proposals; and what needs the user. Nothing is pushed or deployed unless the user asked.

## Done when

- Lint, typecheck, tests, and build pass, or fail no more than at the baseline.
- A second dead-code pass finds nothing.
- Every remaining truncation is one of the four justified cases, and says so at its call site or in the value it reports. No cap survives because the full run was slow.
- Each fact is stated in one place; no value is computed and then corrected downstream.
- No row-wise loop remains where a vectorized operation does the same work.
- Each behavior change is its own commit, with a check that failed before it.
- Each performance change has before and after numbers on the same data and an equivalence check; what's left is listed as proposals.
- The branch holds only the intended commits, and the main checkout and other sessions' work are untouched.
- The tree at depth 2 reads without explanation.
- Every remaining file and function has a current purpose. Nothing is kept for later.
