# Shared MCP vision tools (WIP)

Updated: 2026-10-25. The design below is preserved as the agreed implementation
plan; see the status section for completed changes and remaining rollout checks.

## Implementation status (2026-10-25)

Implemented in `/workspace/mcp-vision/` with the three path-based tools below.
See `/workspace/mcp-vision/README.md` for deployment and validation. Pi global
registration, text-only desktop/browser capture defaults, OCR ownership migration,
and reversible launcher edits are in place. Live OCR, Liquid CPU, H2O image/text,
and capture-to-OCR checks passed. Pi discovery reports all three vision tools.

Running inference services were not restarted. The selected reasoning preset must
be relaunched to release its vision allocation; Liquid's independent CPU profile
must be started by the operator. Fresh Pi sessions load the new modality metadata
and image-filtering extension. Post-relaunch VRAM and full Bonzai task performance
remain to be measured. The broader DOM target/action redesign remains future work.

## Direction

Create `/workspace/mcp-vision/` as a shared local vision toolbox, available through
Pi's global MCP configuration. General reasoning models can then run text-only and
call specialized OCR, image description, and decision tools when visual evidence is
needed. Keep model selection explicit and retain the option of running H2O without
vision if its GPU cost is not worthwhile.

This separates responsibilities:

- **mcp-vision:** OCR, Liquid CPU image descriptions, optional H2O image decisions,
  bounded textual evidence.
- **mcp-computer-use:** desktop capture, observation/target identity, native input,
  stale-state checks, focus verification, and automatic scroll-before-click.
- **mcp-zen:** browser DOM discovery, names/alt text, loaded-document search,
  browser capture, element references, and browser-to-screen geometry.
- **Pi's reasoning model:** chooses tools and target IDs/labels, interprets evidence,
  and plans actions. It does not need image input or calculate click coordinates.

Moving vision out of every reasoning model does not make visual perception
infallible. Keep the experiment caveats and deterministic action design in
[VISION_PLAN.md](VISION_PLAN.md). This document refines the ownership and deployment
of those proposed tools; it is not a second implementation of computer control.

## Verified local configuration

Inspected `~/.config/mari/activity/ai.yml`, `~/.config/inference/config.yaml`,
`/workspace/tmp/strata/strata-iq3_xxs.json`, and `~/.pi/agent/mcp.json`.

| Mari key | Actual preset | Current vision configuration | Proposed change |
|---|---|---|---|
| `b` | `ternary-bonsai-2-ninfer` | `--vision` in inference YAML; NInfer artifact | Remove that preset's `--vision`, then verify text-only loading |
| `n` | `qwen3.6-35b-a3b-ninfer` | `--vision` in inference YAML; NInfer artifact | Remove that preset's `--vision`, then verify text-only loading |
| `s` | `qwen3.8-flash-next-strata-iq3xxs` | Referenced Strata JSON contains engine `--vision` and a `vision` encoder block with `gpu: false`, 300 tokens, 32 threads | Remove the engine vision flag and disable/remove the encoder block using the wrapper's supported contract |
| `o` | `paddleocr` | Independent OCR service on `:1239` | Reuse service; migrate code paths to mcp-vision later |
| `h` | `h2o-lightning-4b` | Independent System One service on `:1237`, currently with F16 projector | Reuse; keeping vision resident remains undecided |

Flash Next's encoder is **already CPU-based**. Turning it off primarily saves
CPU/RAM and simplifies the text-only contract; do not promise a large VRAM saving.
Its generated JSON and launcher comments must remain consistent, and future Strata
setup runs must not silently restore vision. Preserve its unrelated tuning.

Both NInfer profiles use `--kv-capacity auto`; Strata uses `--expert-cache auto`.
Memory released by removing vision may be consumed by larger automatic caches.
Measure actual free VRAM after launch and under load; if shared services need a
reserve, configure an explicit supported cache budget/reserve after measurement.
Removing a vision flag alone does not guarantee headroom for OCR and H2O.

Scope is exactly the three requested reasoning presets. Leave other presets,
frozen tuning variants, sampling, context lengths, and speculative decoding alone.
Keep model artifacts on disk; disabling a vision component does not require
repacking or deleting weights. Validate backend behavior before assuming it skips
all vision allocations.

