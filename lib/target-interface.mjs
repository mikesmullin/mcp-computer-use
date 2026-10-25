import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { saveCapture } from "./capture-files.mjs";
import { sameGeometry } from "./screenshot-views.mjs";
import { normalizeKey } from "./keys.mjs";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = (w) => /zen|firefox/i.test(w.class);
const fields = ["text", "accessible_name", "alt", "title"];
export function createTargetInterface({
  awesome,
  x11,
  ocr,
  zen,
  vision,
  now = Date.now,
  wait = pause,
  save = saveCapture,
} = {}) {
  const observations = new Map(),
    images = new Map(),
    generations = new Map();
  const generation = (w) => generations.get(w) || 0;
  const invalidate = (w) => generations.set(w, generation(w) + 1);
  const remember = (map, id, value, max) => {
    map.set(id, value);
    while (map.size > max) map.delete(map.keys().next().value);
  };
  async function image(bytes) {
    const imageId = randomUUID();
    remember(
      images,
      imageId,
      { path: await save(bytes), expires: now() + 3600000 },
      64,
    );
    return imageId;
  }
  function imagePath(id) {
    const i = images.get(id);
    if (!i || i.expires < now())
      throw Error("Image expired or unknown; capture again");
    return i.path;
  }
  function ref(args) {
    const o = observations.get(args.observationId);
    if (
      !o ||
      now() - o.time > 120000 ||
      o.generation !== generation(o.windowId)
    )
      throw Error("Observation stale or expired; observe again");
    const s = args.target;
    if (!s || (s.id !== undefined) === (s.label !== undefined))
      throw Error("Supply exactly one target id or exact label");
    const matches = o.targets.filter((t) =>
      s.id !== undefined ? t.id === s.id : t.label === s.label,
    );
    if (matches.length !== 1)
      throw Error(
        matches.length
          ? `Ambiguous label; choose an id: ${matches.map((t) => t.id).join(", ")}`
          : "Unknown target in this observation",
      );
    return { o, t: matches[0] };
  }
  async function fresh(o) {
    const w = await awesome.one({ windowId: o.windowId });
    if (
      w.title !== o.title ||
      !sameGeometry(o.geometry, await x11.geometry(o.windowId))
    )
      throw Error("Window geometry/title changed; observe again");
    return w;
  }
  const publicTarget = (t) =>
    Object.fromEntries(
      ["id", "label", "role", "source", "visibility", "enabled", "actions"]
        .filter((k) => t[k] !== undefined)
        .map((k) => [k, t[k]]),
    );
  async function observe({ windowId, filter = "", limit = 50 }, search) {
    const w = await awesome.one({ windowId: Number(windowId) });
    const start = now();
    invalidate(w.windowId);
    const shot = await x11.screenshot({ windowId: w.windowId });
    const targets = [],
      warnings = [];
    let binding,
      total = 0,
      domOK = false,
      ocrOK = false;
    if (browser(w)) {
      try {
        const d = await zen.discover(w, shot.geometry, {
          filter,
          fields: search?.fields || fields,
          scope: search?.scope || "viewport",
          offset: search?.offset || 0,
          limit: search ? limit : 300,
        });
        binding = {
          documentId: d.documentId,
          tab: d.tab,
          geometry: shot.geometry,
        };
        domOK = true;
        total = d.total;
        for (const row of d.rows)
          targets.push({
            ...row,
            source: "dom",
            actions:
              row.enabled && (!row.blocked || row.visibility === "offscreen")
                ? ["click", ...(row.editable ? ["type"] : []), "scroll"]
                : [],
            enabled: row.enabled,
          });
      } catch (e) {
        if (search) throw e;
        warnings.push("DOM unavailable: " + e.message);
      }
    } else if (search)
      throw Error("This window has no supported browser DOM bridge");
    if (!search) {
      try {
        const result = await ocr.read(shot);
        if (
          result.width !== shot.geometry.width ||
          result.height !== shot.geometry.height
        )
          throw Error("OCR dimensions do not match capture");
        const ocrTargets = [];
        for (const r of result.regions) {
          if (!r.text.toLocaleLowerCase().includes(filter.toLocaleLowerCase()))
            continue;
          if (
            !r.bounds?.every(Number.isFinite) ||
            r.bounds.length !== 4 ||
            r.bounds[0] < 0 ||
            r.bounds[1] < 0 ||
            r.bounds[2] > shot.geometry.width ||
            r.bounds[3] > shot.geometry.height ||
            r.bounds[2] <= r.bounds[0] ||
            r.bounds[3] <= r.bounds[1]
          )
            throw Error("Invalid OCR bounds");
          ocrTargets.push({
            ...r,
            label: r.text,
            source: "ocr",
            visibility: "onscreen",
            enabled: true,
            actions: ["click", "scroll"],
          });
        }
        targets.push(...ocrTargets);
        ocrOK = true;
      } catch (e) {
        warnings.push("OCR unavailable: " + e.message);
      }
      if (!domOK && !ocrOK) throw Error(warnings.join("; "));
    }
    const after = await awesome.one({ windowId: w.windowId });
    if (
      after.title !== w.title ||
      !sameGeometry(shot.geometry, await x11.geometry(w.windowId)) ||
      now() - start >= 120000
    )
      throw Error("Window changed or observation expired during discovery");
    const observationId = randomUUID();
    const shown = targets
      .slice(0, limit)
      .map((t, i) => ({ ...t, id: (search?.offset || 0) + i + 1 }));
    const imageId = await image(shot.bytes);
    const o = {
      windowId: w.windowId,
      title: w.title,
      geometry: shot.geometry,
      time: start,
      generation: generation(w.windowId),
      targets: shown,
      binding,
      imageId,
      bytes: shot.bytes,
    };
    remember(observations, observationId, o, 32);
    if (!search && targets.length > limit)
      warnings.push(
        "Target list truncated; narrow filter or increase limit. Use browser_page_find for DOM pagination.",
      );
    return {
      observationId,
      imageId,
      targets: shown.map(publicTarget),
      ...(search && (search.offset || 0) + shown.length < total
        ? { nextOffset: (search.offset || 0) + shown.length }
        : {}),
      ...(warnings.length ? { warnings } : {}),
    };
  }
  async function resolve(o, t, reveal = false) {
    const w = await fresh(o);
    if (t.source === "dom") {
      const d = await zen.resolve(w, o.binding, t, reveal);
      const r = d.target;
      if (!r.rendered || !r.enabled || r.visibility !== "onscreen" || r.blocked)
        throw Error(
          "Target hidden, disabled, offscreen, or covered; no click sent",
        );
      const x = Math.round(r.point.x - o.geometry.x),
        y = Math.round(r.point.y - o.geometry.y);
      if (
        !Number.isInteger(x) ||
        !Number.isInteger(y) ||
        x < 0 ||
        y < 0 ||
        x >= o.geometry.width ||
        y >= o.geometry.height
      )
        throw Error(
          "Target outside native window; coordinate mapping rejected",
        );
      return { x, y, dom: r };
    }
    const shot = await x11.screenshot({ windowId: o.windowId });
    if (!sameGeometry(shot.geometry, o.geometry) || !(await ocr.check(shot, t)))
      throw Error("OCR region changed; observe again");
    // Derive the point from checked bounds, never from a model or OCR center field.
    return {
      x: Math.floor((t.bounds[0] + t.bounds[2] - 1) / 2),
      y: Math.floor((t.bounds[1] + t.bounds[3] - 1) / 2),
    };
  }
  async function crop(args) {
    const { o, t } = ref(args);
    await fresh(o);
    let bounds;
    if (t.source === "dom") {
      const d = await zen.resolve(await fresh(o), o.binding, t, false);
      if (d.target.visibility !== "onscreen")
        throw Error(
          "target_offscreen: reveal with window_scroll before cropping",
        );
      // Crop the observation's pixels using its original bounds, not new live geometry.
      if (JSON.stringify(d.target.box) !== JSON.stringify(t.box))
        throw Error("Target moved since capture; observe again");
      bounds = [
        t.box.x - o.geometry.x,
        t.box.y - o.geometry.y,
        t.box.x - o.geometry.x + t.box.width,
        t.box.y - o.geometry.y + t.box.height,
      ];
    } else bounds = t.bounds;
    const margin = args.context === "surrounding" ? 60 : 3;
    const left = Math.max(0, Math.floor(bounds[0] - margin)),
      top = Math.max(0, Math.floor(bounds[1] - margin));
    const right = Math.min(o.geometry.width, Math.ceil(bounds[2] + margin)),
      bottom = Math.min(o.geometry.height, Math.ceil(bounds[3] + margin));
    if (right <= left || bottom <= top)
      throw Error("Target has no captured pixels");
    return {
      imageId: await image(
        await sharp(o.bytes)
          .extract({ left, top, width: right - left, height: bottom - top })
          .png()
          .toBuffer(),
      ),
    };
  }
  async function pathFor(input) {
    return imagePath(input.imageId ?? (await crop(input)).imageId);
  }
  async function action(kind, a) {
    let windowId = a.windowId
        ? Number(a.windowId)
        : observations.get(a.observationId)?.windowId,
      mutated = false,
      verification = "not_checked";
    try {
      if (kind === "key") a.keys.forEach(normalizeKey);
      if (kind === "scroll" && a.target && a.within)
        throw Error("Use target OR within, not both");
      const argRef = ["click", "type"].includes(kind)
        ? a
        : kind === "key"
          ? a.focusTarget
          : a.target || a.within;
      const selected = argRef ? ref(argRef) : null;
      const o = selected?.o,
        t = selected?.t;
      if (o) {
        if (windowId && windowId !== o.windowId)
          throw Error("Target belongs to a different window");
        windowId = o.windowId;
        await fresh(o);
      }
      const w = await awesome.one({ windowId });
      const geometry = o?.geometry || (await x11.geometry(windowId));
      if (kind === "key" && t?.source === "ocr")
        throw Error("focus_unverifiable: cannot verify OCR target focus");
      if (
        kind === "type" &&
        (!t.actions.includes("type") || t.source !== "dom")
      )
        throw Error(
          "focus_unverifiable: OCR cannot verify editable field focus; use a DOM target or keyboard navigation",
        );
      if (kind === "scroll" && a.target) {
        if (t.source !== "dom")
          throw Error("Scroll-to-target requires a DOM target");
        invalidate(windowId);
        mutated = true;
        await zen.resolve(w, o.binding, t, true);
      } else {
        let p;
        if (t) {
          if (t.source === "dom") {
            invalidate(windowId);
            mutated = true;
          }
          p = await resolve(o, t, true);
          if (kind !== "scroll") {
            invalidate(windowId);
            mutated = true;
            await x11.click(windowId, {
              ...p,
              button: { left: 1, middle: 2, right: 3 }[a.button || "left"],
              expectedGeometry: geometry,
              count: a.count || 1,
              validateTarget: async () => {
                const current = await resolve(o, t, false);
                if (
                  Math.abs(current.x - p.x) > 1 ||
                  Math.abs(current.y - p.y) > 1
                )
                  throw Error(
                    "Target moved during pointer travel; no click sent",
                  );
              },
            });
            if (kind === "type" || kind === "key") {
              await wait(80);
              if (t.source !== "dom")
                throw Error(
                  "focus_unverifiable: cannot verify OCR target focus",
                );
              const d = await zen.resolve(await fresh(o), o.binding, t, false);
              if (!d.target.focused)
                throw Error(
                  "Intended field did not receive focus; no text/keys sent",
                );
              verification = "focus_verified";
            }
          }
        }
        if (kind === "type") {
          if (a.mode !== "append")
            await x11.key(windowId, "Ctrl+a", { expectedGeometry: geometry });
          await x11.typeText(windowId, a.text, { expectedGeometry: geometry });
        } else if (kind === "key") {
          invalidate(windowId);
          mutated = true;
          for (const key of a.keys)
            await x11.key(windowId, key, { expectedGeometry: geometry });
        } else if (kind === "scroll") {
          invalidate(windowId);
          mutated = true;
          await x11.scroll(windowId, {
            x: p?.x ?? Math.floor(geometry.width / 2),
            y: p?.y ?? Math.floor(geometry.height / 2),
            direction: a.direction || "down",
            amount: a.amount || "small",
            expectedGeometry: geometry,
          });
        }
      }
      await wait(150);
      let observation, reason;
      try {
        observation = await observe({ windowId: String(windowId) });
      } catch (e) {
        reason =
          "Input sent but refresh failed: " +
          e.message +
          "; do not repeat input blindly";
      }
      return {
        status: "input_sent",
        verification,
        ...(observation ? { observation } : {}),
        ...(reason ? { reason } : {}),
      };
    } catch (e) {
      let observation;
      if (
        windowId &&
        /stale|expired|changed|disappeared|moved/i.test(e.message)
      ) {
        try {
          observation = await observe({ windowId: String(windowId) });
        } catch {}
      }
      return {
        status: "rejected",
        reason:
          e.message +
          (mutated
            ? " (Scrolling or partial input may already have occurred; observe before retrying.)"
            : ""),
        verification,
        ...(observation ? { observation } : {}),
      };
    }
  }
  return {
    imageContent: async (id) =>
      (
        await (await import("node:fs/promises")).readFile(imagePath(id))
      ).toString("base64"),
    window_list: async () =>
      (await awesome.list()).map((w) => ({
        windowId: String(w.windowId),
        title: w.title,
      })),
    window_observe: observe,
    browser_page_find: (a) =>
      observe(
        { windowId: a.windowId, filter: a.filter, limit: a.limit ?? 50 },
        {
          fields: a.fields || fields,
          scope: a.scope || "viewport",
          offset: a.offset || 0,
        },
      ),
    browser_screenshot: async (a) => {
      const w = await awesome.one({ windowId: Number(a.windowId) });
      if (!browser(w)) throw Error("Browser window required");
      const r = await zen.screenshot(w, a.scope === "full_page");
      const bytes = await (await import("node:fs/promises")).readFile(r.path);
      if (bytes.length > 10 * 1024 * 1024)
        throw Error(
          "Browser capture exceeds 10 MiB; use viewport or a target crop",
        );
      await sharp(bytes, { limitInputPixels: 20000000 }).metadata();
      return {
        imageId: await image(bytes),
        coverage:
          a.scope === "full_page" ? "currently loaded document" : "viewport",
        truncated: !!r.truncated,
      };
    },
    image_crop: crop,
    describe_image: async (a) => {
      const start = now();
      const r = await vision.call("image_describe", {
        path: await pathFor(a.image),
        prompt: a.prompt,
      });
      return {
        text: r.text,
        model: "liquid-450m",
        elapsedMs: now() - start,
        truncated: r.text.endsWith("[Description truncated.]"),
      };
    },
    decide: async (a) => {
      const start = now();
      const r = await vision.call("image_decide", {
        ...(a.image ? { path: await pathFor(a.image) } : {}),
        context: a.system_prompt || (!a.image ? a.question.prompt : undefined),
        question: a.question,
      });
      return { ...r, model: "h2o", elapsedMs: now() - start };
    },
    window_click: (a) => action("click", a),
    window_type: (a) => action("type", a),
    window_key: (a) => action("key", a),
    window_scroll: (a) => action("scroll", a),
    stop: async () => {
      await zen.stop?.();
      await vision.stop?.();
    },
  };
}
