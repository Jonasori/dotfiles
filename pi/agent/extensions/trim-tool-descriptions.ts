/**
 * trim-tool-descriptions — deterministic payload slimming (Phase 2 of the
 * prompt benchmark). Before every provider request:
 *
 *   1. Replace verbose tool descriptions with compact versions (per-tool map
 *      below; input_schemas untouched — cache stability stays deterministic
 *      from turn 1).
 *   2. Condense the <available_skills> block to name + short routing line +
 *      location (skills stay loadable by name).
 *   3. Compress the pi-docs block to paths + doc index.
 *
 * Policy rules:
 *   - Only descriptions are rewritten, never schemas, names, or count
 *     (except SUPPRESS_TOOLS/SUPPRESS_SKILLS below, which hide context-mode's
 *     self-maintenance tools from the model — the package stays installed and
 *     its hooks keep running; removal is presentation-layer only and revertible
 *     by deleting an entry from the list).
 *   - Rewrite is a pure function of tool name + PI_CTX_MODE — same output every
 *     request for a given env.
 *   - On any error, return the payload unchanged (never break a request).
 *   - Unmapped tools/skills: leave untouched (fallbacks below are opt-in per
 *     name so pi updates never get clobbered silently).
 *   - PI_CTX_MODE=off additionally suppresses ALL ctx_* tools and skills
 *     (benchmark switch for the context-mode value experiment — same code,
 *     different env, no churn between A/B legs).
 */

// ---------------------------------------------------------------------------
// Suppression sets (Phase 3 V2 — Cluster C)
// ---------------------------------------------------------------------------
// Hidden tools: ctx_stats/ctx_doctor/ctx_upgrade/ctx_insight/ctx_purge exist so
// context-mode can be operated, not so the user can work. Skills suppressed
// alongside: their routing lines are redundant once the tools are invisible.
// Suppression only filters what the MODEL sees; the package, its hooks, and the
// knowledge base are untouched (a later full drop must delete the package;
// this list is the safe, revertible intermediate).
const SUPPRESS_TOOLS = new Set([
  "ctx_stats",
  "ctx_doctor",
  "ctx_upgrade",
  "ctx_insight",
  "ctx_purge",
]);

const SUPPRESS_SKILLS = new Set([
  "ctx-doctor",
  "ctx-insight",
  "ctx-purge",
  "ctx-stats",
  "ctx-upgrade",
]);

// ---------------------------------------------------------------------------
// Tool description map (name -> compact description)
// ---------------------------------------------------------------------------
// No type imports here: extensions are compiled by pi's runtime with the API
// package external; other extensions in this dir follow the same pattern.

