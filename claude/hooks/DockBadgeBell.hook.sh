#!/bin/sh
# Ring the terminal bell in the Ghostty tab this session lives in.
#
# Ghostty >=1.3 sets its dock badge to the number of TABS with an active bell
# (AppDelegate.swift setDockBadge), and clears a tab's bell when that surface
# gains focus or receives a keypress (SurfaceView_AppKit.swift). So one BEL per
# finished turn == "tabs that completed work since I last looked at them".
#
# Hooks are spawned without a controlling terminal (/dev/tty fails), so walk up
# the process tree to find the pty that `claude` is attached to.
#
# Always exits 0 — this must never block Claude Code.

pid=$PPID
i=0
while [ "$pid" -gt 1 ] && [ "$i" -lt 6 ]; do
	set -- $(ps -o ppid=,tty= -p "$pid" 2>/dev/null)
	[ -z "$1" ] && break
	if [ -n "$2" ] && [ "$2" != "??" ]; then
		printf '\a' >"/dev/$2" 2>/dev/null
		exit 0
	fi
	pid=$1
	i=$((i + 1))
done

exit 0
