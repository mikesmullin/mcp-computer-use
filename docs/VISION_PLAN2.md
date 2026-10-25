# Vision and target selection plan (WIP)

Updated: 2026-10-25. This is a design proposal and experiment record, not an
implemented API or a decision to deploy every provider. It develops the direction
in [FURTHER_IMPROVEMENT_PLAN.md](FURTHER_IMPROVEMENT_PLAN.md) using the newer OCR
work and the experiments below. Provider selection, defaults, and rollout remain
open for the user to decide.

## Objective

Give Bonzai and other agents a toolbox for inspecting the existing desktop and
verifying targets without requiring them to calculate click coordinates. Models
choose a server-issued target ID or an exact unique label; the MCP service resolves
and validates the target, then performs native input deterministically.

The tools complement each other: DOM metadata, OCR, image descriptions, and typed
visual decisions offer different evidence. Exposing alternatives lets an agent
try another approach when one is inconclusive. None of the vision experiments
establishes a universally reliable detector.

Preserve the existing Zen session, ordered actions, and independent XInput2 agent
pointer. The desired behavior is native X11 input, like the user's preferred
xdotool click, but ordinary pointer-warping xdotool must not replace the current
independent-pointer implementation. Do not move or resize windows to make targeting
easier. Inference lifecycle remains operator-managed.

## Proposed toolbox

| Provider | Useful for | Limits / deployment decision |
|---|---|---|
| Existing PaddleOCR PP-OCRv6 medium detector + recognizer | Visible text, text bounds, OCR target IDs; desktop apps and browser chrome | Text extraction, not arbitrary image Q&A. OCR scores do not prove target identity or clickability. |
| mcp-zen DOM bridge | Accessible names, roles, text, alt text, stable element references, page search, element bounds, browser screenshots | Existing code is an integration starting point, not a validated end-to-end targeting service. Avoid dumping HTML into the agent context. |
| Liquid LFM2.5-VL-450M on CPU | Prompted descriptions and visual checks, especially small target crops | Meets the sub-three-second goal on this fixture, but invents details on full screenshots. Prefer a persistent service to repeated model loading. |
| H2O Lightning 4B | Fast typed decisions: yes/no probability, choice among supplied options, ordered scores; optionally image input | Vision is working locally, but recognition remains inconsistent. GPU footprint competes with Bonzai, OCR, and other services. |

H2O vision is **currently enabled** in `~/.config/inference/config.yaml` for the
`:1237` service, with `mmproj-lightning-f16.gguf` and a 1024-image-token budget.
Whether to keep vision enabled or return H2O to text-only is explicitly undecided.
Text-only H2O could still score text/DOM candidate descriptions; it cannot inspect
an image without the projector. Tools should report unavailable capabilities
clearly rather than silently switching models or loading GPU weights.

The old `/workspace/cli/describe` code offers useful integration examples, but its
SAM path produces segmentation summaries and its YOLO path lists classes; neither
implements general prompted visual Q&A. Its Grok path is a cloud service. The
`/workspace/vlm` InternVL3-8B tool does implement image Q&A, but its BF16 footprint
and per-invocation loading are unsuitable as the default alongside current models.
The proposed default experiments remain local.

## Experiments: frozen Amazon pretzel screenshot

All tests used the same real Amazon screenshot captured on 2026-10-25. Ground
truth: two Snyder's pretzel bags. Four fixtures: native 1595×1027 screenshot,
1280×824 resize, 293×187 crop containing both bags, and 286×187 negative crop
containing an AMD box and a hairbrush. Crops were manually selected: recognizing
a crop does **not** demonstrate autonomous target localization.

Local scripts, hashes, raw responses, and detailed reports are in the gitignored
[`tmp/liquid-pretzel/`](../tmp/liquid-pretzel/) and
[`tmp/h2o-pretzel/`](../tmp/h2o-pretzel/) directories. Those links are local artifacts
and may not exist in another checkout. Keep private screenshots and transcripts
out of committed documentation.

