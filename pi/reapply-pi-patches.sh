#!/bin/bash
# reapply-pi-patches.sh
#
# Re-applies the local patches that an install step wipes. Both targets are
# restored at every session start:
#
#   1. the pi bundle chunk that renders assistant messages. `pi update
#      --self/--all` npm-installs the package over itself in place, silently
#      wiping hand-edited files.
#   2. Manifests in the pi npm store. Any `pi install`, `pi remove`, or
#      `pi update --extensions` reinstalls node_modules from the registry,
#      restoring the upstream manifests.
#
# Idempotent and safe to run anywhere (shell hook after `pi update`, extension
# at session start, or manually): it reverts and reapplies rather than looking
# for a marker, patches by exact anchor, and if an anchor is missing or
# ambiguous (upstream restructured the file), it refuses to touch the file so a
# new release is never corrupted.
#
# Exit codes:
#   0  nothing to do (already applied, or pi not found)
#   2  patched now
#   3  target exists but upstream shape changed; needs human attention
#
# Env:
#   PI_PATCH_TARGET=<file>   patch that file instead of pi's dist, and skip the
#                            npm store entirely (for testing the engine)
#   PI_NPM_MODULES=<dir>     npm store to patch (default ~/.pi/agent/npm/node_modules)
set -uo pipefail

status=0
# 3 means a human is needed and 2 means it worked, so keep the worse of the two.
note() { [ "$1" -gt "$status" ] && status="$1"; return 0; }

if [ -n "${PI_PATCH_TARGET:-}" ]; then
	TARGET="$PI_PATCH_TARGET"
else
	PI_BIN="$(command -v pi 2>/dev/null || true)"
	if [ -z "$PI_BIN" ]; then
		echo "pi not found on PATH; nothing to patch" >&2
		exit 0
	fi
	PI_CLI="$(readlink -f "$PI_BIN")"
	# The entry point sits at dist/bundle/cli.js, so walk up to the package root
	# instead of counting directories.
	PI_PKG="$(dirname "$PI_CLI")"
	while [ ! -f "$PI_PKG/package.json" ] && [ "$PI_PKG" != "/" ]; do
		PI_PKG="$(dirname "$PI_PKG")"
	done
	# cli.js pulls its code from a minified chunk under dist/bundle/chunks/, so
	# that chunk is the file that has to change. The unminified dist/ tree is
	# the library build and is not on that path. The chunk name is a build hash,
	# so find it by content.
	CHUNKS="$PI_PKG/dist/bundle/chunks"
	TARGET="$(grep -l 'AssistantMessageComponent=class' "$CHUNKS"/*.js 2>/dev/null | head -2)"
	if [ "$(printf '%s\n' "$TARGET" | grep -c .)" != 1 ]; then
		echo "expected one bundle chunk defining AssistantMessageComponent under $CHUNKS; found: ${TARGET:-none}" >&2
		note 3
		TARGET=""
	fi
fi

if [ -n "$TARGET" ]; then
python3 - "$TARGET" <<'PYEOF'
import sys

target = sys.argv[1]

# ── Local patch: indent thinking blocks ───────────────────────────────────────
# Thinking blocks render at outputPad + THINKING_EXTRA_INDENT so they read as
# distinct from assistant output. Tune the default below, or set
# PI_THINKING_INDENT before pi starts.
#
# The guard reverts first and compares the result against what the patch
# produces now, rather than looking for a marker. Editing a value below
# therefore re-applies it; a marker would match the old application and report
# "already applied" while the old value stayed on disk.

INDENT = '(()=>{const n=Number.parseInt(process.env.PI_THINKING_INDENT??"4",10);return Number.isFinite(n)&&n>=0?n:4})()'

# The declaration carries the indent default, so take it back out by its
# boundaries rather than its text: matching the text would miss once the default
# has been edited. The span runs from just after `var` to the comma before the
# next declarator, which leaves the original keyword in place.
DECL_ANCHOR = 'var OSC133_ZONE_START="\\x1B]133;A\\x07",'
DECL_START = "THINKING_EXTRA_INDENT="
DECL_END = ",OSC133_ZONE_START="
DECL_PATCHED = "var " + DECL_START + INDENT + DECL_END + '"\\x1B]133;A\\x07",'

CALLS = [
    (
        'new Text(theme.italic(theme.fg("thinkingText",this.hiddenThinkingLabel)),this.outputPad,0)',
        'new Text(theme.italic(theme.fg("thinkingText",this.hiddenThinkingLabel)),this.outputPad+THINKING_EXTRA_INDENT,0)',
    ),
    (
        'new Markdown(thinkingBlocks.join(`\n\n`),this.outputPad,0,this.markdownTheme,{',
        'new Markdown(thinkingBlocks.join(`\n\n`),this.outputPad+THINKING_EXTRA_INDENT,0,this.markdownTheme,{',
    ),
]


def revert(src):
    """Undo the patch, giving the file back as it looked before it was applied."""
    # The declaration carries the indent default, so take it back out by its
    # boundaries. Matching its text would miss once the default has been edited
    # and raise a false alarm about upstream instead of re-applying.
    start = src.find(DECL_START)
    if start != -1:
        end = src.find(DECL_END, start)
        if end == -1:
            return None
        src = src[:start] + src[end + 1:]
    for old, new in CALLS:
        src = src.replace(new, old)
    return src


