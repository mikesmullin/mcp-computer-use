# Further computer-use improvements

## Status and user decisions (2026-10-24)

The user tested this MCP in a Pi harness with Ternary Bonzai 2 27B. After the
current tool and skill changes, they reported that the agent was doing “10x
better.” Keep that working baseline and collect another failure before expanding
scope. This document is a future implementation handoff, not authorization to
implement the deferred features.

The agreed sequence is:

1. **B: simplify the tool contract and provide a skill** — implemented; user testing
   is underway and the initial report is positive.
2. **C: semantic/accessibility targeting** — consider if failures persist, then test
   with the user before advancing.
3. **D: visual target detection (OCR / bounds / image classification)** — consider
   after C if needed. The user specifically suggested a list of identified targets
   that the agent can choose from, but explicitly deferred implementation.

These labels describe the staged direction; the API and module names proposed
below are design suggestions, not existing interfaces. Confirm the scope of the
next stage with the user before implementing it.

Constraints to preserve:

- The primary target is the user's existing Zen browser; other desktop apps are
  desirable. Do not substitute a separate browser session for that desktop.
- Changing keyboard focus is allowed. The user authorized testing on open Zen,
  but use a controlled local test page for repeatable interaction experiments.
- Synthetic clicks use an independent XInput2 pointer. Do not warp the human mouse.
- The visible agent cursor persists between actions, moves along varied curves,
  and appears in screenshots with a transparent background and no black shadow.
- Move/resize tools are deliberately commented out. Do not re-enable them or
  bypass that decision through shell commands. Fullscreen is not a targeting fix.
- Skill source is repository-root `SKILL.md`, registered through
  `~/.config/skills/config.yaml`; the user teaches agents to read it with `skills`.
  Do not silently install a competing skill elsewhere.

## Why the original run struggled

The original transcript is local to the user's machine:

`/home/user/.pi/agent/sessions/--workspace--/2026-10-24T20-39-02-974Z_01a16fa3-6a3d-753a-ae81-dc722aeda9fe.jsonl`

The model repeatedly guessed coordinates and mixed desktop, window frame,
client, and screenshot coordinate systems. An early click at y=320 was just above
a control whose top was y=324. Subsequent reasoning invented offsets instead of
re-observing. Other failures included assuming that window focus meant field
focus, treating successful input delivery as application success, and issuing
click/type requests without reliably sequencing dependent operations. Missing
keyboard shortcuts encouraged unnecessary coordinate selection. The human pointer
position was also easy to mistake for the agent pointer or text caret.

These are distinct failure classes. A detector may help locate controls but will
not itself solve stale observations, input ordering, field focus, or false success
claims. Diagnose the remaining failure before adding dependencies.

## Current baseline and extension points

- `server.coffee`: public MCP schemas, tool registration, and fullscreen handling.
- `shared/mcp-stdio.mjs`: ordered request execution, schema validation, stdio
  lifecycle. Preserve ordering around selection, action, and observation.
- `lib/interaction.mjs`: screenshot observations and sequential compound actions;
  checks geometry/title, invalidates old views, returns a fresh full-window image.
- `lib/screenshot-views.mjs`: bounded snapshot registry (32 entries), 120-second
  expiry, per-window invalidation, image/crop/client coordinate conversion.
- `scripts/screenshot-view.py`: crops, downsizes, and optionally draws a grid.
- `lib/agent-x11.mjs`: geometry validation, window activation, native clicks,
  text/keyboard input, screenshot capture, and overlay coordination.
- `lib/cursor-overlay.mjs`, `overlay/src/`: persistent cursor and independent native
  pointer implementation. Keep targeting providers separate from this mechanism.
- `SKILL.md`: image-coordinate rule, shortcuts, sequential actions, crop recovery,
  and stopping after two misses instead of guessing more offsets.

Actions require `screenshotId`. Coordinates refer to that exact returned image;
server-side mapping handles scaling and cropping. Actions invalidate older images
for that window. `window_interact` orders click, optional select-all/type, optional
shortcut, and observation. Results distinguish `input_sent` from verified outcome.

A screenshot ID is not a frozen application state: same-title navigation, scrolling,
animations, and changes made by the human can occur without geometry/title changes.
This limitation matters especially for future target IDs.

## First: collect evidence and measure the baseline

