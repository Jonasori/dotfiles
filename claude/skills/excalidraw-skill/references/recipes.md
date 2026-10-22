# Data-Pipeline Recipes

Composite primitives for dataflow, lineage, and schema diagrams: **tables**,
**operations**, and **edge annotations**.

Excalidraw has no composite types — its renderer knows `rectangle`, `ellipse`,
`diamond`, `arrow`, `line`, `text`, `freedraw`, `frame`, and nothing else. A
"table" is therefore a *macro*: a fixed arrangement of native elements you emit
in one `batch_create_elements` / `add` call, then group. Every recipe below is
copy-paste JSON with the geometry already solved.

> These are a local addition. Re-copying the skill from `~/tools/mcp_excalidraw`
> (or running `install-skill`) overwrites the skill directory — back this file up
> first, or re-apply it afterwards.

---

## The one rule that governs everything here

**Never put `text` on a shape. Always emit a separate `text` element and position
it yourself.**

Setting `text` on a shape creates an Excalidraw *bound label*, which is owned by
the frontend, not by you. Bound labels:

- **ignore the font you asked for** — the browser creates them with Excalidraw's
  own default (Excalifont, the handwritten face), regardless of the `fontFamily`
  you set on the container;
- **never reflow when you resize the shape** — a wrapped label stays wrong;
- **survive their container's deletion**, accumulating as orphans that reappear on
  the next frontend sync;
- **get their width from the shape's inscribed box**, which is half a diamond's
  width and ~70% of an ellipse's.

Free-standing text costs one extra element per label and eliminates all four.
Every template below does it that way.

---

## Palette

Consistent color-by-role is what makes these diagrams scannable. One role, one color.

| Role | Fill | Stroke |
|------|------|--------|
| Table / dataframe | `#ffffff` body, `#a5d8ff` header | `#1971c2` |
| Operation / transform | `#ffd8a8` | `#e8590c` |
| Annotation text | — | `#868e96` |

## Typography

| Where | `fontFamily` | Size |
|-------|--------------|------|
| Table titles | `"helvetica"` | 17 |
| Operation labels | `"helvetica"` | 15 |
| Edge annotations | `"helvetica"` | 14 |
| Column rows (`col : type`) | `"cascadia"` | 15 |

Monospace on the column rows is load-bearing — it column-aligns the `:`
separators. Everything else is standard sans.

### Centering a label by hand

Helvetica averages `0.55 × fontSize` per character:

```
charW = 0.55 * fontSize          # 17 -> 9.35, 15 -> 8.25, 14 -> 7.7
textW = len(label) * charW
x     = shapeX + (shapeW - textW) / 2
y     = shapeY + (shapeH - lineH) / 2        # lineH ≈ 1.25 * fontSize
```

For a multi-line label, emit **one text element per line**, each centered
independently, stacked `1.3 × fontSize` apart. A single text element with `\n`
renders left-aligned and looks wrong inside a centered shape.

---

## 1. Table / Dataframe

### Geometry

```
charW    = 9                                     # cascadia @ fontSize 15
rowChars = max(len("col : type" [+ "  PK"]))
w        = max(200, rowChars * charW + 28)       # 14px padding each side
h        = 40 + len(columns) * 26 + 10           # header + rows + bottom pad

body   rect  (x, y,      w, h)                   # full box — bind arrows to THIS
header rect  (x, y,      w, 40)                  # no text; drawn over body's top band
title  text  centered in the header band, y+10
row  i text  (x+14, y+48 + i*26,  w-28, 20)      # cascadia, fontSize 15
```

Create in that order — creation order is z-order, so the header covers the body's
top band and the texts land on top.

### Template

`users(id uuid PK, email text, signup_at timestamptz)` → longest row is
`signup_at : timestamptz` (23 ch) → `w = max(200, 23*9+28) = 235`, rounded to 240.
`h = 40 + 3*26 + 10 = 128`. Title `users` is 5 ch → `48px` → `x = 80 + (240-48)/2 = 176`.

