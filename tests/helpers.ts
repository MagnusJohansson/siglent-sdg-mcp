import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { audit, type AuditLevel, type AuditRecord, type AuditSink } from "../src/audit/audit.js";
import { loadConfig } from "../src/config.js";
import { connection } from "../src/connection.js";
import { connectServer, createServer } from "../src/server.js";

/** Start the real MCP server with config built from the given env, linked to an in-memory client. */
export async function createTestServer(env: Record<string, string> = {}) {
  const config = loadConfig(env);
  const server = createServer(config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), connectServer(server, serverTransport, config)]);

  return {
    client,
    config,
    async cleanup() {
      connection.disconnect();
      await client.close();
      await server.close();
    },
  };
}

export async function callTool(client: Client, name: string, args: Record<string, unknown> = {}) {
  return client.callTool({ name, arguments: args });
}

export function getText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.find((c) => c.type === "text")?.text ?? "";
}

/** An audit sink that keeps records in memory. */
export class MemorySink implements AuditSink {
  readonly records: AuditRecord[] = [];
  constructor(
    readonly name = "memory",
    readonly level: AuditLevel = "full"
  ) {}
  write(record: AuditRecord): boolean {
    this.records.push(record);
    return true;
  }
  events(name: string): AuditRecord[] {
    return this.records.filter((r) => r["event.name"] === name);
  }
  clear(): void {
    this.records.length = 0;
  }
}

/** Send the audit log to memory sinks for the current test file. */
export function captureAudit(...sinks: AuditSink[]): void {
  audit.reset();
  audit.configure({ service: { name: "siglent-sdg-mcp", version: "test" }, sinks });
}
