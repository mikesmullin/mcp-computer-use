import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { createTargetInterface } from "../lib/target-interface.mjs";
import { definitions, targetTools } from "../lib/target-tools.mjs";
import { validate } from "../lib/schema.mjs";
async function fixture() {
  const bytes = await sharp({
    create: { width: 400, height: 300, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  const state = {
    time: 0,
    calls: [],
    focused: true,
    changed: false,
    blocked: false,
    checked: true,
    rows: [
      {
        ref: "a",
        label: "Name",
        role: "textbox",
        enabled: true,
        editable: true,
        rendered: true,
        visibility: "onscreen",
        box: { x: 120, y: 230, width: 100, height: 30 },
        point: { x: 160, y: 245 },
      },
    ],
  };
  const geometry = { x: 100, y: 200, width: 400, height: 300 },
    win = { windowId: 12, class: "zen", title: "Fixture" };
  const x11 = {
    geometry: async () => geometry,
    screenshot: async () => ({ bytes, geometry: { ...geometry } }),
    click: async (id, p) => {
      await p.validateTarget?.();
      state.calls.push(["click", p.x, p.y]);
    },
    key: async (id, k) => state.calls.push(["key", k]),
    typeText: async (id, t) => state.calls.push(["type", t]),
    scroll: async (id, p) => state.calls.push(["scroll", p.direction]),
  };
  const zen = {
    discover: async (w, g, a) => ({
      documentId: "doc",
      tab: "tab",
      rows: state.rows.slice(a.offset, a.offset + a.limit),
      total: state.rows.length,
    }),
    resolve: async (w, b, t, reveal) => {
      state.calls.push(["resolve", reveal]);
      if (state.changed) throw Error("Document changed");
      return {
        target: {
          ...state.rows.find((r) => r.ref === t.ref),
          visibility: reveal
            ? "onscreen"
            : state.rows.find((r) => r.ref === t.ref).visibility,
          focused: state.focused,
          blocked: state.blocked,
        },
      };
    },
  };
  const ocr = {
    read: async () => ({
      width: 400,
      height: 300,
      regions: [
        { text: "Native label", bounds: [10, 10, 80, 30], fingerprint: "hash" },
      ],
    }),
    check: async () => state.checked,
  };
  const api = createTargetInterface({
    awesome: { one: async () => win, list: async () => [win] },
    x11,
    zen,
    ocr,
    vision: { call: async () => ({ text: "Description" }) },
    now: () => state.time,
    wait: async () => {},
    save: async () => "/tmp/not-read.png",
  });
  const observe = () => api.window_observe({ windowId: "12" });
  return { state, api, observe, geometry, win };
}
test("public interface has eleven strict tools and no coordinate inputs", () => {
  assert.equal(Object.keys(definitions).length, 11);
  assert.doesNotMatch(
    JSON.stringify(definitions),
    /"(?:x|y|crop|selector|script|screenshotId)":/,
  );
  const schema = definitions.window_click[1];
  for (const target of [
    { id: 1, label: "Name" },
    { id: 1.1 },
    { x: 2, y: 3 },
    {},
  ])
    assert.throws(() => validate(schema, { observationId: "o", target }));
  assert.throws(() =>
    validate(schema, { observationId: "o", target: { id: 1 }, x: 3 }),
  );
  assert.throws(() =>
    validate(definitions.window_key[1], { windowId: "12", keys: "Enter" }),
  );
  assert.throws(() =>
    validate(definitions.window_observe[1], { windowId: "oops" }),
  );
});
test("DOM and OCR concatenate but public targets contain no private bounds", async () => {
  const { observe } = await fixture();
  const o = await observe();
  assert.deepEqual(
    o.targets.map((t) => t.source),
    ["dom", "ocr"],
  );
  assert.equal(o.targets[1].id, 2);
  assert.equal(o.targets[0].box, undefined);
  assert.equal(o.targets[1].fingerprint, undefined);
});
test("duplicate exact labels reject instead of choosing first", async () => {
  const { state, api, observe } = await fixture();
  state.rows.push({ ...state.rows[0], ref: "b" });
  const o = await observe();
  const r = await api.window_click({
    observationId: o.observationId,
    target: { label: "Name" },
  });
  assert.equal(r.status, "rejected");
  assert.match(r.reason, /Ambiguous/);
  assert.ok(!state.calls.some((c) => c[0] === "click"));
});
test("observation expiry, invalidation, geometry changes and changed OCR prevent clicks", async () => {
  for (const condition of ["expired", "new", "geometry", "ocr"]) {
    const { state, api, observe, geometry } = await fixture();
    const o = await observe();
    if (condition === "expired") state.time = 120001;
    if (condition === "new") await observe();
    if (condition === "geometry") geometry.width = 399;
    if (condition === "ocr") state.checked = false;
    // Copy geometry in the mock as real screenshot objects do.

    const r = await api.window_click({
      observationId: o.observationId,
      target: { id: condition === "ocr" ? 2 : 1 },
    });
    assert.equal(r.status, "rejected");
    assert.ok(!state.calls.some((c) => c[0] === "click"));
  }
});
test("offscreen DOM click reveals and uses current coordinates; offscreen crop never scrolls", async () => {
  const { state, api, observe } = await fixture();
  state.rows[0].visibility = "offscreen";
  const o = await observe();
  await assert.rejects(
    api.image_crop({ observationId: o.observationId, target: { id: 1 } }),
    /target_offscreen/,
  );
  assert.ok(!state.calls.some((c) => c[0] === "resolve" && c[1]));
  // The adapter returns fresh onscreen state after reveal.
  state.rows[0].visibility = "onscreen";
  const r = await api.window_click({
    observationId: o.observationId,
    target: { id: 1 },
  });
  assert.equal(r.status, "input_sent");
  assert.deepEqual(
    state.calls.find((c) => c[0] === "click"),
    ["click", 60, 45],
  );
  assert.ok(state.calls.some((c) => c[0] === "resolve" && c[1]));
});
test("typing verifies focus before sending replacement shortcut or text", async () => {
  for (const focused of [false, true]) {
    const { state, api, observe } = await fixture();
    state.focused = focused;
    const o = await observe();
    const r = await api.window_type({
      observationId: o.observationId,
      target: { id: 1 },
      text: "hello",
    });
    assert.equal(r.status, focused ? "input_sent" : "rejected");
    assert.equal(
      state.calls.some((c) => c[0] === "type"),
      focused,
    );
    assert.equal(
      state.calls.some((c) => c[0] === "key"),
      focused,
    );
    if (focused) assert.equal(r.verification, "focus_verified");
  }
});
test("OCR typing and cross-window references reject without clicking", async () => {
  const { state, api, observe } = await fixture();
  let o = await observe();
  let r = await api.window_type({
    observationId: o.observationId,
    target: { id: 2 },
    text: "hello",
  });
  assert.equal(r.status, "rejected");
  o = await observe();
  r = await api.window_scroll({
    windowId: "13",
    within: { observationId: o.observationId, target: { id: 1 } },
  });
  assert.equal(r.status, "rejected");
  assert.ok(!state.calls.some((c) => c[0] === "click"));
});
test("page search offsets persist in IDs and nextOffset; key chords stay ordered", async () => {
  const { state, api } = await fixture();
  state.rows.push(
    { ...state.rows[0], ref: "b" },
    { ...state.rows[0], ref: "c" },
  );
  const a = await api.browser_page_find({
    windowId: "12",
    filter: "",
    limit: 1,
  });
  assert.equal(a.nextOffset, 1);
  const b = await api.browser_page_find({
    windowId: "12",
    filter: "",
    limit: 1,
    offset: a.nextOffset,
  });
  assert.equal(b.targets[0].id, 2);
  assert.equal(b.nextOffset, 2);
  const r = await api.window_key({ windowId: "12", keys: ["Tab", "Enter"] });
  assert.equal(r.status, "input_sent");
  assert.deepEqual(
    state.calls.filter((c) => c[0] === "key"),
    [
      ["key", "Tab"],
      ["key", "Enter"],
    ],
  );
});
test("covered target and document changes reject; key validation precedes input", async () => {
  for (const failure of ["blocked", "changed"]) {
    const { state, api, observe } = await fixture();
    const o = await observe();
    state[failure] = true;
    assert.equal(
      (
        await api.window_click({
          observationId: o.observationId,
          target: { id: 1 },
        })
      ).status,
      "rejected",
    );
    assert.ok(!state.calls.some((c) => c[0] === "click"));
  }
  const { state, api } = await fixture();
  assert.equal(
    (await api.window_key({ windowId: "12", keys: ["Tab", "bad+key"] })).status,
    "rejected",
  );
  assert.deepEqual(state.calls, []);
});

test("image IDs are scoped and descriptions reuse saved captures", async () => {
  const { api, observe } = await fixture();
  const o = await observe();
  const result = await api.describe_image({
    image: { imageId: o.imageId },
    prompt: "Describe",
  });
  assert.equal(result.text, "Description");
  assert.equal(result.model, "liquid-450m");
  assert.equal(result.truncated, false);
  await assert.rejects(
    api.describe_image({ image: { imageId: "foreign" }, prompt: "Describe" }),
    /unknown/,
  );
});

test("attachment failure preserves already-sent action status", async () => {
  const tools = targetTools({
    window_click: async () => ({
      status: "input_sent",
      verification: "not_checked",
      observation: { imageId: "gone" },
    }),
    imageContent: async () => {
      throw Error("evicted");
    },
  });
  const result = await tools.window_click.handler({});
  assert.equal(JSON.parse(result.content[0].text).status, "input_sent");
  assert.match(result.content[1].text, /already sent/);
});
