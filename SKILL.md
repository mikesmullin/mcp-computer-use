---
name: computer-use
description: Interact with the user's existing Zen browser and other desktop windows through the computer-use MCP on AwesomeWM/X11. Use for desktop screenshots, clicks, typing, and keyboard shortcuts.
---

# Desktop interaction

Use the computer-use MCP tools. In Pi their names may be prefixed
`mcp__computer_use__`. This controls the user's existing desktop, including Zen.

## Coordinates: one rule

**Click using x,y from the returned IMAGE and its screenshotId. Apply no offsets.**
The server handles scaling, crops, browser chrome, and desktop placement. Do not
subtract title-bar/sidebar dimensions, add window origins, or use CSS/page-log
coordinates. `window_list` frame geometry is for identifying windows, not clicking.

Start with `window_list` filtered by `class: "zen"`, then `window_screenshot` with
the chosen `windowId`. Pin that ID when requesting new observations.
The response gives `screenshotId`, image `width`/`height`, title, and agent cursor
in image pixels. Choose the **center** of the visible target, not its border.

## Prefer short, ordered interactions

- New tab: `window_key` with `keys: "Ctrl+t"`.
- Address bar: `window_key` with `keys: "Ctrl+l"`; inspect its result, then
  `window_interact` with `text: "https://example.com"`, `keys: "Enter"`.
- Fill a visible field: `window_interact` with `screenshotId`, `x`, `y`, `text`,
  and optionally `replace: true`. This clicks, selects existing text if requested,
  types, and returns a screenshot in order. Use replace only for a text field.
- Click a button: `window_click` with `screenshotId`, `x`, and `y`.
- Other supported shortcuts include Tab, Shift+Tab, Enter, Escape, Ctrl+a,
  BackSpace, Delete, arrows, Home, End, PageUp, PageDown, and F1–F12.

Wait for each result and use its **new screenshotId** for the next action. Do not
submit dependent actions in parallel. An action invalidates older screenshots of
that window; IDs also expire after two minutes. A stale-ID or geometry error means
capture again, not invent a coordinate correction.

`window_type` only types into the currently focused control. It does not find or
focus a field. Window focus and text-field focus are different.

## Inspect and recover

Every successful input request returns `status: "input_sent"` plus a fresh image.
That does **not** establish application success. Look for the expected change:
counter increment, new tab, entered text, navigation, or dialog.

After a miss, request `window_screenshot` with the latest `screenshotId`,
`crop: {x, y, width, height}` around the target, and optionally `grid: true`.
Crop coordinates refer to the previous image. The crop returns its own screenshotId
and local pixel coordinates starting at (0,0); use those directly for the action.
Grid labels mark image pixels every 100 pixels. Set `maxWidth: 1600` if useful;
the default is 1280 and crops are not enlarged beyond their native resolution.

After two unsuccessful attempts at the same target, stop retrying and report the
uncertainty or use an applicable keyboard shortcut. Do not compensate by moving,
resizing, or changing zoom. Move/resize tools are intentionally unavailable.
Do not bypass them with shell commands. Do not change fullscreen merely to locate
an element; use it only when the user requests it.

If an error reports completed steps, those steps may already have changed the app.
Take a screenshot before retrying; never repeat a compound action blindly.

The blue arrow is the agent's last pointer target. It stays in place during typing
and turns amber while typing; it is not the text caret. `cursor_position` reports
the **human** pointer and is not feedback for agent clicks. The integrated-browser
MCP is a different browser surface, not the user's open Zen tab.