```json
[
  {"id": "users-body", "type": "rectangle", "x": 80, "y": 80, "width": 240, "height": 128,
   "backgroundColor": "#ffffff", "strokeColor": "#1971c2", "fillStyle": "solid", "strokeWidth": 2},
  {"id": "users-head", "type": "rectangle", "x": 80, "y": 80, "width": 240, "height": 40,
   "backgroundColor": "#a5d8ff", "strokeColor": "#1971c2", "fillStyle": "solid"},
  {"id": "users-title", "type": "text", "x": 176, "y": 90, "width": 48, "height": 21,
   "text": "users", "fontSize": 17, "fontFamily": "helvetica", "strokeColor": "#1971c2"},
  {"id": "users-c0", "type": "text", "x": 94, "y": 128, "width": 212, "height": 20,
   "text": "id : uuid  PK", "fontSize": 15, "fontFamily": "cascadia", "strokeColor": "#1e1e1e"},
  {"id": "users-c1", "type": "text", "x": 94, "y": 154, "width": 212, "height": 20,
   "text": "email : text", "fontSize": 15, "fontFamily": "cascadia", "strokeColor": "#1e1e1e"},
  {"id": "users-c2", "type": "text", "x": 94, "y": 180, "width": 212, "height": 20,
   "text": "signup_at : timestamptz", "fontSize": 15, "fontFamily": "cascadia", "strokeColor": "#1e1e1e"}
]
```

Then group so it moves as one unit:
`group_elements(["users-body","users-head","users-title","users-c0","users-c1","users-c2"])`

### Rules

- **Bind arrows to `<name>-body`** — only the body spans the full table, so arrows
  meet its outer edge. (They will not follow a later move once a browser tab is
  open — see Gotchas.)
- Key markers go inline (`  PK`, `  FK`) with two spaces. Cheaper than a badge
  column and survives any width.
- A dataframe is the same recipe with dtypes: `user_id : int64`, `ts : datetime64`.
- 10+ columns: show the keys and the columns the diagram actually references,
  then a final row `… 14 more`. A full schema dump is a table, not a diagram.

---

## 2. Operation / Transform

**Shape encodes what the operation does to row count.** This is the whole point —
a reader parses the shape before they read the label, so shape must carry meaning.

| Shape | Class | Row cardinality | Operations |
|-------|-------|-----------------|------------|
| `diamond` | **merge** | many inputs → one | join, union, merge, concat, coalesce |
| `ellipse` | **reduce** | N rows → fewer | groupby, aggregate, distinct, window, pivot, rollup |
| `rectangle` | **map** | N rows → N rows | filter*, select, project, derive, cast, rename |

\* filter reduces rows but is row-wise and non-aggregating — it stays a rectangle.
The distinction that matters visually is *"does this collapse the grain?"*, and
filter does not.

All three share the amber palette so operations read as one class against the
blue tables.

### Sizes

A free-standing label is not clipped by the shape, but it still has to *look*
contained — and diamonds and ellipses taper away from their bounding box. Size
off the label:

```
textW = longestLine * 8.25             # helvetica @ fontSize 15
w = (textW + 24) / k                   # k = 0.5 diamond, 0.7 ellipse, 1.0 rectangle
```

| Shape | k | Minimum w × h | Fits a line like |
|-------|---|---------------|------------------|
| diamond | **0.5** | 220 × 110 | `on user_id` (10 ch) |
| ellipse | **0.7** | 200 × 90 | `by user, day` (12 ch) |
| rectangle | 1.0 | 160 × 60 | `status = paid` (13 ch) |

At `150 × 90` a diamond's label visibly overhangs its edges. Undersized diamonds
are the single most common defect in these diagrams.

### Template

Two-line labels, each line its own centered text element, 20px apart:

```json
[
  {"id": "op-join", "type": "diamond", "x": 430, "y": 195, "width": 220, "height": 110,
   "backgroundColor": "#ffd8a8", "strokeColor": "#e8590c", "fillStyle": "solid"},
  {"id": "op-join-l0", "type": "text", "x": 523, "y": 231, "width": 34, "height": 19,
   "text": "join", "fontSize": 15, "fontFamily": "helvetica", "strokeColor": "#e8590c"},
  {"id": "op-join-l1", "type": "text", "x": 499, "y": 251, "width": 82, "height": 19,
   "text": "on user_id", "fontSize": 15, "fontFamily": "helvetica", "strokeColor": "#e8590c"},

  {"id": "op-agg", "type": "ellipse", "x": 760, "y": 205, "width": 200, "height": 90,
   "backgroundColor": "#ffd8a8", "strokeColor": "#e8590c", "fillStyle": "solid"},
  {"id": "op-agg-l0", "type": "text", "x": 819, "y": 230, "width": 82, "height": 19,
   "text": "sum(total)", "fontSize": 15, "fontFamily": "helvetica", "strokeColor": "#e8590c"},
  {"id": "op-agg-l1", "type": "text", "x": 810, "y": 250, "width": 99, "height": 19,
   "text": "by user, day", "fontSize": 15, "fontFamily": "helvetica", "strokeColor": "#e8590c"}
]
```