// ---------------------------------------------------------------------------
// Tool description map (name -> compact description)
// ---------------------------------------------------------------------------
const TOOL_DESC: Record<string, string> = {
  // ---- context-mode (17,075c -> ~2,200c) ----
  ctx_execute:
    "Run code in a sandboxed subprocess (JS/TS/Python/Shell/etc). Only what you console.log() enters conversation memory — use it to process large outputs (filter, count, aggregate, parse) and print only the summary. Set intent to auto-index outputs over ~5KB for ctx_search retrieval. Wrap risky calls in try/catch. background:true detaches long-running processes on timeout.",
  ctx_execute_file:
    "Read a file into a FILE_CONTENT variable in a sandbox and run code over it; only console.log output returns. Use to derive answers (counts, matches, parses, stats) from a large file without pulling its bytes into conversation.",
  ctx_index:
    "Store content (inline or via path, incl. directories) in a persistent FTS5 knowledge base (BM25). Splits markdown by headings, keeps code blocks; returns chunk metadata and the exact ctx_search call shape. Use for docs, API references, skill prompts too large to keep verbatim.",
  ctx_search:
    "Search the unified FTS5 knowledge base (Porter stemming + trigram matchers, RRF merged, typo-corrected). Batch ALL questions into one call (2-4 technical terms each). Scope with source:, contentType: code/prose, sort: timeline. Returns window-extracted snippets, not raw dumps.",
  ctx_fetch_and_index:
    "Fetch URL(s), convert HTML to markdown (JSON chunked by key paths), persist in the knowledge base, return small preview windows. Batch with requests + concurrency 2-8; cached 24h (ttl overrides, force re-fetches). Raw page bytes never enter context.",
  ctx_batch_execute:
    "Run multiple commands in ONE call; every output is auto-indexed. Pass queries to get the matching sections back in the same round trip. concurrency 2-8 parallelizes the fetch phase; keep CPU-bound or stateful commands at 1.",
  ctx_stats:
    "Context consumption statistics for this session: bytes and tokens returned per tool, call counts, savings ratio.",
  ctx_doctor:
    "Diagnose context-mode installation (runtimes, hooks, plugin registration). Returns a plain-text status report with [OK]/[FAIL]/[WARN] prefixes.",
  ctx_upgrade:
    "Upgrade context-mode from GitHub. Returns a shell command you MUST run with your shell tool; the user must restart the session afterward.",
  ctx_purge:
    "DESTRUCTIVE: permanently delete indexed content (knowledge base + session stats). Requires confirm:true and exactly one scope (project, or session with sessionId). Use only when the user explicitly asks to wipe something.",
  ctx_insight:
    "Open the context-mode Insight analytics dashboard (productive rate, retry waste, blockers) in the default browser. A launcher, not a Q&A engine — use ctx_search for natural-language questions.",

  // ---- pi-lens (7,674c -> ~2,300c) ----
  lens_diagnostics:
    "Query pi-lens diagnostic state. delta = this turn's fixable warnings (default); all = blocking errors+warnings for files you edited this session (use before declaring work done); full = EXPENSIVE project-wide LSP sweep, optionally refreshRunners for fresh heavyweight analyzers (knip, jscpd, madge, gitleaks, CVEs). paths filters to specific files.",
  symbol_search:
    "BM25 identifier search over the persisted word index — 'which files are relevant to <query>'. Returns ranked files with best-match line ranges. Filters: lang:, file:, ext:, each -negatable. Discovery funnel: symbol_search -> module_report -> read_symbol.",
  project_report:
    "Project-level orientation from the cached review graph: hubs, entry points, subsystem layering/cycles, risk hotspots, suspected dead weight. view=compact is the cheapest text form. Cold cache returns available:false and builds in the background.",
  module_report:
    "Structured outline of one module: symbols with line ranges, who-uses-this, callbacks. blastRadius = transitive dependents; callGraph = callees; view=compact = one line per symbol. Prefer over reading the whole file; use read_symbol for bodies.",
  read_symbol:
    "Verbatim body of one named symbol (or Class.method) in a file, including attached doc comment. A miss returns the ~3 nearest symbol names. Counts as having read that symbol for the edit guard.",
  pi_lens_activate_tools:
    "Activate situational pi-lens tools (ast_grep_search/replace/outline/dump, lsp_navigation, lens_diagnostic_mark). Call ONCE with the tools you need — they become callable starting the NEXT turn.",

  // ---- pi-subagents (2,530c -> ~730c) ----
  subagent:
    "Delegate to a subagent. {agent,task} for one child, or workflowScript for orchestration (async:true; launch children only inside the script via runs.run/runs.all and observe each with await). Use for advisory review, parallel fanout, implementation handoffs. Keep one writer per cwd.",
  subagent_wait:
    "Block until background subagent work owned by this session changes: {} = first run finishes, {all:true} = all active, {id} = specific run. In interactive chat, return control to the user instead and let the session wake on completion; headless runs auto-drain at agent_end. nonBlocking subscriptions persist a wake and return immediately.",
  subagent_supervisor:
    "Native pi-subagents supervisor channel: reply/pending/status to answer child subagent requests without overriding pi-intercom.",

  // ---- pi-web-access (2,312c -> ~950c) ----
  web_search:
    "Search the web (Brave/OpenAI/Exa/etc; pass provider array or 'all' to search several at once). Prefer queries [2-4 varied angles] over a single query — each returns its own synthesized answer with citations. recencyFilter/domainFilter supported; includeContent fetches full pages in the background.",
};

