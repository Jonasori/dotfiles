/**
 * Clean Title Bar — replaces the messy default terminal title with useful info.
 *
 * Format: π · project  ·  model  ·  thinking
 * While working: ⠋ π · project  ·  model  ·  thinking
 *
 * Updates automatically when you switch models or change thinking level.
 */

import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function buildTitle(
  modelId: string,
  thinkingLevel: string,
  working: boolean,
  spinnerIdx: number,
  pi: ExtensionAPI,
): string {
  const project = path.basename(process.cwd());
  const session = pi.getSessionName();
  const name = session ?? project;

  const thinking = thinkingLevel === "off" ? "" : " · " + thinkingLevel;
  const model = modelId ? " · " + modelId : "";

  if (working) {
    return `${BRAILLE[spinnerIdx % BRAILLE.length]} π · ${name}${model}${thinking}`;
  }
  return `π · ${name}${model}${thinking}`;
}

export default function (pi: ExtensionAPI) {
  let currentModel = "";
  let currentThinking = "";
  let timer: ReturnType<typeof setInterval> | null = null;
  let frameIdx = 0;
  let activeCtx: ExtensionContext | null = null;

  function setTitle(working: boolean) {
    if (!activeCtx) return;
    activeCtx.ui.setTitle(
      buildTitle(currentModel, currentThinking, working, frameIdx, pi),
    );
  }

  function startSpinner(ctx: ExtensionContext) {
    stopSpinner();
    activeCtx = ctx;
    timer = setInterval(() => {
      frameIdx++;
      setTitle(true);
    }, 80);
  }

  function stopSpinner() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    frameIdx = 0;
  }

  // Capture the context and initial state on session start
  pi.on("session_start", async (_event, ctx) => {
    activeCtx = ctx;
    currentModel = ctx.model?.id ?? "";
    currentThinking = pi.getThinkingLevel();
    setTitle(false);
  });

  // Update when model changes
  pi.on("model_select", async (event, ctx) => {
    activeCtx = ctx;
    currentModel = event.model.id;
    setTitle(false);
  });

  // Update when thinking level changes
  pi.on("thinking_level_select", async (event, ctx) => {
    activeCtx = ctx;
    currentThinking = event.level;
    setTitle(false);
  });

  // Animate spinner while agent is working
  pi.on("agent_start", async (_event, ctx) => {
    startSpinner(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    stopSpinner();
    activeCtx = ctx;
    setTitle(false);
  });

  // Cleanup
  pi.on("session_shutdown", async (_event, ctx) => {
    stopSpinner();
    activeCtx = ctx;
    setTitle(false);
  });
}