### Rules

- **Label = operation + its key argument** (`join` / `on user_id`, not `join`). The
  argument is the part a reader can't infer from the diagram.
- Keep each line under ~14 chars at fontSize 15.
- Same operation appearing twice → identical dimensions. Inconsistent sizing reads
  as meaningful difference when there is none.

---

## 3. Edge Annotations

What separates a readable lineage diagram from a box-and-line mess. Two channels,
used together.

### Stroke style = delivery semantics

| Style | Means |
|-------|-------|
| `"strokeStyle": "solid"` | synchronous / streaming / same transaction |
| `"strokeStyle": "dashed"` | batch / scheduled / async |
| `"strokeStyle": "dotted"` | weak or inferred dependency |

### Annotation = cardinality, volume, or grain

Emit a gray text element near the arrow's midpoint, offset ~26px perpendicular to
the run — not a label on the arrow itself (that's a bound label; see the rule at
the top).

```json
[
  {"id": "e-users-join", "type": "arrow", "x": 0, "y": 0,
   "startElementId": "users-body", "endElementId": "op-join", "strokeColor": "#1e1e1e"},
  {"id": "ann-1n", "type": "text", "x": 350, "y": 168, "width": 26, "height": 18,
   "text": "1:N", "fontSize": 14, "fontFamily": "helvetica", "strokeColor": "#868e96"}
]
```

- **≤ 12 characters.** `1:N`, `N:1`, `~2.4M`, `daily`, `12k/s`.
- **Don't annotate every arrow.** Mark what a reader would otherwise get wrong: a
  fan-out, a surprising volume, a grain change. An all-labeled diagram is noise.
- **Grain changes go on the output edge** of the operation that causes them —
  that's where a reader's mental model breaks. `per user/day` earns its space.

---

## Layout

Left-to-right, one column per pipeline stage — sources, transforms, outputs.

- **Column pitch**: table width + 160px. Tables are wide; the default 40–60px
  sibling gap is not enough once edges carry annotations.
- **Row pitch**: 60px between stacked tables in the same column.
- **Align a stage's shapes on x** so the columns read as stages.
- **Fan-in to a join**: place the join's y at the midpoint of its two inputs, so
  both arrows angle symmetrically.

---

## Gotchas — get it right on the first create

You cannot reliably fix one of these diagrams by nudging it afterwards. Compute
the geometry, create once, and if it's wrong, delete and recreate.

### Bound arrows stop following once a browser tab is open

The frontend periodically pushes its whole scene back via `/api/elements/sync`,
replacing agent-created arrows with Excalidraw's native form: `startBinding` /
`endBinding`, and **no `start` / `end` refs**. The server's `rerouteBoundArrows`
(`src/server.ts`) matches on `start` / `end` only, so after that sync a shape can
be moved and its arrows will stay behind — silently, with no error.

1. Place shapes at their final coordinates in the first `batch_create_elements`.
2. If you must move a shape afterwards, **delete and recreate its arrows**.
3. Check with `get <arrow-id>`: `source: frontend_sync` with null `start`/`end`
   means that arrow is no longer reroutable.

### Never delete bound text elements by hand

If a scene has picked up bound labels anyway, do not try to prune them
individually — the frontend owns them, and deleting the copies it is rendering
makes every label on the canvas disappear. Delete the *containers* and rebuild.

### Cleaning up

`query --type text` and look for elements with a `containerId` — those are bound
labels. In a scene built from these recipes there should be **none**. Any that
exist are orphans from a deleted container and will resurface on the next sync;
delete them along with their containers, then recreate.

---

## Verify

Table geometry is computed, so it is the thing most likely to be subtly wrong.
After the first batch, `get_canvas_screenshot` and check specifically:

1. **Every label in the intended font** — a handwritten label means a bound label
   crept in somewhere.
2. **Column text inside the body rect** — if a row overflows the right edge, the
   `rowChars` estimate was low.
3. **Last row above the bottom edge** — if it clips, `h` used the wrong column count.
4. **Titles centered** in their header bands, and operation labels centered in
   their shapes without overhanging the taper.
5. **Arrows meeting each table's outer edge**, not its center.
