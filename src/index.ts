#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerConnectionTools } from "./tools/connection.js";
import { registerOutputTools } from "./tools/output.js";
import { registerBasicWaveTools } from "./tools/basic-wave.js";
import { registerModulationTools } from "./tools/modulation.js";
import { registerSweepTools } from "./tools/sweep.js";
import { registerBurstTools } from "./tools/burst.js";
import { registerArbitraryTools } from "./tools/arbitrary.js";
import { registerUtilityTools } from "./tools/utility.js";
import { registerScpiTools } from "./tools/scpi.js";
import { connection } from "./connection.js";

// Prevent uncaught errors from killing the MCP server process
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

const server = new McpServer({
  name: "siglent-sdg-mcp",
  version: "1.0.0",
});

// Register all tool groups
registerConnectionTools(server);
registerOutputTools(server);
registerBasicWaveTools(server);
registerModulationTools(server);
registerSweepTools(server);
registerBurstTools(server);
registerArbitraryTools(server);
registerUtilityTools(server);
registerScpiTools(server);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("siglent-sdg-mcp server running on stdio");

  // Auto-connect if env var is set (fire-and-forget, don't block MCP startup)
  const autoIp =
    process.env.SIGLENT_SDG_IP || process.env.SIGLENT_IP;
  if (autoIp) {
    const port = parseInt(
      process.env.SIGLENT_SDG_PORT || process.env.SIGLENT_PORT || "5025",
      10
    );
    connection.connect(autoIp, port).then(
      (idn) => console.error(`Auto-connected to ${autoIp}: ${idn}`),
      (err) => {
        console.error(
          `Auto-connect to ${autoIp} failed: ${err instanceof Error ? err.message : String(err)}`
        );
        console.error("Use the 'connect' tool to connect manually.");
      }
    );
  }
}

main().catch((error) => {
  console.error("Startup error:", error);
});