### Liquid results

Official LFM2.5-VL-450M and 1.6B, Q8_0 language weights plus F16 projector, CPU-only
on a Threadripper 7970X with 16 threads. llama.cpp build `6245df8`, context 4096,
image-max-tokens 256 (tiled full-image prompts still used about 1800 tokens).
Prompt caching disabled; greedy decoding. Three measured repetitions per fixture
and prompt, excluding one warmup. Medians below are request wall time.

| Model / image | Presence answer and time | Count/brand answer and time |
|---|---|---|
| 450M / native | Yes, but invents section association; 2.275 s | One Snickers bag, incorrect; 2.102 s |
| 450M / 1280px | Yes, but invents a Pretzels section/cart context; 2.226 s | One Snickers bag, incorrect; 2.068 s |
| 450M / positive crop | Yes, recognizes Snyder's labels; 0.395 s; response hits 64-token limit | Two, correctly identifies the two products; 0.291 s |
| 450M / negative crop | No; 0.324 s; misidentifies another item | Zero, correct; 0.300 s; misidentifies another item |
| 1.6B / native | No, incorrect; 7.327 s | Two, but invents Lay's as a brand; 6.954 s |
| 1.6B / 1280px | No, incorrect; 7.327 s | Two, but invents Lay's/Ritz brands; 6.933 s |
| 1.6B / positive crop | Contradictory No while naming pretzels; 1.038 s | Two, but confuses Sourdough with a brand; 0.673 s |
| 1.6B / negative crop | No, correct; 0.664 s | Invents three Lay's pretzel bags; 0.628 s |

Peak process RSS was approximately 1.2 GiB for 450M and 2.8 GiB for 1.6B.
Increasing to 1.6B did not improve reliability on this fixture. Keep 450M as the
CPU candidate for optional descriptions, especially crops; do not promote either
model to a trusted whole-screen detector based on these results.

### H2O Lightning 4B results

The original `:1237` instance was text-only because no vision projector was loaded.
Downloaded the official 672,423,360-byte F16 projector, verified SHA-256, updated
the launcher, and the user relaunched it. The service then reported vision enabled.
Tests used the existing Q8_0 model on GPU, build `6245df8`, context 8192, one slot,
four CPU threads, and 1024 image tokens. Requests used `/v1/systemone`.

Presence was a `noul` yes/no probability. Counting was a choice among zero, one,
two, three-or-more, and uncertain. Separate requests per question, one excluded
native warmup per question, then three interleaved repetitions with identical
answers. Medians:

| Image | P(pretzels present) | Selected count (option probability) | Presence / count latency |
|---|---:|---|---|
| Native | 51.5% | Zero (32.9%), incorrect | 194 / 205 ms |
| 1280px | 73.6% | One (48.1%), incorrect | 176 / 184 ms |
| Positive crop | 48.4% | Two (90.8%), correct | 34 / 37 ms |
| Negative crop | 3.4% | Zero (93.1%), correct | 32 / 34 ms |

An exploratory follow-up used explicit Yes/No/Uncertain choices. It selected No
on native (45.4%), Yes on resized (59.8%), Yes on the positive crop (47.3%), and No
on the negative crop (95.9%). Thus question format changes the positive-crop
answer; count success does not establish consistent object recognition.

Whole-GPU memory was 29,631 MiB used / 2,569 MiB free before requests and
29,791 / 2,409 afterward on the 32,607 MiB card. These totals include other running
services, not just H2O. Vision's real runtime cost includes buffers as well as its
roughly 0.63 GiB projector. Whether this is worth keeping resident is the user's
pending trade-off.

H2O is promising for fast candidate scoring, but typed output prevents invented
prose, not incorrect decisions. These probabilities are model scores, not measured
real-world accuracy or validated calibration on desktop images.

### Comparison limits

