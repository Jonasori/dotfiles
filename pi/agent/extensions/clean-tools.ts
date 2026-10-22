/**
 * Clean Tools — compact rendering for all built-in tools.
 *
 * Replaces verbose tool output boxes with clean one-line summaries.
 * Press Ctrl+O to expand any result and see full output inline.
 *
 * Read:  📄 path.ts  42 lines (157 truncated)
 * Bash:  $ npm test  ✓ ok  127 lines
 * Write: ✏️ path.ts  (23 lines)  → ✓ written
 * Edit:  ✂️ path.ts  +3 / −1
 * Find:  🔍 src/  15 results
 * Grep:  🔎 pattern  5 matches
 * Ls:    📂 src/  42 entries
 */

import type {
  BashToolDetails,
  EditToolDetails,
  ExtensionAPI,
  ReadToolDetails,
} from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { homedir } from "os";

const HOME = homedir();

function shortPath(p: string): string {
  if (p.startsWith(HOME)) return "~" + p.slice(HOME.length);
  return p;
}

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();

  // ── READ ──────────────────────────────────────────────────────────
  const readTool = createReadTool(cwd);
  pi.registerTool({
    name: "read",
    label: "read",
    description: readTool.description,
    parameters: readTool.parameters,

    async execute(toolCallId, params, signal, onUpdate) {
      return readTool.execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("📄 ")) +
          theme.fg("accent", shortPath(args.path)),
        0,
        0,
      );
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Reading…"), 0, 0);

      const details = result.details as ReadToolDetails | undefined;
      const content = result.content[0];

      // Images
      if (content?.type === "image") {
        return new Text(theme.fg("success", "🖼 image loaded"), 0, 0);
      }

      if (content?.type !== "text") return new Text("", 0, 0);

      const text = content.text;
      const lineCount = text.split("\n").length;
      let summary = theme.fg("success", `${lineCount} lines`);

      if (details?.truncation?.truncated) {
        summary += " " + theme.fg("warning", `(${details.truncation.totalLines} total)`);
      }

      if (expanded) {
        const preview = text.split("\n").slice(0, 20);
        for (const line of preview) {
          summary += "\n" + theme.fg("toolOutput", line);
        }
        if (lineCount > 20) {
          summary += "\n" + theme.fg("dim", `…${lineCount - 20} more lines`);
        }
        if (details?.fullOutputPath) {
          summary += "\n" + theme.fg("dim", `Full: ${details.fullOutputPath}`);
        }
      }

      return new Text(summary, 0, 0);
    },
  });

  // ── BASH ──────────────────────────────────────────────────────────
  const bashTool = createBashTool(cwd);
  pi.registerTool({
    name: "bash",
    label: "bash",
    description: bashTool.description,
    parameters: bashTool.parameters,

    async execute(toolCallId, params, signal, onUpdate) {
      return bashTool.execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme) {
      const command =
        args.command.length > 70
          ? args.command.slice(0, 67) + "…"
          : args.command;
      return new Text(
        theme.fg("toolTitle", theme.bold("$ ")) +
          theme.fg("accent", command),
        0,
        0,
      );
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Running…"), 0, 0);

      const details = result.details as BashToolDetails | undefined;
      const content = result.content[0];
      const output = content?.type === "text" ? content.text : "";

      const exitMatch = output.match(/exit code: (\d+)/);
      const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : null;
      const lines = output.trim().split("\n").filter((l) => l.trim());
      const lineCount = lines.length;

      let summary: string;
      if (exitCode === 0) {
        summary = theme.fg("success", "✓ ok");
      } else if (exitCode !== null) {
        summary = theme.fg("error", `✗ exit ${exitCode}`);
      } else {
        summary = theme.fg("success", "✓ ok");
      }

      summary += "  " + theme.fg("dim", `${lineCount} lines`);

      if (details?.truncation?.truncated) {
        summary += " " + theme.fg("warning", "[truncated]");
      }

      if (expanded) {
        const previewLines = output.trim().split("\n");
        const maxShow = Math.min(previewLines.length, 25);
        for (let i = 0; i < maxShow; i++) {
          summary += "\n" + theme.fg("toolOutput", previewLines[i]);
        }
        if (previewLines.length > 25) {
          summary +=
            "\n" + theme.fg("dim", `…${previewLines.length - 25} more lines`);
        }
      }

      return new Text(summary, 0, 0);
    },
  });

  // ── WRITE ─────────────────────────────────────────────────────────
  const writeTool = createWriteTool(cwd);
  pi.registerTool({
    name: "write",
    label: "write",
    description: writeTool.description,
    parameters: writeTool.parameters,

    async execute(toolCallId, params, signal, onUpdate) {
      return writeTool.execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme) {
      const lineCount = args.content.split("\n").length;
      return new Text(
        theme.fg("toolTitle", theme.bold("✏️ ")) +
          theme.fg("accent", shortPath(args.path)) +
          theme.fg("dim", `  (${lineCount} lines)`),
        0,
        0,
      );
    },

    renderResult(_result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Writing…"), 0, 0);

      const content = _result.content[0];
      if (content?.type === "text" && content.text.startsWith("Error")) {
        return new Text(
          theme.fg("error", content.text.split("\n")[0]),
          0,
          0,
        );
      }

      return new Text(theme.fg("success", "✓ written"), 0, 0);
    },
  });

  // ── EDIT ──────────────────────────────────────────────────────────
  const editTool = createEditTool(cwd);
  pi.registerTool({
    name: "edit",
    label: "edit",
    description: editTool.description,
    parameters: editTool.parameters,
    renderShell: "self",

    async execute(toolCallId, params, signal, onUpdate) {
      return editTool.execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("✂️ ")) +
          theme.fg("accent", shortPath(args.path)),
        0,
        0,
      );
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Editing…"), 0, 0);

      const details = result.details as EditToolDetails | undefined;
      const content = result.content[0];

      if (content?.type === "text" && content.text.startsWith("Error")) {
        return new Text(
          theme.fg("error", content.text.split("\n")[0]),
          0,
          0,
        );
      }

      if (!details?.diff) {
        return new Text(theme.fg("success", "✓ applied"), 0, 0);
      }

      const diffLines = details.diff.split("\n");
      let additions = 0;
      let removals = 0;
      for (const line of diffLines) {
        if (line.startsWith("+") && !line.startsWith("+++")) additions++;
        if (line.startsWith("-") && !line.startsWith("---")) removals++;
      }

      let summary =
        theme.fg("success", `+${additions}`) +
        theme.fg("dim", " / ") +
        theme.fg("error", `−${removals}`);

      if (expanded) {
        const maxShow = Math.min(diffLines.length, 25);
        for (let i = 0; i < maxShow; i++) {
          const line = diffLines[i];
          if (line.startsWith("+") && !line.startsWith("+++")) {
            summary += "\n" + theme.fg("toolDiffAdded", line);
          } else if (line.startsWith("-") && !line.startsWith("---")) {
            summary += "\n" + theme.fg("toolDiffRemoved", line);
          } else {
            summary += "\n" + theme.fg("toolDiffContext", line);
          }
        }
        if (diffLines.length > 25) {
          summary +=
            "\n" +
            theme.fg("dim", `…${diffLines.length - 25} more diff lines`);
        }
      }

      return new Text(summary, 0, 0);
    },
  });

  // ── FIND ──────────────────────────────────────────────────────────
  const findTool = createFindTool(cwd);
  pi.registerTool({
    name: "find",
    label: "find",
    description: findTool.description,
    parameters: findTool.parameters,

    async execute(toolCallId, params, signal, onUpdate) {
      return findTool.execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("🔍 ")) +
          theme.fg("accent", args.pattern || "*") +
          theme.fg("dim", " in ") +
          theme.fg("accent", shortPath(args.path || ".")),
        0,
        0,
      );
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Searching…"), 0, 0);

      const content = result.content[0];
      if (content?.type !== "text") return new Text("", 0, 0);

      const entries = content.text.trim().split("\n").filter(Boolean);
      const count = entries.length;

      let summary = theme.fg("success", `${count} results`);

      if (expanded) {
        const maxShow = Math.min(entries.length, 15);
        for (let i = 0; i < maxShow; i++) {
          summary += "\n" + theme.fg("toolOutput", entries[i]);
        }
        if (entries.length > 15) {
          summary +=
            "\n" + theme.fg("dim", `…${entries.length - 15} more`);
        }
      }

      return new Text(summary, 0, 0);
    },
  });

  // ── GREP ──────────────────────────────────────────────────────────
  const grepTool = createGrepTool(cwd);
  pi.registerTool({
    name: "grep",
    label: "grep",
    description: grepTool.description,
    parameters: grepTool.parameters,

    async execute(toolCallId, params, signal, onUpdate) {
      return grepTool.execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("🔎 ")) +
          theme.fg("accent", `/${args.pattern}/`) +
          theme.fg("dim", " in ") +
          theme.fg("accent", shortPath(args.path || ".")),
        0,
        0,
      );
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Searching…"), 0, 0);

      const content = result.content[0];
      if (content?.type !== "text") return new Text("", 0, 0);

      const matches = content.text.trim().split("\n").filter(Boolean);
      const count = matches.length;

      let summary = theme.fg("success", `${count} matches`);

      if (expanded) {
        const maxShow = Math.min(matches.length, 15);
        for (let i = 0; i < maxShow; i++) {
          summary += "\n" + theme.fg("toolOutput", matches[i]);
        }
        if (matches.length > 15) {
          summary +=
            "\n" + theme.fg("dim", `…${matches.length - 15} more`);
        }
      }

      return new Text(summary, 0, 0);
    },
  });

  // ── LS ────────────────────────────────────────────────────────────
  const lsTool = createLsTool(cwd);
  pi.registerTool({
    name: "ls",
    label: "ls",
    description: lsTool.description,
    parameters: lsTool.parameters,

    async execute(toolCallId, params, signal, onUpdate) {
      return lsTool.execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("📂 ")) +
          theme.fg("accent", shortPath(args.path || ".")),
        0,
        0,
      );
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Listing…"), 0, 0);

      const content = result.content[0];
      if (content?.type !== "text") return new Text("", 0, 0);

      const entries = content.text.trim().split("\n").filter(Boolean);
      const count = entries.length;

      let summary = theme.fg("success", `${count} entries`);

      if (expanded) {
        const maxShow = Math.min(entries.length, 15);
        for (let i = 0; i < maxShow; i++) {
          summary += "\n" + theme.fg("toolOutput", entries[i]);
        }
        if (entries.length > 15) {
          summary +=
            "\n" + theme.fg("dim", `…${entries.length - 15} more`);
        }
      }

      return new Text(summary, 0, 0);
    },
  });
}
