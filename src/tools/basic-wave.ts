import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { connection } from "../connection.js";

export function registerBasicWaveTools(server: McpServer): void {
  server.tool(
    "get_basic_wave",
    "Get the basic waveform parameters of a channel, including waveform type, frequency, amplitude, offset, phase, duty cycle, etc.",
    {
      channel: z.enum(["C1", "C2"]).describe("Channel to query"),
    },
    { readOnlyHint: true },
    async ({ channel }) => {
      try {
        const response = await connection.query(`${channel}:BSWV?`);
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
    "configure_basic_wave",
    "Configure the basic waveform parameters of a channel. Multiple parameters can be set in a single call. The command builds a single BSWV command with all specified parameters.",
    {
      channel: z.enum(["C1", "C2"]).describe("Channel to configure"),
      waveform_type: z
        .enum(["SINE", "SQUARE", "RAMP", "PULSE", "NOISE", "ARB", "DC", "PRBS"])
        .optional()
        .describe("Waveform type"),
      frequency: z
        .number()
        .optional()
        .describe("Frequency in Hz (not valid for NOISE or DC)"),
      period: z
        .number()
        .optional()
        .describe("Period in seconds (alternative to frequency)"),
      amplitude: z
        .number()
        .optional()
        .describe("Amplitude in Vpp (not valid for NOISE or DC)"),
      amplitude_vrms: z
        .number()
        .optional()
        .describe("Amplitude in Vrms"),
      offset: z
        .number()
        .optional()
        .describe("DC offset in volts (not valid for NOISE)"),
      phase: z
        .number()
        .optional()
        .describe("Phase in degrees (0-360, not valid for NOISE, PULSE, or DC)"),
      duty: z
        .number()
        .optional()
        .describe("Duty cycle in % (only for SQUARE or PULSE)"),
      symmetry: z
        .number()
        .optional()
        .describe("Symmetry in % (0-100, only for RAMP)"),
      width: z
        .number()
        .optional()
        .describe("Pulse width in seconds (only for PULSE)"),
      rise: z
        .number()
        .optional()
        .describe("Rise time in seconds (only for PULSE)"),
      fall: z
        .number()
        .optional()
        .describe("Fall time in seconds (only for PULSE)"),
      delay: z
        .number()
        .optional()
        .describe("Waveform delay in seconds"),
      stdev: z
        .number()
        .optional()
        .describe("Standard deviation in volts (only for NOISE)"),
      mean: z
        .number()
        .optional()
        .describe("Mean in volts (only for NOISE)"),
      high_level: z
        .number()
        .optional()
        .describe("High level in volts"),
      low_level: z
        .number()
        .optional()
        .describe("Low level in volts"),
    },
    { readOnlyHint: false },
    async ({
      channel,
      waveform_type,
      frequency,
      period,
      amplitude,
      amplitude_vrms,
      offset,
      phase,
      duty,
      symmetry,
      width,
      rise,
      fall,
      delay,
      stdev,
      mean,
      high_level,
      low_level,
    }) => {
      try {
        const parts: string[] = [];
        if (waveform_type) parts.push(`WVTP,${waveform_type}`);
        if (frequency !== undefined) parts.push(`FRQ,${frequency}`);
        if (period !== undefined) parts.push(`PERI,${period}`);
        if (amplitude !== undefined) parts.push(`AMP,${amplitude}`);
        if (amplitude_vrms !== undefined) parts.push(`AMPVRMS,${amplitude_vrms}`);
        if (offset !== undefined) parts.push(`OFST,${offset}`);
        if (phase !== undefined) parts.push(`PHSE,${phase}`);
        if (duty !== undefined) parts.push(`DUTY,${duty}`);
        if (symmetry !== undefined) parts.push(`SYM,${symmetry}`);
        if (width !== undefined) parts.push(`WIDTH,${width}`);
        if (rise !== undefined) parts.push(`RISE,${rise}`);
        if (fall !== undefined) parts.push(`FALL,${fall}`);
        if (delay !== undefined) parts.push(`DLY,${delay}`);
        if (stdev !== undefined) parts.push(`STDEV,${stdev}`);
        if (mean !== undefined) parts.push(`MEAN,${mean}`);
        if (high_level !== undefined) parts.push(`HLEV,${high_level}`);
        if (low_level !== undefined) parts.push(`LLEV,${low_level}`);

        if (parts.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: At least one parameter must be specified.",
              },
            ],
            isError: true,
          };
        }

        const cmd = `${channel}:BSWV ${parts.join(",")}`;
        await connection.sendCommand(cmd);
        return {
          content: [
            {
              type: "text" as const,
              text: `Basic wave configured: ${cmd}`,
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
