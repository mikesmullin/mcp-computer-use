import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { domProbe } from "./dom-probe.mjs";
const clean = (s) => s.replace(/[\u200b-\u200f\u2060-\u206f]/g, "").trim();
export function createZenTargets({
  url = process.env.MCP_ZEN_URL || "http://127.0.0.1:8791/mcp",
} = {}) {
  let client;
  const key = "__computerUse_" + randomUUID().replaceAll("-", "");
  async function call(name, args = {}) {
    if (!client) {
      const c = new Client({ name: "computer-use-targets", version: "1" });
      try {
        await c.connect(new StreamableHTTPClientTransport(new URL(url)));
        client = c;
      } catch (e) {
        await c.close().catch(() => {});
        throw e;
      }
    }
    const r = await client.callTool({
      name: "zen_browser_" + name,
      arguments: { ...args, timeoutMs: 15000 },
    });
    const data = r.structuredContent?.response;
    if (r.isError || data?.success === false)
      throw Error(
        r.content?.find((c) => c.type === "text")?.text || "Zen bridge failed",
      );
    return data?.data;
  }
  async function bind(win) {
    const { tabs } = await call("tab_list");
    const title = clean(win.title).replace(
      / — (Zen Browser|Mozilla Firefox)$/,
      "",
    );
    const matches = tabs.filter((t) => (t.current === true) && clean(t.title) === title);
    if (matches.length !== 1)
      throw Error(
        "Cannot bind this X11 window to the current browser tab; update mcp-zen or select this window explicitly",
      );
    // Read the actual current tab; observation must never activate another tab.
    return matches[0].targetId;
  }
  async function probe(win, req, binding) {
    const tab = await bind(win);
    if (binding?.tab && binding.tab !== tab)
      throw Error("Displayed browser tab changed; observe again");
    const r = await call("eval", {
      script: `(${domProbe.toString()})(${JSON.stringify(key)},${JSON.stringify(req)})`,
    });
    const data = r.result;
    if (!data?.visible) throw Error("Target browser document is not visible");
    const g = binding?.geometry;
    if (
      g &&
      (!Number.isFinite(data.outer.x) ||
        Math.abs(data.outer.x - g.x) > 30 ||
        Math.abs(data.outer.y - g.y) > 120 ||
        Math.abs(data.outer.width - g.width) > 30)
    )
      throw Error(
        "Browser/X11 coordinate mapping mismatch; no native input sent",
      );
    return { ...data, tab };
  }
  return {
    async discover(win, geometry, options = {}) {
      return probe(
        win,
        {
          op: "discover",
          scope: "viewport",
          filter: "",
          fields: ["text", "accessible_name", "alt", "title"],
          offset: 0,
          limit: 300,
          ...options,
        },
        { geometry },
      );
    },
    async resolve(win, binding, target, reveal = false) {
      return probe(
        win,
        {
          op: reveal ? "reveal" : "resolve",
          documentId: binding.documentId,
          ref: target.ref,
        },
        binding,
      );
    },
    async screenshot(win, fullPage) {
      const before = await probe(win, { op: "capture", fullPage });
      const result = await call("screenshot", { fullPage });
      const after = await probe(
        win,
        { op: "capture", fullPage },
        { tab: before.tab },
      );
      if (before.documentId !== after.documentId)
        throw Error("Document changed during capture");
      return result;
    },
    stop: async () => {
      await client?.close();
    },
  };
}
