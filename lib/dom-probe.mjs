// Executed only by our internal mcp-zen adapter, never accepted from MCP arguments.
export async function domProbe(key, request) {
  const w = window,
    d = document;
  const normalize = (s) =>
    String(s || "")
      .replace(/\s+/g, " ")
      .trim();
  let state = w[key];
  if (!state) {
    state = {
      documentId: Array.from(crypto.getRandomValues(new Uint32Array(4))).join(
        "-",
      ),
      next: 1,
      refs: new Map(),
      ids: new WeakMap(),
    };
    Object.defineProperty(w, key, { value: state, configurable: true });
  }
  const rendered = (el) => {
    if (!el?.isConnected || !el.getClientRects().length) return false;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (
        s.display === "none" ||
        s.visibility === "hidden" ||
        s.visibility === "collapse" ||
        Number(s.opacity) === 0 ||
        n.hidden ||
        n.inert
      )
        return false;
    }
    return true;
  };
  const name = (el) =>
    normalize(
      el
        .getAttribute("aria-labelledby")
        ?.split(/\s+/)
        .map((id) => d.getElementById(id)?.textContent || "")
        .join(" ") ||
        el.getAttribute("aria-label") ||
        el.alt ||
        Array.from(el.labels || [])
          .map((l) => l.textContent)
          .join(" ") ||
        el.innerText ||
        el.getAttribute("placeholder") ||
        el.title ||
        el.getAttribute("name") ||
        el.tagName.toLowerCase(),
    );
  const fingerprint = (el) =>
    JSON.stringify([
      el.tagName,
      name(el),
      el.getAttribute("href"),
      el.getAttribute("type"),
    ]);
  const describe = (el) => {
    const r = el.getBoundingClientRect(),
      vv = w.visualViewport,
      scale = vv?.scale || 1,
      dpr = w.devicePixelRatio || 1;
    const x = Math.max(0, r.left),
      y = Math.max(0, r.top),
      right = Math.min(w.innerWidth, r.right),
      bottom = Math.min(w.innerHeight, r.bottom);
    const onscreen = right > x && bottom > y;
    const cx = (x + right) / 2,
      cy = (y + bottom) / 2;
    const hit = onscreen ? d.elementFromPoint(cx, cy) : null;
    const blocked =
      !hit ||
      !(
        hit === el ||
        el.contains(hit) ||
        hit.closest?.("label")?.control === el
      );
    const editable = el.matches(
      "textarea,input:not([type]),input[type=text],input[type=search],input[type=email],input[type=password],input[type=url],input[type=tel],input[type=number],[contenteditable=true]",
    );
    const enabled =
      !el.matches(":disabled,[aria-disabled=true]") && !el.readOnly;
    const role =
      el.getAttribute("role") ||
      {
        A: "link",
        BUTTON: "button",
        INPUT: "textbox",
        TEXTAREA: "textbox",
        SELECT: "combobox",
        IMG: "img",
      }[el.tagName] ||
      el.tagName.toLowerCase();
    return {
      label: name(el).slice(0, 500),
      role,
      enabled,
      editable,
      rendered: rendered(el),
      visibility: onscreen ? "onscreen" : "offscreen",
      blocked,
      fields: {
        text: normalize(el.innerText || el.textContent).slice(0, 2000),
        accessible_name: name(el),
        alt: el.getAttribute("alt") || "",
        title: el.getAttribute("title") || "",
      },
      box: {
        x: (w.mozInnerScreenX + (r.left - (vv?.offsetLeft || 0)) * scale) * dpr,
        y: (w.mozInnerScreenY + (r.top - (vv?.offsetTop || 0)) * scale) * dpr,
        width: r.width * scale * dpr,
        height: r.height * scale * dpr,
      },
      point: {
        x: (w.mozInnerScreenX + (cx - (vv?.offsetLeft || 0)) * scale) * dpr,
        y: (w.mozInnerScreenY + (cy - (vv?.offsetTop || 0)) * scale) * dpr,
      },
      focused:
        d.activeElement === el ||
        (el.isContentEditable && el.contains(d.activeElement)),
    };
  };
  const meta = {
    documentId: state.documentId,
    title: d.title,
    url: location.href,
    visible: d.visibilityState === "visible",
    outer: {
      x: w.screenX * w.devicePixelRatio,
      y: w.screenY * w.devicePixelRatio,
      width: w.outerWidth * w.devicePixelRatio,
      height: w.outerHeight * w.devicePixelRatio,
    },
  };
  if (request.op === "capture") {
    const width = request.fullPage
      ? Math.max(
          d.documentElement.scrollWidth,
          d.body?.scrollWidth || 0,
          w.innerWidth,
        )
      : w.innerWidth;
    const height = request.fullPage
      ? Math.max(
          d.documentElement.scrollHeight,
          d.body?.scrollHeight || 0,
          w.innerHeight,
        )
      : w.innerHeight;
    if (width * height * w.devicePixelRatio ** 2 > 20000000)
      throw Error(
        "Browser capture exceeds 20 megapixels; use viewport or a target crop",
      );
    return meta;
  }
  if (request.op === "discover") {
    const all = Array.from(
      d.querySelectorAll(
        "a,button,input,textarea,select,img,[role],[tabindex],[contenteditable],label,h1,h2,h3,h4,p,li,td,span",
      ),
    );
    if (all.length > 10000)
      throw Error(
        "DOM too large for bounded discovery; narrow the page or use OCR",
      );
    const rows = [];
    for (const el of all) {
      if (!rendered(el)) continue;
      const item = describe(el);
      if (request.scope !== "loaded_document" && item.visibility !== "onscreen")
        continue;
      if (
        request.filter &&
        !request.fields.some((field) =>
          item.fields[field]
            .toLocaleLowerCase()
            .includes(request.filter.toLocaleLowerCase()),
        )
      )
        continue;
      let ref = state.ids.get(el);
      if (!ref) {
        ref = String(state.next++);
        state.ids.set(el, ref);
      }
      state.refs.set(ref, { el, fingerprint: fingerprint(el) });
      rows.push({ ...item, ref });
    }
    // Keep refs bounded; old observations explicitly fail if their reference is evicted.
    while (state.refs.size > 12000)
      state.refs.delete(state.refs.keys().next().value);
    return {
      ...meta,
      rows: rows.slice(request.offset, request.offset + request.limit),
      total: rows.length,
    };
  }
  if (request.documentId !== state.documentId)
    throw Error("Document changed; observe again");
  const saved = state.refs.get(request.ref),
    el = saved?.el;
  if (
    !el?.isConnected ||
    saved.fingerprint !== fingerprint(el) ||
    !rendered(el)
  )
    throw Error("Target changed or disappeared; observe again");
  if (request.op === "reveal") {
    el.scrollIntoView({
      block: "center",
      inline: "center",
      behavior: "instant",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (
      !el.isConnected ||
      saved.fingerprint !== fingerprint(el) ||
      !rendered(el)
    )
      throw Error("Target changed during scrolling");
  }
  const first = el.getBoundingClientRect();
  await new Promise((resolve) => setTimeout(resolve, 80));
  const second = el.getBoundingClientRect();
  if (
    ["x", "y", "width", "height"].some(
      (k) => Math.abs(first[k] - second[k]) > 1,
    )
  )
    throw Error("Target layout is moving; observe again");
  return { ...meta, target: { ...describe(el), ref: request.ref } };
}
