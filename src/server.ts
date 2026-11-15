import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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

export const SERVER_VERSION = "2.0.7";

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
