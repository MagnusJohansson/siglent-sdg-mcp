import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { connection } from "../connection.js";

export function registerModulationTools(server: McpServer): void {
  server.tool(
    "get_modulation",
    "Get the modulation parameters of a channel. Returns all modulation settings including type, source, frequency, depth/deviation, and carrier parameters.",
    {
      channel: z.enum(["C1", "C2"]).describe("Channel to query"),
    },
    { readOnlyHint: true },
    async ({ channel }) => {
      try {
        const response = await connection.query(`${channel}:MDWV?`);
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
    "configure_modulation",
    "Configure modulation on a channel. Set state first (ON), then type and parameters. Commands are sent sequentially: state, then type, then type-specific parameters, then carrier parameters.",
    {
      channel: z.enum(["C1", "C2"]).describe("Channel to configure"),
      state: z
        .enum(["ON", "OFF"])
        .optional()
        .describe("Modulation state. Must be ON before setting other params."),
      type: z
        .enum(["AM", "DSBAM", "FM", "PM", "PWM", "ASK", "FSK", "PSK"])
        .optional()
        .describe("Modulation type"),
      source: z
        .enum(["INT", "EXT", "CH1", "CH2"])
        .optional()
        .describe("Modulation source (availability depends on type)"),
      mod_wave: z
        .enum(["SINE", "SQUARE", "TRIANGLE", "UPRAMP", "DNRAMP", "NOISE", "ARB"])
        .optional()
        .describe("Modulating waveform shape (only when source is INT)"),
      frequency: z
        .number()
        .optional()
        .describe("Modulation frequency in Hz (AM/FM/PM/PWM) or key frequency (ASK/FSK/PSK)"),
      depth: z
        .number()
        .optional()
        .describe("AM modulation depth in % (0-120)"),
      deviation: z
        .number()
        .optional()
        .describe("FM frequency deviation in Hz, or PM phase deviation in degrees (0-360), or PWM duty deviation in %"),
      hop_frequency: z
        .number()
        .optional()
        .describe("FSK hop frequency in Hz"),
      polarity: z
        .enum(["POS", "NEG"])
        .optional()
        .describe("PSK polarity"),
      carrier_waveform: z
        .enum(["SINE", "SQUARE", "RAMP", "ARB", "PULSE"])
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
      type,
      source,
      mod_wave,
      frequency,
      depth,
      deviation,
      hop_frequency,
      polarity,
      carrier_waveform,
      carrier_frequency,
      carrier_amplitude,
      carrier_offset,
      carrier_phase,
    }) => {
      try {
        const sent: string[] = [];

        // 1. Set state first
        if (state) {
          const cmd = `${channel}:MDWV STATE,${state}`;
          await connection.sendCommand(cmd);
          sent.push(cmd);
        }

        // 2. Set modulation type
        if (type) {
          const cmd = `${channel}:MDWV ${type}`;
          await connection.sendCommand(cmd);
          sent.push(cmd);
        }

        // 3. Set type-specific parameters
        const modType = type || "AM"; // Use provided type or default for param prefix
        if (source) {
          const cmd = `${channel}:MDWV ${modType},SRC,${source}`;
          await connection.sendCommand(cmd);
          sent.push(cmd);
        }
        if (mod_wave) {
          const cmd = `${channel}:MDWV ${modType},MDSP,${mod_wave}`;
          await connection.sendCommand(cmd);
          sent.push(cmd);
        }
        if (frequency !== undefined) {
          const freqParam = ["ASK", "FSK", "PSK"].includes(modType) ? "KFRQ" : "FRQ";
          const cmd = `${channel}:MDWV ${modType},${freqParam},${frequency}`;
          await connection.sendCommand(cmd);
          sent.push(cmd);
        }
        if (depth !== undefined) {
          const cmd = `${channel}:MDWV ${modType},DEPTH,${depth}`;
          await connection.sendCommand(cmd);
          sent.push(cmd);
        }
        if (deviation !== undefined) {
          const cmd = `${channel}:MDWV ${modType},DEVI,${deviation}`;
          await connection.sendCommand(cmd);
          sent.push(cmd);
        }
        if (hop_frequency !== undefined) {
          const cmd = `${channel}:MDWV FSK,HFRQ,${hop_frequency}`;
          await connection.sendCommand(cmd);
          sent.push(cmd);
        }
        if (polarity) {
          const cmd = `${channel}:MDWV PSK,PLRT,${polarity}`;
          await connection.sendCommand(cmd);
          sent.push(cmd);
        }

        // 4. Set carrier parameters
        if (carrier_waveform) {
          const cmd = `${channel}:MDWV CARR,WVTP,${carrier_waveform}`;
          await connection.sendCommand(cmd);
          sent.push(cmd);
        }
        if (carrier_frequency !== undefined) {
          const cmd = `${channel}:MDWV CARR,FRQ,${carrier_frequency}`;
          await connection.sendCommand(cmd);
          sent.push(cmd);
        }
        if (carrier_amplitude !== undefined) {
          const cmd = `${channel}:MDWV CARR,AMP,${carrier_amplitude}`;
          await connection.sendCommand(cmd);
          sent.push(cmd);
        }
        if (carrier_offset !== undefined) {
          const cmd = `${channel}:MDWV CARR,OFST,${carrier_offset}`;
          await connection.sendCommand(cmd);
          sent.push(cmd);
        }
        if (carrier_phase !== undefined) {
          const cmd = `${channel}:MDWV CARR,PHSE,${carrier_phase}`;
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
              text: `Modulation configured:\n${sent.join("\n")}`,
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