This was one screenshot with derived crops, not a benchmark of varied websites.
Repeated deterministic answers measure timing/repeatability, not general accuracy
or a hallucination rate. Liquid ran on CPU without prompt caching; H2O ran on GPU
with the live server's cache configuration retained. Timing includes image file
reading, encoding, HTTP and response parsing, but excludes capture and startup.
These are not controlled CPU-versus-GPU or architecture efficiency comparisons.

## Proposed MCP function signatures

These TypeScript-style signatures describe **new or revised contracts**, not
functions already available. Implement MCP object schemas with explicit required
fields and exclusive alternatives. No public input below accepts x/y coordinates,
rectangles, CSS selectors, or arbitrary JavaScript. Bounds remain provider-internal.

```ts
type TargetSelector = { id: number } | { label: string };
type TargetRef = { observationId: string; target: TargetSelector };
type ImageRef =
  | { imageId: string }
  | { observationId: string; target: TargetSelector }; // server crops target

type Target = {
  id: number;                     // scoped to this observation
  label: string;                  // human-readable; duplicates allowed
  role?: string;
  source: "dom" | "ocr";
  visibility: "onscreen" | "offscreen";
  enabled: boolean;
  actions: ("click" | "type" | "scroll")[];
};
type Observation = {
  observationId: string;
  imageId?: string;               // screenshot also returned as MCP image content
  targets: Target[];
  nextOffset?: number;        // offset of the next results page (results skipped so far); absent on the last page
};
type ActionResult = {
  status: "input_sent" | "rejected";
  reason?: string;
  verification: "not_checked" | "focus_verified" | "postcondition_verified";
  observation?: Observation;      // fresh observation after action
};

// List all windows that can be observed on this display.
// Returns windowId and title; window_observe takes a windowId
// to produce the target list for that window.
window_list(): { windowId: string; title: string }[];

// Create a bounded observation of a window. Discovery is automatic and
// contextual: browser windows get DOM targets concatenated with OCR
// targets; native desktop windows get OCR targets only. Optionally narrow the returned list with filter.
// Returns an observationId-scoped target list, each with id, label,
// source, visibility, enabled state, and supported actions.
window_observe(args: {
  windowId: string;              // window to observe; get from window_list()
  filter?: string;                // case-insensitive keyword match on extracted
                                 // text (OCR + DOM label fields); not a VLM —
                                 // use browser_page_find / describe_image / decide
  limit?: number;                // maximum number of targets to return
}): Observation;

// Match a text filter against a browser window's DOM across selectable
// fields (text, accessible name, alt text, title). Scope limits the match
// to the current viewport or the full loaded document. Returns matching
// targets as a bounded, paginated observation.
browser_page_find(args: {
  windowId: string;               // window to search; get from window_list()
  filter: string;                // text to match against the selected fields
  fields?: ("text" | "accessible_name" | "alt" | "title")[]; // DOM fields to match (all when omitted)
  scope?: "viewport" | "loaded_document"; // search range; defaults to viewport
  offset?: number;           // number of results to skip (from an earlier result's nextOffset)
  limit?: number;                // maximum number of matches to return
}): Observation;

// Capture a browser window as an image for vision tools. The capture
// defaults to the current viewport; "full_page" captures the entire
// loaded document. Returns an imageId usable with describe_image and
// decide, plus coverage and truncation reporting.
browser_screenshot(args: {
  windowId: string;
  scope?: "viewport" | "full_page";  // default: viewport
}): { imageId: string; coverage: string; truncated: boolean };

// Produce a bounded crop of a single target from an observation. The server
// selects the crop bounds (tight around the target, or surrounding context) —
// the model never computes or supplies coordinates.
image_crop(args: {
  observationId: string;
  target: TargetSelector;
  context?: "tight" | "surrounding";
}): { imageId: string };          // server-selected bounds, no model arithmetic

// Run a prompted visual Q&A against an image (or an observation target that
// the server crops first). Returns free-text description plus provenance:
// which model answered, timing, and whether the output was truncated.
describe_image(args: {
  image: ImageRef;
  prompt: string;
}): { text: string; model: string; elapsedMs: number; truncated: boolean };

type DecisionQuestion =
  | { type: "boolean"; prompt: string }
  | { type: "choice"; prompt: string; options: { id: string; label: string }[] }
  | { type: "score"; prompt: string; levels: string[] };
type DecisionAnswer =
  | { type: "boolean"; probabilityTrue: number }
  | { type: "choice"; selectedId: string; probabilities: Record<string, number> }
  | { type: "score"; expectedLevelIndex: number; probabilities: number[] };

// Ask a typed visual decision (yes/no, choice among options, or ordered
// score). Optional image and/or per-decision system prompt; omitting the
// image allows text-only scoring. Returns a structured DecisionAnswer with
// provenance.
decide(args: {
  system_prompt?: string;         // instructions shaping how the question is
                                   // answered; separate from the structured question
  image?: ImageRef;               // image absent permits text-only H2O
  question: DecisionQuestion;
}): { answer: DecisionAnswer; model: string; elapsedMs: number };

// Click a target from an observation. The server revalidates the target,
// converts it to current screen coordinates, and delivers a single or double
// native click via the independent pointer.
window_click(args: TargetRef & {
  button?: "left" | "right" | "middle";
  count?: 1 | 2;
}): ActionResult;

// Type text into a target from an observation. The server ensures the target
// owns focus before sending keystrokes. Mode "replace" selects and clears
// existing text first; "append" inserts after the current cursor.
window_type(args: TargetRef & {
  text: string;
  mode?: "replace" | "append";
}): ActionResult;                 // focus target, verify focus, then type

// Scroll a window. When the window is a browser and a target is supplied,
// the server uses the mcp-zen DOM bridge to scroll that element into view
// (scrollTo/scrollIntoView, including nested scroll containers) for precise
// targeting, so direction and amount are irrelevant for that path. Otherwise,
// the server scrolls by direction and amount via native input; with neither a
// target nor a direction supplied, it defaults to a small downward scroll.
// Returns the result of the input delivery so the caller can re-observe.
window_scroll(args: {
  windowId: string;
  target?: TargetRef;             // bring this target into view (browser mcp-zen path)
  within?: TargetRef;             // optional scrollable container
  direction?: "up" | "down" | "left" | "right";
  amount?: "small" | "page";
}): ActionResult;

// Send a sequence of keys to a window, optionally after focusing a target.
// Useful for keyboard shortcuts and menu navigation that have no useful
// DOM label or role to target.
window_key(args: {
  windowId: string;
  keys: string[];
  focusTarget?: TargetRef;
}): ActionResult;
```