// ---------------------------------------------------------------------------
// Skills block: name -> compact routing description. Unmapped skills keep
// their original description.
// ---------------------------------------------------------------------------
const SKILL_DESC: Record<string, string> = {
  "context-mode":
    "Use context-mode tools (ctx_execute, ctx_execute_file) instead of Bash/cat when processing large outputs (analyze logs, summarize output, parse JSON, run tests, process API responses, browser snapshots, fetch docs, large file analysis).",
  "ctx-doctor":
    "Run context-mode diagnostics: checks runtimes, hooks, plugin registration, npm and marketplace versions. Trigger: /context-mode:ctx-doctor",
  "ctx-index":
    "Index a local file or directory into context-mode's persistent FTS5 knowledge base so future ctx_search calls retrieve snippets without rereading raw files. Trigger: /context-mode:ctx-index",
  "ctx-insight":
    "Open the context-mode Insight analytics dashboard in your default browser (per-engineer productivity, retry waste, blocker detection). Trigger: /context-mode:ctx-insight",
  "ctx-purge":
    "DESTRUCTIVE: permanently delete all indexed content and reset session stats. Requires confirm:true and exactly one scope. Use only when the user explicitly asks to wipe. Trigger: /context-mode:ctx-purge",
  "ctx-search":
    "Search context-mode's persistent FTS5 knowledge base for previously indexed local project content, documentation, or session memory. Trigger: /context-mode:ctx-search",
  "ctx-stats":
    "Show how much context window context-mode saved this session (tokens, savings ratio, per-tool breakdown). Read-only — use ctx_purge to wipe. Trigger: /context-mode:ctx-stats",
  "ctx-upgrade":
    "Update context-mode from GitHub and fix hooks/settings. Returns a shell command to run; restart the session after. Trigger: /context-mode:ctx-upgrade",
  "pi-subagents":
    "Delegate work to builtin or custom subagents: single-agent, parallel, scripted-chaining, async, forked-context, and coordinated workflows. Use for advisory review, implementation handoffs, and multi-step tasks.",
  "loop-police-help":
    "Reference for pi-loop-police: commands, config keys, and how to persistently edit loop-police.json.",
  "loop-police-postmortem":
    "Post-mortem analysis of loop-police detections: reconstruct what triggered each firing, classify as justified / false positive / ineffective, and recommend concrete config changes. Use when the user asks why loop-police fired or how to tune it.",
  "pi-lens-ast-grep":
    "Use when searching or replacing code patterns — use ast-grep instead of text search for semantic accuracy.",
  "pi-lens-lsp-navigation":
    "Navigate code with IDE features and run proactive LSP diagnostics on files/folders/batches. Use as PRIMARY for code intelligence and type/error checks.",
  "pi-lens-write-ast-grep-rule":
    "Use when writing a new pi-lens ast-grep rule YAML file — covers schema, drop path, gotchas, and NAPI runner constraints.",
  "pi-lens-write-tree-sitter-rule":
    "Use when writing a new pi-lens tree-sitter query rule YAML file — covers schema, S-expression syntax, capture names, predicates, and gotchas.",
  "screenshot-ocr":
    "OCR text from macOS screenshots or images using the local Vision framework (no API needed). Use when the user shares a screenshot and its text/error content needs to be read — especially when the current model cannot see images or the read tool omits image content.",
  "brave-search":
    "Web search and content extraction via Brave Search API. Lightweight, no browser required.",
  "browser-tools":
    "Interactive browser automation via Chrome DevTools Protocol. Use when you need to interact with web pages, test frontends, or visible-browser interaction is required.",
  gccli:
    "Google Calendar CLI: list calendars, view/create/update events, check availability.",
  gdcli:
    "Google Drive CLI: list, search, upload, download, and share files and folders.",
  gmcli:
    "Gmail CLI: search emails, read threads, send messages, manage drafts, and handle labels/attachments.",
  transcribe:
    "Local speech-to-text transcription on Apple Silicon macOS. Supports wav directly and other formats via ffmpeg.",
  vscode:
    "VS Code integration for viewing diffs and comparing files. Use when showing file differences to the user.",
  "youtube-transcript":
    "Fetch transcripts from YouTube videos for summarization and analysis.",
};

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------
export default function (pi: any) {
  pi.on("before_provider_request", (event: any, _ctx: any) => {
    try {
      const payload = event.payload as any;
      if (!payload || typeof payload !== "object") return undefined;

      // 0) Suppression: hide Cluster C tools (+ all ctx tools when the
      //    benchmark switch PI_CTX_MODE=off is set). Schemas stay intact for
      //    any tool we keep; suppressed tools are simply not presented.
      const ctxAll = (globalThis as any).process?.env?.PI_CTX_MODE === "off";
      const suppress = new Set([...SUPPRESS_TOOLS, ...SUPPRESS_SKILLS]);
      if (ctxAll) {
        for (const t of [
          "ctx_execute",
          "ctx_execute_file",
          "ctx_batch_execute",
          "ctx_index",
          "ctx_search",
          "ctx_fetch_and_index",
          "context-mode",
          "ctx-index",
          "ctx-search",
        ] as const)
          suppress.add(t);
      }

      // 1) Tool descriptions (schemas untouched)
      if (Array.isArray(payload.tools)) {
        payload.tools = payload.tools.filter((t: any) => {
          const name: string =
            t?.name ??
            (typeof t?.function === "object" ? t.function?.name : undefined);
          return !(name && suppress.has(name));
        });
        for (const t of payload.tools) {
          const name: string =
            t?.name ??
            (typeof t?.function === "object" ? t.function?.name : undefined);
          if (!name) continue;
          const slim = TOOL_DESC[name];
          if (!slim) continue;
          if (t?.description != null) t.description = slim;
          else if (t?.function && typeof t.function === "object")
            t.function.description = slim;
        }
      }

      // 2) System message: skills block + pi-docs block
      const msg0 = Array.isArray(payload.messages)
        ? payload.messages[0]
        : undefined;
      if (msg0 && typeof msg0.content === "string") {
        let sys = msg0.content;

        const skillsStart = sys.indexOf("<available_skills>");
        const skillsEnd = sys.indexOf("</available_skills>");
        if (skillsStart >= 0 && skillsEnd > skillsStart) {
          const open = skillsStart + "<available_skills>".length;
          const raw = sys.slice(open, skillsEnd);
          const rebuilt: string[] = [];
          for (const piece of raw.split("<skill>").slice(1)) {
            const name = /<name>([\s\S]*?)<\/name>/.exec(piece)?.[1]?.trim();
            if (!name) continue;
            if (suppress.has(name)) continue;
            const loc = /<location>([\s\S]*?)<\/location>/
              .exec(piece)?.[1]
              ?.trim();
            const desc =
              SKILL_DESC[name] ??
              /<description>([\s\S]*?)<\/description>/.exec(piece)?.[1]?.trim();
            if (!desc) continue;
            let entry = `<skill>\n    <name>${name}</name>\n    <description>${desc}</description>`;
            if (loc) entry += `\n    <location>${loc}</location>`;
            entry += "\n  </skill>";
            rebuilt.push(entry);
          }
          if (rebuilt.length > 0) {
            sys =
              sys.slice(0, open) +
              "\n" +
              rebuilt.join("\n") +
              "\n" +
              sys.slice(skillsEnd);
          }
        }

        // 3) pi-docs block: keep paths + doc index, drop prose
        const docsStart = sys.indexOf("Pi documentation (read only");
        if (docsStart >= 0) {
          const docsLineEnd = sys.indexOf("\n", docsStart);
          const docsBlockEnd = sys.indexOf("\n\n", docsLineEnd);
          if (docsLineEnd > 0 && docsBlockEnd > docsLineEnd) {
            const block = sys.slice(docsStart, docsBlockEnd);
            const path = (label: string) => {
              const m = block.match(new RegExp(`\\- ${label}: ([^\\n]+)`));
              return m ? m[1] : "";
            };
            const main = path("Main documentation");
            const docs = path("Additional docs");
            const ex = path("Examples");
            if (main || docs || ex) {
              const slim =
                "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):\n" +
                (main ? `- Main documentation: ${main}\n` : "") +
                (docs ? `- Additional docs: ${docs}\n` : "") +
                (ex ? `- Examples: ${ex}\n` : "") +
                "- Doc index: extensions.md, themes.md, skills.md, prompt-templates.md, tui.md, keybindings.md, sdk.md, custom-provider.md, models.md, packages.md, environment-variables.md\n" +
                "- Resolve docs/... under Additional docs and examples/... under Examples; read pi .md files completely and follow cross-references.";
              sys = sys.slice(0, docsStart) + slim + sys.slice(docsBlockEnd);
            }
          }
        }

        if (sys !== msg0.content) msg0.content = sys;
      }

      // before_provider_request contract: returning undefined keeps the
      // payload unchanged; returning any other value replaces it for later
      // handlers and the actual request. Return the (mutated) payload.
      return { ...payload, tools: payload.tools, messages: payload.messages };
    } catch {
      // Never break a request over trimming.
      return undefined;
    }
  });
}