## Provider deployment

The MCP server should be a lightweight adapter, not a second copy of each model.
Pi may start one stdio MCP process per session. Those processes must connect to
shared inference services rather than each loading OCR, Liquid, and H2O.

| Backend | Initial endpoint / execution | Responsibility |
|---|---|---|
| OCR | Existing HTTP service `127.0.0.1:1239` | Text and bounding regions |
| Liquid 450M | Proposed persistent CPU-only local service; port to be allocated | Prompted text descriptions; Q8_0 language + F16 projector |
| H2O 4B | Existing `127.0.0.1:1237/v1/systemone` | Typed decisions, with image input only when projector loaded |

Operator-managed services stay under the inference launcher/Mari. MCP discovery
must not launch or restart models, unload other services, or download weights.
Initially reuse OCR at its existing paths; once the replacement is validated,
move its engine/service source and dependencies from mcp-computer-use to mcp-vision
and update the launcher. Leave a thin client in computer-use, not a duplicate OCR
runtime. Similarly, retain H2O's decision endpoint for existing consumers such as
mail1. Liquid's experiment scripts are a prototype, not a production service.

Use explicit provider selection, timeouts, bounded queues, cancellation where the
backend supports it, and bounded output. Report unavailable backends and disabled
image input rather than silently substituting a different model. A missing H2O
vision projector should not disable its text-only decision tool.

The earlier experiments support keeping Liquid 450M as the CPU option and H2O as
an optional fast decision backend, not replacing all vision with either model.
450M took about 2.2 seconds for full-image presence and 0.4 seconds for the positive
crop; it fabricated full-screen details. H2O took roughly 30–205 ms on GPU but
miscounted the full screenshot and gave inconsistent presence scores. The tested
1.6B Liquid was slower and less reliable. See VISION_PLAN.md for full methods,
negative controls, memory observations, and comparison limitations.

## Image exchange and text-only operation

Images reach the vision server as **absolute local file paths**. No import step,
opaque handles, or cross-session registry contract is required for the public API:
the server opens the given file, validates it, and runs the requested operation.
mcp-computer-use and mcp-zen writes captures directly to local files and passes
the file path to the vision functions, so byte buffers never pass through the
reasoning model's context as base64 or image blocks.

The default MCP response contains structured text, paths, region IDs, and model
answers, **not an image content block**. Update computer-use observation and
post-action responses accordingly; making the vision service text-only is
insufficient if every click still automatically inserts a screenshot into Pi's
model request. Preserve image viewing as an explicit capability for human debugging
or image-capable clients.

Inspect the actual Pi model/provider metadata and image handling before rollout.
Advertise text-only input consistently there and ensure stored image messages or
attachments cannot silently make the next inference request invalid. Global MCP
registration makes tools available; it does not itself teach a text-only model how
to process image content blocks.

## Proposed MCP function signatures

TypeScript-style contract sketches below become MCP JSON object schemas. They are
not implemented functions. Public tool names use an `image_` prefix for clear
discovery alongside other MCP servers. Public tools accept absolute local file
paths and meaningful text, never x/y coordinates. Backend geometry is available
only to trusted service clients for target mapping.

```ts
// Provider, model, and timing are server-internal; public results return only
// agent-facing content.
image_ocr(args: {
  path: string;                    // absolute local file path; no URL fetch
  query?: string;                  // filters recognized text, not a VLM prompt
  limit?: number;
  cursor?: string;
): {
  regions: {
    regionId: string;              // stable within this stored image/result
    x: number;                     // left edge, image-local pixel coordinate
    y: number;                     // top edge, image-local pixel coordinate
    w?: number;                    // width, if the backend provides it
    h?: number;                    // height, if the backend provides it
    text: string;
    recognitionScore: number;
    readingOrder: number;
  }[];
  nextCursor?: string;
};

image_describe(args: {
  path: string;                    // absolute local file path
  prompt: string;
): {
  text: string;
};

type DecisionQuestion =
  | { type: "boolean"; prompt: string }
  | {
      type: "choice";
      prompt: string;
      options: { id: string; label: string }[];
    }
  | { type: "score"; prompt: string; levels: string[] };
type DecisionAnswer =
  | { type: "boolean"; probabilityTrue: number }
  | {
      type: "choice";
      selectedId: string;
      probabilities: Record<string, number>;
    }
  | {
      type: "score";
      expectedLevelIndex: number;
      probabilities: number[];
    };

image_decide(args: {
  path?: string;                   // absolute local file path; omitted allows text-only H2O
  context?: string;                // image path or nonempty context required
  question: DecisionQuestion;
}): {
  answer: DecisionAnswer;
};
```