The public `boolean` decision maps internally to H2O's `noul`. Image descriptions
return text with provenance rather than an unannotated string. Decisions and
descriptions are evidence only: neither creates actionable coordinates or clicks.
An offscreen `ImageRef` target cannot be cropped from an old viewport screenshot;
return `target_offscreen` or require an explicit browser capture. Do not introduce
implicit scrolling in a nominally read-only description call.

Keep keyboard shortcuts as an escape hatch for menus, navigation, and controls
without a useful label. `focusTarget` and a supplied scroll container must belong
to the specified window. Typing should require a target rather than assuming that
window activation establishes field focus. Do not claim application success merely
because the native input call succeeded.

Exact tool count and names are provisional. A later implementation may consolidate
click/type/scroll into a discriminated `window_interact` schema, but must remove
coordinate alternatives from the agent-facing schema. Existing coordinate tools
should not remain visible alongside the replacement and tempt Bonzai to guess.

## Target identity and execution

- IDs are integers scoped to an observation; never reuse them as global identities.
  The server privately stores the DOM reference or OCR evidence, geometry, window,
  document identity, generation, expiry, and provenance.
- Label selection uses an exact unique match in that observation. If two targets
  have the same label, return an ambiguity result with IDs; never fuzzy-click the
  first match. Bounded results should include enough role/context to distinguish
  repeated product names. Pagination must not silently renumber targets.
