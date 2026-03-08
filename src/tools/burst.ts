import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { connection } from "../connection.js";

export function registerBurstTools(server: McpServer): void {
  server.tool(
    "get_burst",
    "Get the burst wave parameters of a channel, including state, period, trigger source, burst mode (gate/ncycle), cycle count, carrier settings, and delay.",
    {
      channel: z.enum(["C1", "C2"]).describe("Channel to query"),
    },
    { readOnlyHint: true },
    async ({ channel }) => {
      try {
        const response = await connection.query(`${channel}:BTWV?`);
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
    "configure_burst",
    "Configure burst mode on a channel. State must be set to ON before other parameters. Builds a single BTWV command with all specified parameters.",
    {
      channel: z.enum(["C1", "C2"]).describe("Channel to configure"),
      state: z
        .enum(["ON", "OFF"])
        .optional()
        .describe("Burst state. Must be ON before setting other params."),
      period: z
        .number()
        .optional()
        .describe("Burst period in seconds"),
      start_phase: z
        .number()
        .optional()
        .describe("Start phase in degrees (0-360)"),
      burst_mode: z
        .enum(["GATE", "NCYC"])
        .optional()
        .describe("Burst mode: GATE or NCYC (N-cycle)"),
      trigger_source: z
        .enum(["EXT", "INT", "MAN"])
        .optional()
        .describe("Trigger source"),
      trigger_out: z
        .enum(["RISE", "FALL", "OFF"])
        .optional()
        .describe("Trigger output mode (when NCYC and INT/MAN)"),
      trigger_edge: z
        .enum(["RISE", "FALL"])
        .optional()
        .describe("Trigger edge (when EXT or MAN)"),
      cycles: z
        .string()
        .optional()
        .describe("Number of burst cycles (integer, or 'INF' for infinite)"),
      delay: z
        .number()
        .optional()
        .describe("Trigger delay in seconds (when NCYC mode)"),
      gate_polarity: z
        .enum(["NEG", "POS"])
        .optional()
        .describe("Gate polarity (when GATE mode)"),
      manual_trigger: z
        .boolean()
        .optional()
        .describe("Send a manual trigger (only when trigger source is MAN)"),
      carrier_waveform: z
        .enum(["SINE", "SQUARE", "RAMP", "ARB", "PULSE", "NOISE"])
        .optional()
        .describe("Carrier waveform type"),
      carrier_frequency: z
        .number()
        .optional()
        .describe("Carrier frequency in Hz"),
      carrier_amplitude: z
        .number()
        .optional()
        .describe("Carrier amplitude in Vpp"),
      carrier_offset: z
        .number()
        .optional()
        .describe("Carrier DC offset in volts"),
      carrier_phase: z
        .number()
        .optional()
        .describe("Carrier phase in degrees (0-360)"),
      carrier_duty: z
        .number()
        .optional()
        .describe("Carrier duty cycle in % (for SQUARE or PULSE)"),
      carrier_symmetry: z
        .number()
        .optional()
        .describe("Carrier symmetry in % (for RAMP)"),
    },
    { readOnlyHint: false },
    async ({
      channel,
      state,
      period,
      start_phase,
      burst_mode,
      trigger_source,
      trigger_out,
      trigger_edge,
      cycles,
      delay,
      gate_polarity,
      manual_trigger,
      carrier_waveform,
      carrier_frequency,
      carrier_amplitude,
      carrier_offset,
      carrier_phase,
      carrier_duty,
      carrier_symmetry,
    }) => {
      try {
        const sent: string[] = [];

        // State must be set first and separately
        if (state) {
          const cmd = `${channel}:BTWV STATE,${state}`;
          await connection.sendCommand(cmd);
          sent.push(cmd);
        }

        // Build remaining parameters
        const parts: string[] = [];
        if (period !== undefined) parts.push(`PRD,${period}`);
        if (start_phase !== undefined) parts.push(`STPS,${start_phase}`);
        if (burst_mode) parts.push(`GATE_NCYC,${burst_mode}`);
        if (trigger_source) parts.push(`TRSR,${trigger_source}`);
        if (trigger_out) parts.push(`TRMD,${trigger_out}`);
        if (trigger_edge) parts.push(`EDGE,${trigger_edge}`);
        if (cycles !== undefined) parts.push(`TIME,${cycles}`);
        if (delay !== undefined) parts.push(`DLAY,${delay}`);
        if (gate_polarity) parts.push(`PLRT,${gate_polarity}`);
        if (carrier_waveform) parts.push(`CARR,WVTP,${carrier_waveform}`);
        if (carrier_frequency !== undefined) parts.push(`CARR,FRQ,${carrier_frequency}`);
        if (carrier_amplitude !== undefined) parts.push(`CARR,AMP,${carrier_amplitude}`);
        if (carrier_offset !== undefined) parts.push(`CARR,OFST,${carrier_offset}`);
        if (carrier_phase !== undefined) parts.push(`CARR,PHSE,${carrier_phase}`);
        if (carrier_duty !== undefined) parts.push(`CARR,DUTY,${carrier_duty}`);
        if (carrier_symmetry !== undefined) parts.push(`CARR,SYM,${carrier_symmetry}`);

        if (parts.length > 0) {
          const cmd = `${channel}:BTWV ${parts.join(",")}`;
          await connection.sendCommand(cmd);
          sent.push(cmd);
        }

        // Manual trigger sent separately
        if (manual_trigger) {
          const cmd = `${channel}:BTWV MTRIG`;
          await connection.sendCommand(cmd);
          sent.push(cmd);
        }

        if (sent.length === 0) {
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

        return {
          content: [
            {
              type: "text" as const,
              text: `Burst configured:\n${sent.join("\n")}`,
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
