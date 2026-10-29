#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DeskApiError, DeskClient } from "./client.js";
import { TOOLS } from "./tools.js";

/** Version aus der package.json dieses Pakets (Handshake meldet name und version). */
export function packageVersion(): string {
  try {
    return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function createServer(client: DeskClient = new DeskClient()): McpServer {
  const server = new McpServer({ name: "secret-desk", version: packageVersion() });
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

/** true, wenn diese Datei direkt gestartet wurde. Vergleicht file-URLs (Windows: file:///C:/..., Symlinks aufgeloest). */
export function isMainModule(metaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  try {
    return metaUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  start().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