- DOM and OCR observations may overlap. Deduplicate only when the service can
  establish the same target; otherwise preserve distinct IDs and provenance.
- Revalidate immediately before native input. A stable DOM identity may survive
  scrolling; screenshot/OCR geometry must be refreshed after changes. An expired
  or unresolvable reference returns a fresh observation instead of a guessed click.
- Serialize observe/action transitions per window, and invalidate obsolete
  observations after mutations. Never interpret a model-supplied ID as an offset.

### Offscreen versus hidden

A DOM target below the fold can be listed as `offscreen`. When the agent chooses
it for click/type, the service performs the entire sequence:

1. Resolve the same element in the same document and confirm it remains actionable.
2. Scroll it into view internally (for example `scrollIntoView`, including nested
   scrolling containers), wait for layout to settle, then obtain fresh bounds.
3. Recheck rendering, enabled state, viewport intersection, and hit testing; if
   covered by a sticky header or overlay, adjust only within a bounded policy or
   return a blocked result.
4. Convert fresh browser bounds to current native screen coordinates and deliver
   the native click through the independent pointer.
5. For typing, verify the intended input actually owns focus before sending text.
   Capture fresh state and report delivery separately from any verified outcome.

Do not calculate an offscreen screen coordinate once and use it after scrolling.
Do not require Bonzai to issue a separate reveal or perform coordinate conversion.
Exclude `display:none`, `visibility:hidden`, and otherwise non-rendered targets
from ordinary listings; do not force hidden content visible. Occluded/disabled
controls must not be presented as immediately clickable.

Page-wide search covers the currently loaded DOM, including laid-out content below
the fold, not every product the website could ever load. Virtualized or lazy-loaded
content may require scrolling and fresh discovery. Full-page captures need bounded
size and explicit coverage/truncation reporting.

## mcp-zen integration work

Reuse `/workspace/mcp-zen` where practical. Its page runtime already has accessible
names, roles, stable references, visibility/hit-testing helpers, and layout bounds.
Its extension capture path is a starting point for viewport/full-page screenshots.
Validate the actual browser-to-screen transform under zoom, device scaling, sidebar
and browser chrome offsets, multiple monitors, nested frames, and scrolling before
trusting native clicks. Alt text may identify a product faster than image inference,
but it is page-provided evidence, not proof of what the pixels depict.

Fix extension persistence as part of making this usable: the installed Zen build
was inspected and reports `MOZ_REQUIRE_SIGNING: false`. A candidate local-only setup
is a stable Gecko extension ID, packaged XPI, signature preference configured for
this build, and installation through about:addons instead of temporary debugging
installation. This has not yet been validated across restart. An unlisted Mozilla-
signed extension is an alternative. Neither packaging route is implemented here.

## Suggested implementation sequence and open decisions

1. Agree the target/action contract; implement ID/unique-label selection and remove
   public coordinate requirements while preserving the existing pointer behavior.
2. Adapt mcp-zen into bounded target lists and page search. Validate automatic
   scroll, current bounds, hit testing, native input, and focus on controlled pages.
3. Keep OCR as a fallback for desktop apps, browser chrome, and missing DOM targets.
4. Add target crops and optional Liquid CPU descriptions. Expose provider failures,
   truncation, and provenance without turning prose into actionable geometry.
5. Add optional H2O typed decisions, with image capability conditional on the
   operator's launcher choice. Evaluate candidate crops before using scores to
   influence actions; do not infer a safe threshold from this tiny experiment.
6. Test the full workflow with Bonzai on varied positive and negative examples,
   duplicate labels, icon-only controls, stale views, moving content, occlusion,
   offscreen targets, nested scrolling, and focus-sensitive fields. Measure task
   completion, wrong clicks, false success claims, latency, and memory.

Pending user choices: H2O vision residency versus text-only; which providers are
available by default; whether to expose all proposed tools or a smaller combined
surface; Liquid service lifecycle; mcp-zen packaging; and how to handle weak or
conflicting evidence. No automatic model switching or GPU service restarts are
part of this proposal.
