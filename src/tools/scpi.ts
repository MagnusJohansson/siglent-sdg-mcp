import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { connection } from "../connection.js";

export function registerScpiTools(server: McpServer): void {
  server.tool(
    "scpi_query",
    "Send an arbitrary SCPI query to the waveform generator and return the response. Use this as an escape hatch for commands not covered by other tools. Note: CHDR is set to OFF, so responses contain only values (no headers).",
    {
      command: z
        .string()
        .describe(
          "SCPI query command to send (e.g. '*IDN?', 'C1:BSWV?', 'C1:OUTP?')"
        ),
      timeout_ms: z
        .number()
        .optional()
        .describe("Timeout in milliseconds (default 5000)"),
    },
    { readOnlyHint: true },
    async ({ command, timeout_ms }) => {
      try {
        const response = await connection.query(
          command,
          timeout_ms || undefined
        );
        return {
          content: [
            {
              type: "text" as const,
              text: response,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "scpi_command",
    "Send an arbitrary SCPI command to the waveform generator (no response expected). Use this as an escape hatch for commands not covered by other tools.",
    {
      command: z
        .string()
        .describe(
          "SCPI command to send (e.g. '*RST', 'C1:OUTP ON', 'C1:BSWV WVTP,SINE')"
        ),
    },
    { readOnlyHint: false },
    async ({ command }) => {
      try {
        await connection.sendCommand(command);
        return {
          content: [
            {
              type: "text" as const,
              text: `Command sent: ${command}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
