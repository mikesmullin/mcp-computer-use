# Local GUI grounding research (2026)

Research notes on empowering small models to make accurate click judgments from
screenshots. Local-only solutions only (no hosted/paid services). Collected
while evaluating the "smarter model does screenshot image classification:
input=screenshot, output=list of words/phrases + coordinates/bounds the agent
chooses from" approach.

## Core finding

State of the art does **not** have the model regressing pixel coordinates from a
raw screenshot. It **builds a candidate list** — `{id, text, role, bbox,
center}` — from OCR (and ideally the accessibility tree), **paints nuVmbered
marks** over the screenshot, and asks the model to **pick a mark id**. The id
is looked up back to real click coordinates. This converts "guess a point"
(hard for small models) into "pick from a short list" (which small models are
very good at). The desired "screenshot → list of words/phrases + bounds the
agent can choose from" output is exactly the OCR candidate-list part of this
pipeline.

The system splits into two local model jobs: **OCR-with-boxes** and **selection**.
They need different models.

## 1) OCR + bounding boxes (text + rect)

All local, all free.

| Model | License | Box format | CPU speed | Notes |
|---|---|---|---|---|
| **PaddleOCR PP-OCRv5/v6** | Apache 2.0 | 4-point polygons `[[x1,y1]…[x4,y4]]`, JSON | Good | Best all-rounder. Skew/rotation handled, 100+ languages, small CPU variants. Recommended default. |
| **Tesseract 5.5.x** | Apache 2.0 | Word `left/top/w/h` (TSV/hOCR/ALTO) | Fastest, lightest | Axis-aligned only; needs clean text. Best pure-CPU baseline. |
| **EasyOCR** | Apache 2.0 | 4-point bbox + text + confidence | Slower (PyTorch-CPU) | Easiest per-line API; good on scene text; no tables/layout. |
| **dots.ocr (1.5–1.7B)**, **GLM-OCR 0.9B**, **MinerU 2.5 (1.2B)**, **PaddleOCR-VL (0.9B)** | Apache 2.0 | Boxes | GPU-oriented; CPU possible but slow | Top doc-parsing accuracy (OmniDocBench 95–96%); single unified model. Pick when you need reasoning over the page, not speed. |
| **Indra (~1M params, 2026)** | unverified | full layout + line boxes | Claimed 49 pages/s CPU, 11× PaddleOCR | Promising, but the speed claim is **unverified** — reproduce on your hardware before relying on it. |
| **TrOCR** | MIT | None alone (line crops) | GPU helpful | Handwriting line recognizer; only a second stage behind a detector. |

**For the "words + boxes the agent can pick from" output:** **PaddleOCR** is
the strongest local default (JSON with rotated boxes + confidence + layout).
**Tesseract** if you want the lightest CPU baseline and can tolerate axis-aligned
boxes. **EasyOCR** for the simplest prototype API.

## 2) Grounding / pointer (the model that picks)

**Dedicated pointing models:**

| Model | Size | Local/fast? | Accuracy |
|---|---|---|---|
| **BrowserVLM** | ~0.54B | ✅ Best local+fast — built to run *beside* an agent | 79.1 ScreenSpot-V2; beats a 7B specialist on the high-res split at ~1/13 size |
| **UI-TARS-1.5-7B** | ~7B | Local on a workstation GPU, slower | ~52–55% ScreenSpot-Pro raw; Apache 2.0; outputs absolute pixel coords |
| **MolmoPoint-GUI-8B** | ~8B | Strong GPU, not tiny | ~61% ScreenSpot-Pro, 70% OSWorld-G (SOTA among open weights at publication) |

**Training-free boosts** (work on *any* local VLM, including tiny ones):

- **Mark-Grid / Auxiliary Reasoning** — overlay a labeled grid, model predicts a
  discrete grid cell, iteratively zooms (general VLM: ~5% → ~72% on
  ScreenSpot-V2).
- **GUI-Lens / MVP** — coarse-to-fine cropping + verification.
- **GUI-CURSOR / See-Point-Refine** — interactive feedback loop (7B: ~27% → ~57%).
- **GUI-Actor (MS)** — coordinate-free grounding design.

