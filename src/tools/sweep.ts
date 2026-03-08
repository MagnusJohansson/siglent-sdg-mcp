import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { connection } from "../connection.js";

export function registerSweepTools(server: McpServer): void {
  server.tool(
    "get_sweep",
    "Get the sweep parameters of a channel, including state, time, start/stop frequencies, sweep mode, direction, trigger source, carrier settings, and marker.",
    {
      channel: z.enum(["C1", "C2"]).describe("Channel to query"),
    },
    { readOnlyHint: true },
    async ({ channel }) => {
      try {
        const response = await connection.query(`${channel}:SWWV?`);
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
    "configure_sweep",
    "Configure sweep on a channel. State must be set to ON before other parameters. Builds a single SWWV command with all specified parameters.",
    {
      channel: z.enum(["C1", "C2"]).describe("Channel to configure"),
      state: z
        .enum(["ON", "OFF"])
        .optional()
        .describe("Sweep state. Must be ON before setting other params."),
      time: z
        .number()
        .optional()
        .describe("Sweep time in seconds"),
      start: z
        .number()
        .optional()
        .describe("Start frequency in Hz"),
      stop: z
        .number()
        .optional()
        .describe("Stop frequency in Hz"),
      center: z
        .number()
        .optional()
        .describe("Center frequency in Hz"),
      span: z
        .number()
        .optional()
        .describe("Frequency span in Hz"),
      sweep_mode: z
        .enum(["LINE", "LOG", "STEP"])
        .optional()
        .describe("Sweep mode: LINE (linear), LOG (logarithmic), or STEP"),
      direction: z
        .enum(["UP", "DOWN", "UP_DOWN"])
        .optional()
        .describe("Sweep direction"),
      trigger_source: z
        .enum(["EXT", "INT", "MAN"])
        .optional()
        .describe("Trigger source: EXT (external), INT (internal), MAN (manual)"),
      trigger_out: z
        .enum(["ON", "OFF"])
        .optional()
        .describe("Trigger output state"),
      trigger_edge: z
        .enum(["RISE", "FALL"])
        .optional()
        .describe("Trigger edge (only for EXT or MAN trigger source)"),
      start_hold_time: z
        .number()
        .optional()
        .describe("Start hold time in seconds (0-300)"),
      end_hold_time: z
        .number()
        .optional()
        .describe("End hold time in seconds (0-300)"),
      return_time: z
        .number()
        .optional()
        .describe("Return time in seconds (0-300)"),
      symmetry: z
        .number()
        .optional()
        .describe("Symmetry in % (0-100) when direction is UP_DOWN"),
      marker_state: z
        .enum(["ON", "OFF"])
        .optional()
        .describe("Frequency marker state"),
      marker_frequency: z
        .number()
        .optional()
        .describe("Marker frequency in Hz"),
      manual_trigger: z
        .boolean()
        .optional()
        .describe("Send a manual trigger (only when trigger source is MAN)"),
      carrier_waveform: z
        .enum(["SINE", "SQUARE", "RAMP", "ARB"])
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
    },
    { readOnlyHint: false },
    async ({
      channel,
      state,
      time,
      start,
      stop,
      center,
      span,
      sweep_mode,
      direction,
      trigger_source,
      trigger_out,
      trigger_edge,
      start_hold_time,
      end_hold_time,
      return_time,
      symmetry,
      marker_state,
      marker_frequency,
      manual_trigger,
      carrier_waveform,
      carrier_frequency,
      carrier_amplitude,
      carrier_offset,
      carrier_phase,
    }) => {
      try {
        const sent: string[] = [];

        // State must be set first and separately
        if (state) {
          const cmd = `${channel}:SWWV STATE,${state}`;
          await connection.sendCommand(cmd);
          sent.push(cmd);
        }

        // Build remaining parameters as a single command
        const parts: string[] = [];
        if (time !== undefined) parts.push(`TIME,${time}`);
        if (start !== undefined) parts.push(`START,${start}`);
        if (stop !== undefined) parts.push(`STOP,${stop}`);
        if (center !== undefined) parts.push(`CENTER,${center}`);
        if (span !== undefined) parts.push(`SPAN,${span}`);
        if (sweep_mode) parts.push(`SWMD,${sweep_mode}`);
        if (direction) parts.push(`DIR,${direction}`);
        if (trigger_source) parts.push(`TRSR,${trigger_source}`);
        if (trigger_out) parts.push(`TRMD,${trigger_out}`);
        if (trigger_edge) parts.push(`EDGE,${trigger_edge}`);
        if (start_hold_time !== undefined) parts.push(`STARTTIME,${start_hold_time}`);
        if (end_hold_time !== undefined) parts.push(`ENDTIME,${end_hold_time}`);
        if (return_time !== undefined) parts.push(`BACKTIME,${return_time}`);
        if (symmetry !== undefined) parts.push(`SYM,${symmetry}`);
        if (marker_state) parts.push(`MARK_STATE,${marker_state}`);
        if (marker_frequency !== undefined) parts.push(`MARK_FREQ,${marker_frequency}`);
        if (carrier_waveform) parts.push(`CARR,WVTP,${carrier_waveform}`);
        if (carrier_frequency !== undefined) parts.push(`CARR,FRQ,${carrier_frequency}`);
        if (carrier_amplitude !== undefined) parts.push(`CARR,AMP,${carrier_amplitude}`);
        if (carrier_offset !== undefined) parts.push(`CARR,OFST,${carrier_offset}`);
        if (carrier_phase !== undefined) parts.push(`CARR,PHSE,${carrier_phase}`);

        if (parts.length > 0) {
          const cmd = `${channel}:SWWV ${parts.join(",")}`;
          await connection.sendCommand(cmd);
          sent.push(cmd);
        }

        // Manual trigger is sent separately
        if (manual_trigger) {
          const cmd = `${channel}:SWWV MTRIG`;
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
              text: `Sweep configured:\n${sent.join("\n")}`,
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
