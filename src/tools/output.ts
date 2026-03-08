import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { connection } from "../connection.js";

export function registerOutputTools(server: McpServer): void {
  server.tool(
    "get_output",
    "Get the output state of a channel, including on/off status, load impedance, and polarity.",
    {
      channel: z.enum(["C1", "C2"]).describe("Channel to query"),
    },
    { readOnlyHint: true },
    async ({ channel }) => {
      try {
        const response = await connection.query(`${channel}:OUTP?`);
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
    "configure_output",
    "Configure the output of a channel. Can turn output on/off, set load impedance, and set polarity.",
    {
      channel: z.enum(["C1", "C2"]).describe("Channel to configure"),
      state: z
        .enum(["ON", "OFF"])
        .optional()
        .describe("Output state: ON or OFF"),
      load: z
        .string()
        .optional()
        .describe(
          "Load impedance in ohms (50-100000) or 'HZ' for high impedance"
        ),
      polarity: z
        .enum(["NOR", "INVT"])
        .optional()
        .describe("Output polarity: NOR (normal) or INVT (inverted)"),
    },
    { readOnlyHint: false },
    async ({ channel, state, load, polarity }) => {
      try {
        const parts: string[] = [];
        if (state) parts.push(state);
        if (load) parts.push(`LOAD,${load}`);
        if (polarity) parts.push(`PLRT,${polarity}`);

        if (parts.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: At least one parameter (state, load, polarity) must be specified.",
              },
            ],
            isError: true,
          };
        }

        await connection.sendCommand(
          `${channel}:OUTP ${parts.join(",")}`
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `Output configured: ${channel}:OUTP ${parts.join(",")}`,
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
