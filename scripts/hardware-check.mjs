#!/usr/bin/env node
/**
 * Hardware check against a real Siglent SDG, through the built server over
 * stdio (the same path an MCP client uses).
 *
 * Usage:  npm run build && node scripts/hardware-check.mjs <instrument-ip>
 *
 * SAFETY
 * - Never asks for an output to be turned ON, not even as an attack payload:
 *   injection probes try to change the frequency to 1234 Hz instead, which is
 *   harmless and easy to read back. If a guard regresses, the worst case is a
 *   changed frequency, not an energized output.
 * - Safety net: the output state is read after every probe. If it is ever ON,
 *   the script switches it OFF immediately and aborts.
 * - Aborts unless BOTH outputs are OFF: with channel coupling or tracking
 *   enabled on the instrument, a C1 change can propagate to C2. Works on C1
 *   only, amplitude 1 Vpp.
 * - Changes C1 waveform, load and burst settings. Restore them from the
 *   front panel afterwards if needed.
 *
 * Security checks verify the instrument state by reading it back, not just
 * by looking at the error the server returned.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ip = process.argv[2];
if (!ip) {
  console.error("Usage: node scripts/hardware-check.mjs <instrument-ip>");
  process.exit(2);
}
const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "build", "index.js");

let passed = 0;
let failed = 0;
function check(label, ok, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  [${detail}]` : ""}`);
}

async function startServer(extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { PATH: process.env.PATH ?? "", SIGLENT_SDG_IP: ip, ...extraEnv },
    stderr: "pipe",
  });
  const client = new Client({ name: "hardware-check", version: "1.0.0" });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    try {
      const r = await client.callTool({ name, arguments: args });
      return { ok: !r.isError, text: r.content?.[0]?.text ?? "" };
    } catch (err) {
      return { ok: false, text: err instanceof Error ? err.message : String(err) };
    }
  };
  // Auto-connect runs in the background; connect explicitly to be deterministic.
  const conn = await call("connect");
  return { client, call, conn };
}

/** Read a channel's output state; returns "ON", "OFF" or the raw text if unparseable. */
async function outputState(call, channel = "C1") {
  const r = await call("get_output", { channel });
  const m = /OUTP\s+(ON|OFF)|^(ON|OFF)/.exec(r.text);
  return m ? m[1] ?? m[2] : r.text;
}

/**
 * Safety net: if either output is anything but OFF, switch both off and abort.
 * Both are checked because coupling/tracking can carry a C1 change to C2.
 */
async function assertOffOrAbort(s, context) {
  const states = { C1: await outputState(s.call, "C1"), C2: await outputState(s.call, "C2") };
  if (states.C1 === "OFF" && states.C2 === "OFF") return;
  await s.call("configure_output", { channel: "C1", state: "OFF" });
  await s.call("configure_output", { channel: "C2", state: "OFF" });
  console.log(`\n  ABORT: outputs read C1=${states.C1}, C2=${states.C2} after ${context}. Switched both OFF.`);
  await s.client.close();
  process.exit(1);
}

/** Read C1 frequency from the basic-wave settings. */
async function frequency(call) {
  const r = await call("get_basic_wave", { channel: "C1" });
  return /FRQ,([0-9.eE+-]+)HZ/i.exec(r.text)?.[1];
}

