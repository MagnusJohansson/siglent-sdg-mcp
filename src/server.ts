import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerConfig } from "./config.js";
import { registerConnectionTools } from "./tools/connection.js";
import { registerOutputTools } from "./tools/output.js";
import { registerBasicWaveTools } from "./tools/basic-wave.js";
import { registerModulationTools } from "./tools/modulation.js";
import { registerSweepTools } from "./tools/sweep.js";
import { registerBurstTools } from "./tools/burst.js";
import { registerArbitraryTools } from "./tools/arbitrary.js";
import { registerUtilityTools } from "./tools/utility.js";
import { registerScpiTools } from "./tools/scpi.js";

export const SERVER_VERSION = "2.0.1";

/** Build the MCP server with all tools registered under the given configuration. */
export function createServer(config: ServerConfig): McpServer {
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
