#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DeskApiError, DeskClient } from "./client.js";
import { TOOLS } from "./tools.js";

export function createServer(client: DeskClient = new DeskClient()): McpServer {
  const server = new McpServer({ name: "secret-desk", version: "0.1.0" });
  for (const tool of TOOLS) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, async (input: Record<string, unknown>) => {
      try {
        const result = await tool.run(client, input);
        return { content: [{ type: "text" as const, text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] };
      } catch (err) {
        const message = err instanceof DeskApiError ? `${err.message}${err.status ? ` (HTTP ${err.status})` : ""}` : (err as Error).message;
        return { isError: true, content: [{ type: "text" as const, text: message }] };
      }
    });
  }
  return server;
}

async function start(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
