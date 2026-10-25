# mcp-computer-use

Target-based MCP control of the existing AwesomeWM/X11 desktop and Zen browser.
Agents choose a numeric target ID or an exact unique label. The server handles
bounds, browser scrolling, and native input through an independent XInput2 pointer.
The human pointer stays put; windows are never moved or resized by these tools.

## Run

Requires Bun, Rust, `awesome-client`, `xdotool`, `scrot`, and an authorized X11
session with XInput2, XTEST, and SHAPE.

```sh
cd /workspace/mcp-computer-use
npm ci
cargo build --release --manifest-path overlay/Cargo.toml
bun server.coffee
```

Launch as MCP stdio with this repository as the working directory. Inherit
`DISPLAY`, `XAUTHORITY`, and `DBUS_SESSION_BUS_ADDRESS` from the desktop session.
Restart the MCP connection after updates so clients reload its schemas.

Provider configuration:

- `MCP_ZEN_URL`: existing mcp-zen HTTP endpoint, default `http://127.0.0.1:8791/mcp`.
  Requires its connected permanent Firefox/Zen extension.
- `VISION_OCR_URL`: operator-managed OCR service, default `http://127.0.0.1:1239`.
- `MCP_VISION_ENTRY`: mcp-vision stdio entrypoint, default
  `/workspace/mcp-vision/server.mjs`. Used lazily for descriptions and decisions.
  Its `VISION_LIQUID_URL`, `VISION_H2O_URL`, and other environment settings inherit.

No tool starts, stops, switches, or reloads model services. There is no CPU OCR
fallback. Browser observation can use DOM when OCR is unavailable, or OCR when
DOM is unavailable, with explicit warnings. If both fail, observation fails.
Descriptions/decisions report an error when their provider is unavailable.
See [overlay/README.md](overlay/README.md) for native setup.

The blue cursor now uses one optional shared `agent-cursor.service`, also used by
mcp-zen's DOM interactions. Install/start it with the instructions in
[AGENT_CURSOR_PROTOCOL.md](docs/AGENT_CURSOR_PROTOCOL.md). Without the listener,
input still works but there is no arrow animation. Reconnect older computer-use MCP
processes after upgrading so they stop using per-session private renderers.


## API 0.4

This replaces the coordinate/screenshotId API. All inputs reject unknown fields.
`window_screenshot`, `window_info`, `window_fullscreen`, `window_interact`, and
`cursor_position` are no longer exposed. No public input accepts coordinates,
rectangles, selectors, or JavaScript.

| Tool | Arguments | Result |
|---|---|---|
| `window_list` | none | Window IDs (strings) and titles |
| `window_observe` | `windowId, filter?, limit?` | DOM followed by OCR targets; native apps use OCR |
| `browser_page_find` | `windowId, filter, fields?, scope?, offset?, limit?` | Paginated DOM targets, including offscreen results |
| `browser_screenshot` | `windowId, scope?` | Image ID, coverage, truncation |
| `image_crop` | `observationId, target, context?` | Server-selected target crop image ID |
| `describe_image` | `image, prompt` | Liquid text, configured model alias, elapsed milliseconds, truncation |
| `decide` | `question, image?, system_prompt?` | H2O typed answer, configured model alias, elapsed milliseconds |
| `window_click` | `observationId, target, button?, count?` | Native single/double click and fresh observation |
| `window_type` | `observationId, target, text, mode?` | Focus-verified DOM typing and fresh observation |
| `window_scroll` | `windowId, target?, within?, direction?, amount?` | DOM reveal or native wheel input, then observation |
| `window_key` | `windowId, keys, focusTarget?` | Ordered key chords and fresh observation |

`target` is **either** `{id: 3}` **or** `{label: "Search"}`. Labels must be exact
and unique within the observation. Scroll `target`/`within` and key `focusTarget`
are full `{observationId, target}` references belonging to the specified window.
`image` is either `{imageId}` or `{observationId, target}` for an automatic crop.
Observation/capture/crop results include MCP image content. Text-only clients can
strip image blocks and use the target list or the description/decision tools.
Image paths and geometry stay internal.

```js
window_list({})
window_observe({windowId: "16777220", filter: "Search"})
window_type({observationId: "returned-id", target: {id: 3}, text: "pretzels"})
// Use the new observation after every action.
window_key({windowId: "16777220", keys: ["Enter"]})
browser_page_find({windowId: "16777220", filter: "pretzel",
  fields: ["alt", "accessible_name"], scope: "loaded_document", limit: 20})
window_click({observationId: "search-result-id", target: {id: 12}})
```

Defaults: observation limit 50 (max 300), page search viewport scope, screenshot
viewport scope, single left click, typing replacement, tight crop, small downward
scroll. `mode: "append"` inserts at the caret after focusing the target.
`keys` is an ordered array, such as `["Ctrl+l", "Escape"]`.
`amount: "page"` sends ten wheel ticks, not an exact viewport distance.

Decision questions are `{type:"boolean",prompt}`, `{type:"choice",prompt,
options:[{id,label},...]}`, or `{type:"score",prompt,levels:[...]}`. Descriptions
and probabilities can be wrong and never generate actionable targets.
Model names in results identify the configured provider alias, not a verified
weight-file identity. Timing includes the wrapper/provider round trip.

## Target validation and limits

Observations expire after 120 seconds from capture and after a new observation or
action on that window. IDs are scoped to an observation. Requests execute in
received order across all windows. Search pagination uses `nextOffset`, which
counts matching elements skipped; each page has a new observation ID. The loaded
DOM can change between pages, so pagination is not a frozen document snapshot.

DOM targets are bound to a browser tab, document, element reference and identifying
attributes. Hidden elements are excluded. Offscreen DOM targets scroll into view
before clicks; the server checks current geometry, enabled state, layout stability
and hit testing, including after cursor travel. Covered targets have no click/type
actions. Use the updated mcp-zen active-tab API for this adapter.

Typing verifies that the intended editable DOM element owns focus before sending
text. OCR alone cannot prove field focus: OCR typing and OCR `focusTarget` are
rejected. Native applications retain OCR clicks, wheel input and key chords.
OCR clicks compare the target's captured pixels immediately before input; OCR
labels are not guaranteed controls. Browser DOM mapping uses mcp-zen’s actual current tab, verifies its title against
the X11 window, and checks geometry. Duplicate titles in background tabs are fine. Unsupported pages,
CSP restrictions, shadow roots and embedded frames can limit DOM discovery;
`window_observe` reports the failure and tries OCR.

DOM discovery is bounded to 10,000 candidate elements in the top-level document.
Names/roles are approximations from DOM attributes, not a complete accessibility
tree. Full-page captures cover loaded content, not unloaded/virtualized products.
Captures exceeding 20 megapixels or 10 MiB are rejected; they are not silently
truncated. Cropping an offscreen target never implicitly scrolls: reveal explicitly,
then use its new observation. Image IDs expire after an hour or cache eviction.

`input_sent` reports delivery, not application success. `focus_verified` proves only
the checked focus state. Inspect the returned observation for the intended result.
Errors after scrolling/partial input say so; never replay blindly. Stale-target
rejections attempt to return a fresh observation. A page can still change between
the final check and native input; these checks are not an atomic browser transaction.

## Checks

```sh
node --test test/*.test.mjs
cargo test --manifest-path overlay/Cargo.toml
cargo clippy --manifest-path overlay/Cargo.toml -- -D warnings
```

[SKILL.md](SKILL.md) describes the agent workflow. The interface design and earlier
vision experiments remain in [docs/VISION_PLAN2.md](docs/VISION_PLAN2.md).