try:
    with open(target, "r", encoding="utf-8") as f:
        src = f.read()
except FileNotFoundError:
    print(f"target not found: {target} (pi layout changed?)", file=sys.stderr)
    sys.exit(3)

pristine = revert(src)
if pristine is None:
    print(f"SKIP: {target} has a truncated declaration; inspect it by hand", file=sys.stderr)
    sys.exit(3)

# Every anchor must exist exactly once in the unpatched file, or we refuse to
# touch it. This is also what shows the revert got back to upstream: had it not,
# the anchors would not line up.
missing = []
if pristine.count(DECL_ANCHOR) != 1:
    missing.append("OSC133 declaration")
for old, _new in CALLS:
    if pristine.count(old) != 1:
        missing.append(repr(old[:48]))

if missing:
    print(
        f"SKIP: {target} no longer matches this patch; anchor(s) missing: {', '.join(missing)}",
        file=sys.stderr,
    )
    sys.exit(3)

out = pristine.replace(DECL_ANCHOR, DECL_PATCHED, 1)
for old, new in CALLS:
    out = out.replace(old, new, 1)

if out == src:
    print("already applied; nothing to do")
    sys.exit(0)

with open(target, "w", encoding="utf-8") as f:
    f.write(out)
print(f"patched {target}")
sys.exit(2)
PYEOF
	note $?
fi

# ── Patch 2: host-provided packages declared as real dependencies ───────────
# pi loads extensions through a jiti alias map that points `typebox` and the
# @earendil-works/* packages at its own copies, so a package declaring one of
# them in `dependencies` only gets a second copy installed that the alias then
# shadows — a duplicate runtime module, plus one startup warning per extension.
# Move each such declaration to peerDependencies, the form pi's docs prescribe,
# and drop the copy the move orphans. The name list mirrors pi's own
# HOST_PROVIDED_EXTENSION_PACKAGES (dist/core/resource-loader.js); if upstream
# adds a name, the warning it raises is the signal to add it here too.

NPM_MODULES="${PI_NPM_MODULES:-$HOME/.pi/agent/npm/node_modules}"
HOST_PROVIDED='["@earendil-works/pi-agent-core","@earendil-works/pi-ai","@earendil-works/pi-coding-agent","@earendil-works/pi-tui","@mariozechner/pi-agent-core","@mariozechner/pi-ai","@mariozechner/pi-coding-agent","@mariozechner/pi-tui","@sinclair/typebox","typebox"]'

# Only ever rewrite a real npm store, never an arbitrary directory.
case "$NPM_MODULES" in
*/node_modules) ;;
*)
	echo "PI_NPM_MODULES does not end in /node_modules; refusing to touch it" >&2
	note 3
	NPM_MODULES=""
	;;
esac

# PI_PATCH_TARGET means the engine is under test; leave the live store alone.
[ -n "${PI_PATCH_TARGET:-}" ] && NPM_MODULES=""

if [ -n "$NPM_MODULES" ] && [ -d "$NPM_MODULES" ]; then
	fixed=0
	for manifest in "$NPM_MODULES"/*/package.json "$NPM_MODULES"/@*/*/package.json; do
		[ -f "$manifest" ] || continue
		jq -e --argjson h "$HOST_PROVIDED" \
			'[.dependencies // {} | keys[] | select(. as $k | $h | index($k))] | length > 0' \
			"$manifest" >/dev/null 2>&1 || continue

		if jq --argjson h "$HOST_PROVIDED" '
			reduce ($h[]) as $n (.;
				if (.dependencies // {}) | has($n)
				then .peerDependencies = ((.peerDependencies // {}) + {($n): "*"})
				   | .dependencies |= del(.[$n])
				else . end)
		' "$manifest" > "$manifest.tmp" 2>/dev/null; then
			mv "$manifest.tmp" "$manifest"
			echo "moved host-provided packages to peerDependencies: $(jq -r .name "$manifest")"
			fixed=$((fixed + 1))
		else
			rm -f "$manifest.tmp"
			echo "SKIP: could not rewrite $manifest" >&2
			note 3
		fi
	done

	# A copy is safe to delete only once no manifest still declares it.
	declared_by_any() {
		local n="$1" m
		for m in "$NPM_MODULES"/*/package.json "$NPM_MODULES"/@*/*/package.json; do
			[ -f "$m" ] || continue
			jq -e --arg n "$n" '(.dependencies // {}) | has($n)' "$m" >/dev/null 2>&1 && return 0
		done
		return 1
	}

	for name in $(printf '%s' "$HOST_PROVIDED" | jq -r '.[]'); do
		[ -d "$NPM_MODULES/$name" ] || continue
		declared_by_any "$name" && continue
		rm -rf "$NPM_MODULES/$name"
		echo "removed orphaned copy of $name"
		fixed=$((fixed + 1))
	done

	[ "$fixed" -gt 0 ] && note 2
fi

exit "$status"