**Grounding DINO 1.5** (image + free-text prompt → boxes) is the strongest
open-vocab detector (~54–56 AP), but needs **≥6 GB VRAM** and has no practical
CPU path. It's the *inverse* of OCR (find a phrase by prompt), not a replacement
for the OCR candidate list — useful as an alternative when the label is known.

## 3) Recommended architecture

```
Perceptual layer (local)
  ├─ Accessibility tree (AT-SPI / DOM / UIA)   → exact bbox + role + name
  ├─ OCR (PaddleOCR)                           → text + boxes where a11y is absent
  └─ (optional) object detector                → interactable-region boxes
        │  → candidate set {id, text, role, bbox, center}
        ▼
Paint numbered marks on the screenshot (pointer-events:none overlay)
+ send the compact id list  e.g.  [12] "login"
        ▼
Small LLM picks a mark id   ("which mark is the submit button?")
        ▼
Lookup id → stored (x,y) → click → re-screenshot → verify → retry next-best if missed
```

Key principles:

- **a11y-first, OCR-fallback, model as last resort.**
- **Id-based, not coordinate-based, actions**; the model never guesses free pixels.
- **Verify-and-retry** on misses (fresh screenshot, expected-change check, next-best candidate).
- Cap mark density (~300 labels makes a screenshot unreadable); crop to the active
  region or use coarse-to-fine zoom; cache by layout hash.

Concrete local example: **AutoGUI** (github.com/BillJr99/AutoGUI) — ReAct loop
with function-calling over any local model, local OSScreenObserver REST service
for perception, Set-of-Mark `desktop_click_mark(mark_id)`, a11y-first
`desktop_click_element`, OCR-anchored `desktop_click_text`. Related:
Microsoft SoM (github.com/microsoft/SoM), OmniParser.

## Recommendation for this project (Zen on X11, local, fast)

1. **Best local+fast stack:** PaddleOCR → Set-of-Mark numbered marks → small LLM
   picks id → existing `window_interact`/click path. Add BrowserVLM (~0.54B)
   only if direct pointing without a pre-built list is needed later.
2. **With a decent GPU:** UI-TARS-1.5-7B or MolmoPoint-GUI-8B for higher-accuracy
   direct grounding; keep OCR as the fast path.
3. **Cheapest big win (no new model):** layer Mark-Grid/Auxiliary Reasoning or
   GUI-Lens on the existing small model.
4. **Avoid 72B VLMs** (e.g. Qwen2.5-VL-72B ≈ 144 GB VRAM) — not local.

## Caveats to verify before building

- **Zen may already expose an AT-SPI accessibility tree on this X11 session** —
  the exact, free, model-free source of element boxes/roles/names (this overlaps
  with the Stage C "semantic/accessibility targeting" in
  [FURTHER_IMPROVEMENT_PLAN.md](FURTHER_IMPROVEMENT_PLAN.md)). Verify actual Zen
  page coverage in this session before committing to a model pipeline.
