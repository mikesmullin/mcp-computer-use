import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
export function createVisionClient({
  entry = process.env.MCP_VISION_ENTRY || "/workspace/mcp-vision/server.mjs",
} = {}) {
  let client;
  return {
    async call(name, args) {
      if (!client) {
        const c = new Client({ name: "computer-use-vision", version: "1" });
        try {
          await c.connect(
            new StdioClientTransport({
              command: process.execPath,
              args: [entry],
              env: process.env,
              stderr: "inherit",
            }),
          );
          client = c;
        } catch (e) {
          await c.close().catch(() => {});
          throw Error("mcp-vision unavailable: " + e.message);
        }
      }
      const r = await client.callTool({ name, arguments: args }, undefined, {
        timeout: 130000,
      });
      if (r.isError)
        throw Error(
          r.content?.find((c) => c.type === "text")?.text ||
            "Vision request failed",
        );
      return (
        r.structuredContent ||
        JSON.parse(r.content.find((c) => c.type === "text").text)
      );
    },
    async stop() {
      await client?.close();
    },
  };
}
