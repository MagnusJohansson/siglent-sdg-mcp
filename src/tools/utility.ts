import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { connection } from "../connection.js";

export function registerUtilityTools(server: McpServer): void {
  server.tool(
    "reset",
    "Reset the waveform generator to factory default settings (*RST).",
    {},
    { readOnlyHint: false },
    async () => {
      try {
        await connection.sendCommand("*RST");
        return {
          content: [
            {
              type: "text" as const,
              text: "Device reset to factory defaults.",
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
    "copy_channel",
    "Copy all parameters from one channel to another.",
    {
      source: z.enum(["C1", "C2"]).describe("Source channel to copy from"),
      destination: z.enum(["C1", "C2"]).describe("Destination channel to copy to"),
    },
    { readOnlyHint: false },
    async ({ source, destination }) => {
      try {
        if (source === destination) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: Source and destination channels must be different.",
              },
            ],
            isError: true,
          };
        }
        await connection.sendCommand(`PACP ${destination},${source}`);
        return {
          content: [
            {
              type: "text" as const,
              text: `Parameters copied from ${source} to ${destination}.`,
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
    "configure_sync",
    "Configure the sync output signal for a channel.",
    {
      channel: z.enum(["C1", "C2"]).describe("Channel to configure"),
      state: z.enum(["ON", "OFF"]).describe("Sync output state"),
      type: z
        .enum(["CH1", "CH2", "MOD_CH1", "MOD_CH2"])
        .optional()
        .describe("Sync source type"),
    },
    { readOnlyHint: false },
    async ({ channel, state, type }) => {
      try {
        let cmd = `${channel}:SYNC ${state}`;
        if (type) {
          cmd += `,TYPE,${type}`;
        }
        await connection.sendCommand(cmd);
        return {
          content: [
            {
              type: "text" as const,
              text: `Sync configured: ${cmd}`,
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
    "equal_phase",
    "Synchronize the phase of both channels (EQPHASE). Aligns the phase relationship between C1 and C2.",
    {},
    { readOnlyHint: false },
    async () => {
      try {
        await connection.sendCommand("EQPHASE");
        return {
          content: [
            {
              type: "text" as const,
              text: "Phase synchronized between channels.",
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