- **Unverified claims:** Indra speed numbers; a dedicated open GUI-pointer model
  literally named "SeeMe" (searches found only an unrelated egocentric-motion
  model, WACV 2025, and SeekUI CHI 2026 — don't build on an unconfirmed name);
  exact "Grounding DINO v2/v3" numbering (official repo ships v1 + the 1.5 line).

## Jev-like (System One) decision models — local stack

**Concept.** TypeSafe's **Jev** (closed, hosted) is a "System One" model: unstructured state in → **typed decisions with probabilities out** — yes/no, choice among options, score, number — **without generating free-form text**. Trained via RLCD (Reinforcement Learning for Calibrated Decisions) to directly score bounded decision spaces; 20–200× faster than LLMs at bounded actions because it's one token, not an autoregressive sequence.

**System 1 vs System 2 division of labor** (used by fast-browser-use and Third Hand):
- **System 2 (host LLM)**: user intent, macro planning, independent outcome verification.
- **System 1 (local decision model)**: high-frequency bounded choices over a finite candidate list; calibrated per-option probabilities; ~tens of ms each.

**User's local stack** (config: `~/.config/inference/`, `last_systemone: h2o-lightning-4b`):
- **`h2o-lightning-4b`** — llama.cpp decision server, 4B (Q8_0 GGUF at `/workspace/tmp/llama.cpp-h2o-lightning/models/h2o/h2o-lightning-4b-Q8_0.gguf`, ~4.2 GB weights → ~5.2 GB VRAM), **`POST /v1/systemone`**, port **:1237**, `-c 8192 -np 1` (stable per-option probabilities, per the decision-server README). Coexists with :1234 text slot; System One slot is exclusive.
- **`qwen3.8-27b-simplejev`** — the full 27B MTP tuned for "simple-jev" scoring (one token per question; prefill-only cost; wide batch with prefix reuse; :1234). Tuned for ~1.5k-token prompts, exactly one generated token per decision.
- **`laya-email`** — 421M ModernBERT System One, :1237 (~4.2 GB/worker; docs/JEVLIKE.md §7: 4 workers ≈ 13.6 GB).
- Consumer today: **mail1** (`SYSTEMONE_URL` → `http://127.0.0.1:1237`). Ports: :1234 = text LLM slot (shared), :1237 = System One slot (exclusive).

**Reference implementations already cloned:**
- `/workspace/mcp-computer-use/tmp/fast-browser-use` — local System 1 browser engine (Qwen3.5-9B/35B-A3B, MLX/PyTorch), MIT. DOM candidates → single-token logits, guard loop, `--expect-*` verification. See bookmark notes above.
- **rizzo-flow** (GitHub, Apache-2.0) — open local Jev clone; same `POST /v1/systemone` API; 4.4 GB, ~50 ms/decision on llama.cpp; fine-tuned Spark-X2.5-4B.

**Why this fits this project.** The current weak link in mcp-computer-use is **target selection**: one mid-size agent model does perception *and* picks the click coordinate from raw pixels. Offloading selection to a Jev-like, fed a finite candidate list of real elements (text/label/role/bbox), is:
1. **Faster** — one forward pass, ~50 ms, vs. a full agent reasoning turn (hundreds of ms to seconds).
2. **More accurate** — the model only scores options that objectively exist; hallucinated coordinates become impossible by construction (same reason fast-browser-use eliminates selector hallucination).
3. **Calibrated** — per-option probabilities let the host (a) pick the max, (b) abort on low confidence, (c) ask for a re-observation, (d) report its uncertainty to the user.
4. **Compositional** — the big vision/model still does perception and planning; the Jev-like does only the atomic pick. This matches the user's existing split (`mail1` is already a System One classifier on the local stack).

## LiquidAI Open d1 — a Jev-like decision model WITH vision (bookmark 364)

Discovered via bookmark 364 (x.com/_jakubchmura/status/2107891348577681623, "try this image+audio jev classifier"). LiquidAI released **Open d1**: two open-weight multimodal **decision models** (d1-3B: text+vision; d1-omni-600M: text+image/audio) that do **real-time decision making** from data center to RTX to Jetson edge. The poster ran it in the browser within 47 min using [runntime](https://github.com/software-mansion/runntime) (WebGPU).

**d1-omni-600M** (587M params, LFM2.5-Encoder-350M base):
- Typed answers with **zero output tokens**: yes/no, choice among named options, or score — read directly from the model's distribution over options, **no generation, no parsing**. One forward pass per state.
- **Vision-language**: text + images (tiled for large frames, several images per state), via a **SigLIP2 vision tower** (from LFM2.5-VL-450M) + 350M shared trunk + decision head.
- **Audio-language**: text + up to 30 s speech, via a 17-layer FastConformer. All modalities share the trunk weights.
- 16,384-token context (state+question+images/audio combined); 65,536 vocab. **Edge-sized (~0.6 GB).**
- Intended uses: "yes/no, pick from named options, rating: routing and triage, moderation, intent/topic classification, voice-command routing, extraction checks, reranking, agent guardrails, and **visual inspection**." *Explicitly not a chat model — does not write text.*

**Runs where you already run inference.** d1-omni-600M-GGUF works on **llama.cpp** (same binary, same `POST /v1/systemone` endpoint, same `-b/-ub` batch settings as your h2o-lightning-4b server), or vLLM/SGLang/Transformers. So it slots into the existing `SYSTEMONE_URL` client as a drop-in **vision-capable** decision model. Recommended launch: `llama-server -hf LiquidAI/d1-omni-600M-GGUF:Q8_0 -b 4096 -ub 4096`.

**The key nuance for our use case (text + bounding boxes):** d1 outputs **typed decisions with probabilities — not bounding boxes.** Its vision is *inspection* (is there an error? which type of UI element? does it match this description?), delivered as yes/no/choice/score, not coordinates. So d1 does **not** replace the OCR/detection layer for *producing* text+boxes. The division of labor is:
1. **Perception / extraction (text + boxes):** PaddleOCR, Tesseract, CRAFT, or EasyOCR over the screenshot (or CDP/AT-SPI in Zen where DOM/a11y exists).
2. **Decision (which candidate / is-it-there / confidence):** d1-omni-600M — feed it the extracted candidates (or a raw screenshot + a description) and a named question; get a one-token, probability-scored answer at ~tens of ms. This is the *Jev-like + good vision model* pairing, and it's what makes the pick both fast and calibrated.
3. **Planning / verification (System 2):** the big agent model (Bonzai/qwen) — sets the goal and independently verifies the outcome.

Net: d1-omni-600M is the single best-fit *decision* model for the mcp-computer-use Phase-2 loop, because it (a) has a real vision encoder for screenshots, (b) is the Jev/typed-decision paradigm (calibrated probabilities, zero tokens, ~50–100 ms), and (c) speaks the exact API your h2o-lightning-4b server already implements.

## Skill comparison: fast-browser-use skill vs mcp-computer-use/SKILL.md

The known-good skill lives at `tmp/fast-browser-use/skills/fast-browser-use/SKILL.md` (read in full, 2026-11-08). It is a **delegation skill**: one command (`fbu run`) and an explicit boundary.

**What our SKILL.md gets right (keep):**
- The single coordinate rule (image pixels, no offsets) is the *whole* thing that makes small-model clicks reliable — fbu's skill doesn't even need one because it never asks for coordinates. Ours does; keep it prominent.
- Explicit **input_sent ≠ app success** (fbu: "DONE claim does not prove success"). Same principle, ours is hand-rolled; theirs is a contract plus `--expect-*` assertions.
- **2-miss → stop, no coordinate compensation.** Good; fbu's analogue is the guarded-loop "never blindly retry a dispatched mutation." Keep it.
- The typed `window_interact` (click → replace/type → keys, ordered) matches fbu's guarded execution-loop spirit.

**What fbu's skill teaches us (candidate changes):**
1. **Name the division of labor.** fbu: *"The host supplies the goal and verifies the result. No cloud inference is used inside the loop."* Our skill never says who verifies — just "inspect the result." Make it explicit: **the agent that issued the goal is the verifier, not the click model.**
2. **Structured end conditions.** fbu has `--expect-url / --expect-title / --expect-text` that run against a *fresh* read and are **never fed back to the model as the plan**. Suggested extension for mcp-computer-use: an `expect` parameter (title/URL/text fragments) on `window_interact` / `window_key` that the server checks independently and reports as `verification: pass|fail|partial`, distinct from `input_sent`. This turns verification from prose into a first-class, model-agnostic result.
3. **Machine-readable trace.** fbu returns `status, verification, page, history, rejections, elapsed_ms` (JSON). `rejections` tells the agent *which candidates were rejected and why* — direct evidence for recovery. Our screenshot responses are already JSON-ish (metadata block); adding `rejections`/`confidence` (if a decision model is wired in) would make the trace useful.
4. **Anti-bypass constraint.** fbu: *"Never replace the loop with host-generated selectors, executable model code, prepared field strings or site-specific action plans."* The analogue for us (once a Jev-like is in the loop): **the agent must pick from the candidate list it was given, not hand the server raw coordinates outside the list.** Our `window_interact` currently allows free `x,y`, which is both the reason it works today and the reason the model can hallucinate a coordinate; the Jev-like phase would tighten this to "pick an id, or ask for a new observation."
5. **Honest probabilistic language.** fbu: *"Candidate softmax scores are relative preferences, not calibrated correctness probabilities."* If we surface decision-model probabilities, say the same so the agent doesn't over-trust a 0.61.
6. **Scope is a feature.** fbu scopes itself to browser nav/search/forms and says V1 limitations explicitly (no nested iframes, shadow DOM, canvas, uploads, multi-tab). A skill that states its limits and *why* (fresh profile, no inherited logins, experimental reliability) keeps the host from asking it things it can't do. Ours should similarly name its X11/Zen limits (single browser surface = the user's real Zen, not the integrated-browser MCP; no drag/scroll; move/resize unavailable).
7. **Fresh observations are mandatory after any mutation.** fbu bakes this in (`--expect-*` on a fresh read; rejections may invalidate stale decisions). Ours invalidates older screenshots on action — same mechanic, just restate it as a contract: **after any click/enter, the next observation is mandatory; the old image is stale evidence.**

**Net assessment.** Our skill is stronger on *what to do when things go wrong* (crop/grid, 2-miss stop, compound-action step reporting, cursor semantics). fbu's skill is stronger on *boundaries and verification* (who verifies, structured expectations, anti-bypass, honest probabilities). Recommended next step: add `expect-*` verification and an explicit System 1/2 division of labor to mcp-computer-use/SKILL.md, and (Phase 2) swap free `x,y` targeting for Jev-like candidate-id targeting.

## Backlog bookmarks (work ideas.md) — reviewed

Reviewed in the user's VS Code integrated browser, one at a time, 2026-11-08. Source: `/workspace/Biz/EM/Agent/work ideas.md`.

- **"try this OCR model"** (x.com/HuggingModels/2101078820447203592) — NOT OCR. DeepSeek-V4.1-Flash-NVFP4: 4-bit multimodal (image+text) model, ~24GB GPU class, image→text Q&A/captioning. Candidate for a "smarter local screenshot-QA" layer; no bbox/coordinate output.
- **"macOS computer-use sending labels over network?"** → **Third Hand** (github.com/shhivv/third-hand, MIT, 385★): macOS assistant; perception stack is the canonical architecture: **arc-cua** driver (accessibility-first, background control, result checks) + **Apple Vision** local screen-text OCR fallback + **Jev (cloud)** picks the control from matching candidate labels; ChatGPT plans. Use as blueprint for the local stack; replace the two cloud parts.
- **"try this solidcv fast image classifier"** (x.com/solidSF/2111931811807068377) — Rust + CUDA image-engineering/inference kernels. Infrastructure, not a model. Not this project.
- **"TRY THIS ANNOTATION TOOl"** (x.com/dexhorthy/2112203344664289604) — 2:10 video demo only, no extractable text/link. Watch manually if needed.
- **"try cua driver in sandbox (or clone it)"** → CuaDriver (@trycua): open-source agent cursor-motion driver (6 hand-crafted motions from 82 built, human mouse-aim study). Upstream of the existing `PLAN-agent-cursor-overlay.md` work; cursor layer, not a targeting model.
- **"explore cua fast-browser-use"** (x.com/starmexxx/2107543392330699147) → 5 local repos:
  - **APUS-AI-Lab/fast-browser-use** (MIT, 234★): local "System 1" browser engine, Qwen3.5-9B/35B-A3B on MLX/PyTorch, zero cloud. DOM scanner extracts visible interactable elements into finite candidates; **single-token logits scoring** (one forward pass + softmax) — selector hallucination impossible by construction; generation only for TYPE_TEXT; guard loop (settle windows, occlusion/DOM-freshness/read-only guards, write-once trace, no blind retries, independent verification via expect-url/title/text). Median 4.055s on 96GB RTX PRO 6000 for 4-step Wikipedia nav with 9B. Note: DOM-based (browser-use), not screenshot-based.
  - **Rizzo-AI-Academy/rizzo-flow** (Apache-2.0, 931★): open local take on Jev — unstructured state in, **typed probabilistic decisions out (0 generated tokens)**. llama.cpp on CUDA/Vulkan/Metal/CPU; Spark-X2.5-4B LoRA-fine-tuned, 4.4GB Q8_0, ~50ms/decision (RTX 5060 Ti); Jev-compatible HTTP API (`POST /v1/systemone`, localhost drop-in). Ship with an agent skill. Caveats: uncalibrated probabilities by default; typed-decisions bench accuracy 0.648 (fine-tuned 4B) vs 0.727 (Jev).
  - **Yinsongxu/LLM2Jev** (391★): qwen3.5-4b as Jev-style decision model, 48ms p50 vs 652ms for real Jev.

### Convergence with the user's own backlog notes
- work ideas.md L586-588: "build a computer-use for my macos laptop — image/label ocr aria — classifier to make decisions about what to click".
- L598-599: "improve ada's ability to browse — using the screen labeler (aria labels?) — sending openjev a list of labels to choose from".
- L2677-2678: "visual analysis (VLM) — SAM model to identify rect bounding boxes for things that can be tracked and clicked or otherwise interacted with".

All point at the same architecture the research doc recommends (perception → finite candidate list → small local decision model → guarded execution → independent verification). The local decision-model slot maps to rizzo-flow/llm2jev (~4B, ~50ms, llama.cpp); the perception slot maps to AT-SPI (Zen exposes it? — see caveat) + PaddleOCR/Tesseract on screenshots; fast-browser-use is the reference implementation of the candidate-list + discrete-choice pattern, DOM-side. Because Zen is a browser, the DOM/CDP path (more reliable than OCR boxes where present) is available; OCR/AT-SPI remain the screenshot-path fallbacks.

## Sources

OCR:
- Roboflow — "Best Open-Source OCR Models in 2026, Ranked by Benchmark"
- IntuitionLabs — "Technical Analysis of Modern Non-LLM OCR Engines"
- LoftTools — "PaddleOCR vs Tesseract vs TrOCR: OCR in the Browser"
- Reducto — "Best OCR Models in 2026: Accuracy, Speed and Cost"
- FileFormat — OCR API comparison
- dots.ocr model cards (studio-dots-ai, huggingface.co/rednote-hilab)
- Vik Paruchuri (X, 2026) — Indra; Gnana Prasath (Medium, 2026)
- Modal — "8 Top Open-Source OCR Models Compared"

Grounding:
- BrowserOS blog — BrowserVLM (0.54B GUI-grounding model)
- Allen AI — MolmoPoint / molmo2
- arXiv 2509.21552 — GUI-CURSOR
- arXiv 2509.11548 — Auxiliary Reasoning / Mark-Grid
- Pith — GUI-Lens
- arXiv 2604.13019 — See, Point, Refine
- Microsoft — GUI-Actor
- Microsoft — SoM (github.com/microsoft/SoM)
- LearnOpenCV — OmniParser: Vision Based GUI Agent
- The Neural Base / NVIDIA TAO — Grounding DINO hardware requirements
- Qwen2.5-VL blog (Alibaba) — visual localization, 3B/7B/72B
- HuggingFace — nvidia/LocateAnything-3B (non-commercial license — not eligible for open use)
- arXiv 2410.05243 — Universal Visual Grounding for GUI Agents

Architecture:
- github.com/BillJr99/AutoGUI
- dev.to — "Visual Grounding for AI Agents: Set-of-Mark Prompting and Reliable UI Clicks"
- github.com/9529360-cpu/znagent PR #218 — Windows local OCR / system-first grounding
- dev.to — "Building Screen Automation Agents: Vision, Grounding, and Reliable UI Control"
- Microsoft — SoM
- arXiv — ShowUI (training-free GUI agent family) paper review
