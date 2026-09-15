/**
 * Test harness: a real MCP client talking to createServer() over an in-memory
 * transport. This exercises the SDK's input validation, our handler, and the
 * SDK's output-schema validation exactly as a production client would.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";

export interface ToolCallResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}

export async function connectTestClient(): Promise<{
  client: Client;
  callTool: (name: string, args: Record<string, unknown>) => Promise<ToolCallResult>;
  close: () => Promise<void>;
}> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);

  const client = new Client({ name: "hokuz-test-client", version: "0.0.0" });
  await client.connect(clientTransport);

  return {
    client,
    callTool: async (name, args) =>
      (await client.callTool({ name, arguments: args })) as ToolCallResult,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Text of the first content block, for assertions on the human-readable reply. */
export function firstText(result: ToolCallResult): string {
  return result.content[0]?.text ?? "";
}