`image_ocr` recognition scores and H2O probabilities are different quantities;
do not put them into one generic confidence field. Map the public boolean type
to H2O `noul`, and preserve raw model probabilities. Validate unique option IDs,
region/image ownership, score-level order, and bounded lists. There is no universal
acceptance threshold established by the pretzel experiment.

All image operations can return explicit errors such as `path_not_found`,
`invalid_image`, `region_not_found`, `provider_unavailable`,
`image_input_disabled`, or `timeout`. An error is not an empty OCR result or a
negative visual answer. H2O does not provide arbitrary descriptive prose through
this decision API; use Liquid for that operation. Optional future providers should
extend capabilities explicitly.

## Proposed Pi registration

Merge a new sibling entry into `~/.pi/agent/mcp.json` under `mcpServers`, preserving
all existing entries. This follows the current config shape; the entrypoint is a
proposed future file, not something to register before it exists:

```json
{
  "vision": {
    "description": "Local vision tools: OCR, Liquid CPU image descriptions, and optional H2O visual or text decisions. Accept absolute local image paths; return text and IDs. No desktop input.",
    "command": "/home/user/.bun/bin/bun",
    "args": ["/workspace/mcp-vision/server.mjs"],
    "cwd": "/workspace/mcp-vision",
    "timeout": 180,
    "exposure": "direct"
  }
}
```

Keep provider endpoints in the new project's configuration; no credentials or
image bytes in the MCP entry. Verify the Pi MCP adapter's reload behavior and
discovery with a real session rather than assuming a running session hot-reloads
the file. Update its current computer-use description, which still advertises
coordinate inputs and move/resize, when that tool contract is migrated.

## Rollout and checks

1. Build the lightweight mcp-vision adapter in the separate project. Reuse existing
   backends, preserve experiment scripts, and test OCR, Liquid, H2O text-only, H2O
   vision, missing providers, and invalid/missing file paths independently.
2. Wire captures and crops to absolute local file paths; add text-only tool
   responses. Validate that image bytes reach the vision provider but never the
   reasoning model's text-only completion request. Check across concurrent Pi
   sessions without duplicating loaded models.
3. Register vision globally in Pi and verify tools actually appear. Start with
   explicit provider choices and short tool descriptions; avoid a large schema or
   long OCR dump consuming the context the split is intended to save.
4. Prepare reversible edits to the three exact inference presets and relevant Pi
   modality metadata. For Strata, inspect both wrapper and generated-config handling
   before changing it. Ask the user to relaunch the chosen preset after edits,
   following the operator-managed workflow used for H2O.
5. Measure before/after idle and peak VRAM/RAM, concurrent OCR/H2O demand, and text
   inference performance for each preset. Tune memory reserves if automatic cache
   allocation absorbs the savings. Flash Next's large RAM footprint may constrain
   browser plus Liquid coexistence even when VRAM is sufficient.
6. Exercise the full Bonzai workflow: observe, select crop, ask a vision question,
   choose target ID, scroll/revalidate/click, and verify the result. Include
   negative controls, duplicates, hidden elements, stale captures, and
   focus-dependent typing.
7. Once validated, migrate OCR ownership/launcher paths and retire duplicate code
   and outdated tool descriptions. Keep a rollback record of launcher and Pi config
   changes; do not remove the original working paths before replacement validation.

Open decisions: H2O vision on versus text-only; permanent versus manually started
Liquid CPU service;
and how much memory to reserve for shared vision.
The intended outcome is one reusable perception toolbox available to every
reasoning model, not one mandatory model that must answer every visual question.
