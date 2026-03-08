import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { connection } from "../connection.js";

export function registerArbitraryTools(server: McpServer): void {
  server.tool(
    "get_arbitrary_wave",
    "Get the current arbitrary waveform selection for a channel. Returns the waveform index and name.",
    {
      channel: z.enum(["C1", "C2"]).describe("Channel to query"),
    },
    { readOnlyHint: true },
    async ({ channel }) => {
      try {
        const response = await connection.query(`${channel}:ARWV?`);
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
    "set_arbitrary_wave",
    "Set the arbitrary waveform for a channel by index number or by name. Use index for built-in waveforms (e.g. 2=StairUp, 18=Sinc, 26=Cardiac) or name for user-defined waveforms.",
    {
      channel: z.enum(["C1", "C2"]).describe("Channel to configure"),
      index: z
        .number()
        .optional()
        .describe(
          "Index of the built-in arbitrary waveform (0-198). Examples: 0=Sine, 2=StairUp, 10=ExpFal, 18=Sinc, 19=Gaussian, 26=Cardiac"
        ),
      name: z
        .string()
        .optional()
        .describe(
          'Name of the waveform (for user-defined waves, use quotes). Can also be a path like "Local/wave1.bin"'
        ),
    },
    { readOnlyHint: false },
    async ({ channel, index, name }) => {
      try {
        if (index === undefined && !name) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: Either 'index' or 'name' must be specified.",
              },
            ],
            isError: true,
          };
        }

        let cmd: string;
        if (index !== undefined) {
          cmd = `${channel}:ARWV INDEX,${index}`;
        } else {
          cmd = `${channel}:ARWV NAME,"${name}"`;
        }

        await connection.sendCommand(cmd);
        return {
          content: [
            {
              type: "text" as const,
              text: `Arbitrary wave set: ${cmd}`,
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
