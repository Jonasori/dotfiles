---
name: screenshot-ocr
description: OCR text from macOS screenshots or images using the local Vision framework (no API needed). Use when the user shares a screenshot and its text/error content needs to be read — especially when the current model cannot see images or the read tool omits image content.
---

# Screenshot OCR (macOS Vision)

Extract text from a screenshot/image locally with Apple's Vision framework. No network, no API, no image-model required.

## When to use

- The user shares a screenshot path and its content matters (errors, panels, terminal output).
- Attempting `read` on the image returned "tool image omitted: model does not support images".
- The image has already been fetched to a local path (e.g. Desktop screenshot).

## How

```bash
swift ~/.pi/agent/skills/screenshot-ocr/ocr.swift "<path-or-fragment>"
```

The script accepts either an exact path or a **search fragment** (a substring of the filename). It searches the Desktop and the current directory for a matching file, then OCRs it.

### Example

```bash
swift ~/.pi/agent/skills/screenshot-ocr/ocr.swift "2.04.02"
```

## Hard-won gotchas (do not relearn these)

1. **macOS screenshot filenames contain a non-ASCII space (U+202F) before AM/PM.** Typing the path with a normal space fails (`sips` says "not a valid file", NSImage returns nil). Always resolve via fragment search or `find`, never hand-type the full "Screenshot 2026-… at … PM.png" path.

2. **Run via the Bash tool, not the sandbox/ctx_execute.** The sandbox subprocess may lack filesystem access to the target path (NSImage fails to load). Command still works fine through the ordinary Bash tool.

3. **sd `sips` fallback:** if the image type is exotic, `sips -s format png <input> --out /tmp/ocr-src.png` first, then OCR the converted copy.

4. The OCR script needs `swift` (Xcode CLT). First run may take a few seconds to compile. Output is plain text lines in reading order; formatting (columns/boxes) is not preserved — supplement with product knowledge when interpreting.

## Files

- `ocr.swift` — self-contained script (fragment search + Vision OCR + sips fallback note).

## Troubleshooting

- "cannot load image" → path has non-ASCII chars or sandbox access issue; retry via Bash with fragment.
- No text returned but image is fine → screenshot is mostly graphical; try `--preprocess` (upscale + contrast) if added later, or describe pixels another way.