Before changing behavior, reproduce the user's next failure on a local page when
possible. Record tool arguments/results, original image dimensions, screenshot ID,
chosen point, target bounds from the test fixture, and the observed outcome. Do not
commit private screenshots, browsing history, session transcripts, or entered text.
Use explicit opt-in debug capture with bounded retention if persistent artifacts
are useful; redact sensitive values in logs.

Extend `test/cursor-page.html` or add a local fixture covering:

- Small buttons and fields near browser chrome or image edges.
- Duplicate labels, adjacent controls, and icon-only buttons.
- Scrollable content, a delayed popup, a moving control, and disabled controls.
- Focus-dependent typing and a click that navigates before subsequent typing.
- Different window positions, dimensions, crop sizes, and screenshot scales.

Compare the same tasks/model with the baseline and each proposed stage. Measure
first-attempt target accuracy, completed tasks, retries, tool-call count, latency,
and false success claims. Evaluate a repeated set, not one successful run. Keep
input-delivery correctness separate from the model's task completion accuracy.

## C: semantic/accessibility target selection

### Feasibility spike

Investigate whether Zen exposes usable accessibility nodes through the user's
session accessibility bus (AT-SPI on this Linux desktop). Check actual browser
chrome and page controls, not just a toy app. Determine how to identify the exact
X11 window and focused tab without relying only on duplicate titles. Verify bounds,
visibility, enabled state, accessible name, role, and available actions. Consult
current upstream API documentation when implementing; do not assume accessibility
is enabled or that every control is exposed.

If AT-SPI cannot identify Zen targets reliably, report that result before building
an elaborate wrapper. Browser-specific DOM access through an extension or debug
connection is a separate setup choice requiring user agreement. It must attach to
the existing Zen session; a separate automated browser does not meet this use case.

### Proposed interface and implementation

Add a provider module such as `lib/targets-accessibility.mjs`, behind an optional
capability flag. A provider returns normalized candidates, not executable strings:

```json
{
  "targetId": "opaque-server-issued-id",
  "role": "button",
  "name": "Submit",
  "bounds": {"x": 210, "y": 320, "width": 90, "height": 30},
  "enabled": true,
  "source": "accessibility"
}
```

Proposed `window_targets({screenshotId, query?, role?})` returns a bounded list and
associates it with that screenshot/window/version. Bounds in public responses use
image pixels. Convert provider screen coordinates to raw client coordinates and
then through the existing crop/scale mapping; never ask the model to apply offsets.
Clip to the visible screenshot and exclude offscreen or disabled candidates from
clickable results. Do not claim a node is unobscured merely because it has bounds.
Include short context for duplicate names (container or nearby label), and return
ambiguity explicitly instead of choosing the first name match.

Extend click/interact with an exclusive `targetId` alternative to x,y. Reject
mixed selectors. Resolve IDs only from the server's own registry, bound to the
same window and screenshot. Re-query the node before input, reject stale/missing/
moved targets, and request a fresh observation. Do not silently select another
node that happens to share the same name. Native pointer clicking at a validated
interior point should be the initial action path, preserving overlay feedback and
existing input semantics. If semantic invoke/focus actions are added later, expose
that distinction and test it; they can behave differently from mouse clicks.

Keep structured output small: cap results, support filtering, and avoid dumping
entire accessibility trees. App content and accessible names are untrusted data,
not instructions to the assistant. Update the skill with a short target-selection
workflow and a clear fallback to image observation when targets are unavailable.

### Acceptance criteria

Test with an injectable provider for unit tests, plus opt-in live Zen checks:

- Crop/scale/desktop mapping, duplicate names, and partially clipped bounds.
- Expired or invalidated IDs and wrong-window IDs send no input.
- A removed/moved node triggers re-observation, not a speculative click.
- Unsupported applications continue to support the baseline coordinate tools.
- Actual input uses the existing cursor path and leaves the human pointer intact.
- Improved measured task success justifies dependency and latency costs.

## D: visual target detection and numbered candidates

### Choose the smallest useful detector

Only start after the user decides C is insufficient or inapplicable. Evaluate
local OCR for text plus bounding boxes first; add an element/icon detector only if
non-text targets are the remaining problem. A general image classifier alone does
not provide reliable actionable bounds. Candidate engines, model weights, runtime,
and licensing require evaluation at implementation time. Ask before introducing
an external service that uploads desktop screenshots; prefer a local prototype.