async function main() {
  console.log(`Hardware check: ${ip}\n`);

  // ---------------------------------------------------------------- default
  console.log("1. Default configuration (raw SCPI off)");
  let s = await startServer();
  check("connect + identify", s.conn.ok && /SDG/i.test(s.conn.text), s.conn.text.split("\n").pop());
  if (!s.conn.ok) throw new Error("Cannot connect; aborting.");

  const initial = { C1: await outputState(s.call, "C1"), C2: await outputState(s.call, "C2") };
  if (initial.C1 !== "OFF" || initial.C2 !== "OFF") {
    console.log(
      `\n  ABORT: outputs are C1=${initial.C1}, C2=${initial.C2}. Both must be OFF ` +
        "(coupling or tracking can carry C1 changes to C2). Turn them OFF and re-run."
    );
    await s.client.close();
    process.exit(1);
  }
  console.log(`  info  both outputs OFF; C1 initial BSWV: ${(await s.call("get_basic_wave", { channel: "C1" })).text}`);

  // Functional regression: the hardware accepts what the tools generate.
  console.log("\n  Functional");
  let r = await s.call("configure_basic_wave", { channel: "C1", waveform_type: "SINE", frequency: 1000, amplitude: 1, offset: 0 });
  let rb = (await s.call("get_basic_wave", { channel: "C1" })).text;
  check("configure_basic_wave SINE 1 kHz 1 Vpp", r.ok && /SINE/.test(rb) && /FRQ,1000HZ/i.test(rb) && /AMP,1V/i.test(rb), rb);

  r = await s.call("configure_output", { channel: "C1", load: "50" });
  rb = (await s.call("get_output", { channel: "C1" })).text;
  check("configure_output load 50", r.ok && /LOAD,50/.test(rb), rb);

  r = await s.call("configure_output", { channel: "C1", load: "HZ" });
  rb = (await s.call("get_output", { channel: "C1" })).text;
  check("configure_output load HZ", r.ok && /LOAD,HZ/i.test(rb), rb);

  r = await s.call("configure_burst", { channel: "C1", state: "ON", burst_mode: "NCYC", cycles: "5" });
  rb = (await s.call("get_burst", { channel: "C1" })).text;
  check("configure_burst NCYC 5 cycles", r.ok && /TIME,5\b/.test(rb), rb);
  await s.call("configure_burst", { channel: "C1", state: "OFF" });

  r = await s.call("set_arbitrary_wave", { channel: "C1", index: 2 });
  rb = (await s.call("get_arbitrary_wave", { channel: "C1" })).text;
  check("set_arbitrary_wave index 2", r.ok && /INDEX,2\b/.test(rb), rb);
  await s.call("configure_basic_wave", { channel: "C1", waveform_type: "SINE" });

  r = await s.call("scpi_query", { command: "C1:BSWV?" });
  check("scpi_query C1:BSWV?", r.ok && /WVTP/.test(r.text), r.text.slice(0, 60));

  // Security: rejected AND the instrument state is unchanged. The payload is a
  // harmless frequency change (1000 Hz -> 1234 Hz), never "output ON".
  console.log("\n  Security (payload: change frequency to 1234 Hz; must stay 1000 Hz)");
  const payload = "C1:BSWV FRQ,1234";
  const attacks = [
    ["F1 setter via scpi_query", "scpi_query", { command: payload }],
    ["F1 compound query hides setter", "scpi_query", { command: `C1:BSWV?;${payload}` }],
    ["F1 setter parameters after query header", "scpi_query", { command: "C1:BSWV? FRQ,1234" }],
    ["F1 action command in query form (C1:TRIGger?)", "scpi_query", { command: "C1:TRIGger?" }],
    ["F1 read-and-clear status query (*ESR?)", "scpi_query", { command: "*ESR?" }],
    ["F2 newline injection in load", "configure_output", { channel: "C1", load: `50\n${payload}` }],
    ["F2 compound injection in load", "configure_output", { channel: "C1", load: `50;${payload}` }],
    ["F2 newline injection in cycles", "configure_burst", { channel: "C1", cycles: `1\n${payload}` }],
  ];
  for (const [label, tool, args] of attacks) {
    r = await s.call(tool, args);
    await assertOffOrAbort(s, label);
    const frq = await frequency(s.call);
    check(label, !r.ok && frq === "1000", `rejected=${!r.ok}, FRQ=${frq}Hz`);
  }

  const tools = (await s.client.listTools()).tools.map((t) => t.name);
  check("scpi_command not exposed by default", !tools.includes("scpi_command"), `${tools.length} tools`);

  // Any private-LAN address that isn't the instrument under test.
  const probeHost = ["192.168.1.1", "192.168.1.2"].find((h) => h !== ip);
  r = await s.call("connect", { host: probeHost });
  const still = await s.call("identify");
  check("F3 connect to another LAN host rejected, session intact", !r.ok && still.ok, r.text.slice(0, 70));

  await s.client.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Hardware check error:", err);
  process.exit(1);
});
