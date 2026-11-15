import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { audit, type ToolAnnotations } from "./audit/audit.js";
import { auditTransport } from "./audit/transport.js";
import type { ServerConfig } from "./config.js";
import { connection } from "./connection.js";
import { registerConnectionTools } from "./tools/connection.js";
import { registerOutputTools } from "./tools/output.js";
import { registerBasicWaveTools } from "./tools/basic-wave.js";
import { registerModulationTools } from "./tools/modulation.js";
import { registerSweepTools } from "./tools/sweep.js";
import { registerBurstTools } from "./tools/burst.js";
import { registerArbitraryTools } from "./tools/arbitrary.js";
import { registerUtilityTools } from "./tools/utility.js";
import { registerScpiTools } from "./tools/scpi.js";

export const SERVER_VERSION = "2.1.0";

/** Build the MCP server with all tools registered under the given configuration. */
export function createServer(config: ServerConfig): McpServer {
  // The connection enforces the host policy on every connect path
  // (the connect tool and auto-connect). It's one process-wide connection,
  // so this configures it for every server in the process: one server per
  // process, or the last one created sets the policy for all of them.
  connection.configure({ hostPolicy: config.hostPolicy, defaultPort: config.defaultPort });

  const server = new McpServer({
    name: "siglent-sdg-mcp",
    version: SERVER_VERSION,
  });
  recordToolAnnotations(server);

  registerConnectionTools(server, config);
  registerOutputTools(server);
  registerBasicWaveTools(server);
  registerModulationTools(server);
  registerSweepTools(server);
  registerBurstTools(server);
  registerArbitraryTools(server);
  registerUtilityTools(server);
  registerScpiTools(server, config);

  return server;
}

/**
 * Connect a server to a transport with the audit hooks installed. The hooks
 * must go in before server.connect() (see src/audit/transport.ts), so every
 * caller uses this instead of server.connect().
 */
export async function connectServer(server: McpServer, transport: Transport, config: ServerConfig): Promise<void> {
  auditTransport(transport, { rawScpiEnabled: config.rawScpiEnabled });
  await server.connect(transport);
}

/**
 * Record each tool's annotations as it's registered: state-changing tools
 * (readOnlyHint: false) are audited at the security level. Every tool here is
 * registered as server.tool(name, description, schema, annotations, callback).
 */
function recordToolAnnotations(server: McpServer): void {
  const register = server.tool.bind(server) as (...args: unknown[]) => unknown;
  (server as unknown as { tool: (...args: unknown[]) => unknown }).tool = (...args: unknown[]) => {
    const annotations = args
      .slice(1, -1)
      .find(
        (a): a is ToolAnnotations =>
          typeof a === "object" && a !== null && ("readOnlyHint" in a || "destructiveHint" in a)
      );
    audit.registerTool(String(args[0]), annotations);
    return register(...args);
  };
}