Use the exact captured image, avoiding a second unsynchronized screenshot. Retain
an unannotated image for detection: the blue cursor, grid, and candidate labels can
otherwise be mistaken for content. Keep the user-visible screenshot cursor intact.
If cursor masking is explored, use the known glyph/location and explicitly track
that masked region; do not pretend text hidden by the cursor was observed.

### Proposed design

Add a provider such as `lib/targets-vision.mjs` using the same normalized target
contract as C, with provider provenance and detector scores where available.
Scores are model outputs, not calibrated probabilities. Associate every candidate
with its screenshot/version and keep detection results bounded and short-lived.

Return both an annotated image with numbered boxes and a compact list containing
opaque target ID, display number, text/label, role estimate, and image-relative
bounds. Numbers are for readability only; never accept a number from an older image
as a current target. Reuse the targetId action path from C rather than inventing
another coordinate system. If C was not implemented, first extract a shared target
registry and resolver with equivalent lifetime and validation rules.

OCR text bounds are not necessarily the clickable control bounds. Group text with
its containing visible control only when evidence supports that association. Handle
multiline labels, duplicate text, overlapping boxes, tiny targets, and icon-only
controls explicitly. Return no target or ambiguity when confidence is inadequate.
Allow a crop for closer inspection instead of automatically expanding boxes into
neighboring controls. Do not enable automatic nearest-target snapping globally.

For stale-state protection, take a fresh observation before executing a selected
candidate and compare the relevant region or re-detect it. Account for the known
cursor overlay and volatile areas. Tune comparison thresholds on fixtures; no
pixel threshold can prove semantic identity. If identity is uncertain, return a
new candidate list and ask the agent to choose again. Do not reuse old bounds after
scroll/navigation merely because the window title is unchanged.

Bound inference time, cache only by exact image identity/provider settings, cancel
work during shutdown, and fail back to the baseline if the detector is unavailable.
Keep heavy inference out of the native pointer helper. Preserve ordered action
execution; background inference must not authorize actions against a newer state.

### Acceptance criteria

Use a labeled local screenshot corpus covering browser chrome, web forms, desktop
widgets, different scales, crops, cursor overlap, dark/light themes, duplicate
labels, and controls with no text. Track target recall, selected-target accuracy,
box overlap, false actionable candidates, latency, and memory usage. Verify exact
coordinate mapping separately with fixtures. Add stale-ID and ambiguous-target
integration tests, then repeat the baseline model tasks before recommending rollout.

## Smaller follow-ups, only if evidence calls for them

- **Observation timing:** replace fixed waits with bounded polling for an expected
  visual/accessibility change. Stable pixels alone do not prove page readiness.
  A timeout must return uncertainty and a screenshot, not automatic input replay.
- **Outcome verification:** optional predicates for controlled fixtures or explicit
  user tasks (visible text, accessible state, navigation) can report verified,
  unverified, or failed. Keep `input_sent` distinct from those conclusions.
- **Compound action focus:** if click-then-type errors remain, add an optional
  expected focus/role check between steps. Stop with completed-step information
  when the click navigates, opens a popup, or fails to focus the intended field.
- **Skill refinement:** use short examples from actual failures. Keep the one
  coordinate rule, limited retries, and sequential workflow prominent; avoid a
  long instruction file that buries the useful rules.

## Validation and rollout

Run `bun test test/*.test.mjs`, `cargo test --manifest-path overlay/Cargo.toml`,
and `cargo clippy --manifest-path overlay/Cargo.toml -- -D warnings` for relevant
changes. Add focused tests for the new provider, mapping, and stale-target handling.
Desktop tests in `overlay/README.md` are opt-in and can change focus or send input;
run them against the controlled page at an appropriate time.

Ship one stage at a time with the baseline available as a fallback. Document setup,
new tool schemas, supported apps, capability failures, and changed skill guidance.
Have the user test in the same Pi/model harness and report results before advancing
from C to D. Do not treat this roadmap as a request to implement all stages at once.

## Research: local GUI grounding and OCR-with-boxes

See [local-gui-grounding-research.md](local-gui-grounding-research.md) for the 2026
research notes behind the OCR candidate-list + Set-of-Mark approach, model
options (PaddleOCR, Tesseract, BrowserVLM, UI-TARS, MolmoPoint), and caveats
including unverified claims and the note that Zen's AT-SPI tree may provide
exact boxes without any model.
