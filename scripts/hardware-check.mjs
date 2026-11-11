#!/usr/bin/env node
/**
 * Hardware check against a real Siglent SDG, through the built server over
 * stdio (the same path an MCP client uses).
 *
 * Usage:  npm run build && node scripts/hardware-check.mjs <instrument-ip>
 *
 * SAFETY
 * - Never turns an output ON. Aborts if C1 output is already ON.
 * - Works on C1 only, amplitudes <= 2 Vpp.
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

/** Read C1 output state; returns "ON", "OFF" or the raw text if unparseable. */
async function outputState(call) {
  const r = await call("get_output", { channel: "C1" });
  const m = /OUTP\s+(ON|OFF)|^(ON|OFF)/.exec(r.text);
  return m ? m[1] ?? m[2] : r.text;
}

async function main() {
  console.log(`Hardware check: ${ip}\n`);

  // ---------------------------------------------------------------- default
  console.log("1. Default configuration (no limits, raw SCPI off)");
  let s = await startServer();
  check("connect + identify", s.conn.ok && /SDG/i.test(s.conn.text), s.conn.text.split("\n").pop());
  if (!s.conn.ok) throw new Error("Cannot connect; aborting.");

  const initial = await outputState(s.call);
  if (initial !== "OFF") {
    console.log(`\n  ABORT: C1 output is ${initial}. Turn it OFF on the front panel and re-run.`);
    await s.client.close();
    process.exit(1);
  }
  console.log(`  info  C1 output is OFF; initial BSWV: ${(await s.call("get_basic_wave", { channel: "C1" })).text}`);

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

  // Security: rejected AND the instrument state is unchanged.
  console.log("\n  Security (output must stay OFF)");
  const attacks = [
    ["F1 scpi_query sets output ON", "scpi_query", { command: "C1:OUTP ON" }],
    ["F1 compound query hides setter", "scpi_query", { command: "C1:OUTP?;C1:OUTP ON" }],
    ["F2 newline injection in load", "configure_output", { channel: "C1", load: "50\nC1:OUTP ON" }],
    ["F2 compound injection in load", "configure_output", { channel: "C1", load: "50;C1:OUTP ON" }],
    ["F2 newline injection in cycles", "configure_burst", { channel: "C1", cycles: "1\nC1:OUTP ON" }],
  ];
  for (const [label, tool, args] of attacks) {
    r = await s.call(tool, args);
    const state = await outputState(s.call);
    check(label, !r.ok && state === "OFF", `rejected=${!r.ok}, output=${state}`);
  }

  const tools = (await s.client.listTools()).tools.map((t) => t.name);
  check("scpi_command not exposed by default", !tools.includes("scpi_command"), `${tools.length} tools`);

  r = await s.call("connect", { host: "192.168.1.1" });
  const still = await s.call("identify");
  check("F3 connect to another LAN host rejected, session intact", !r.ok && still.ok, r.text.slice(0, 70));

  await s.client.close();

  // ----------------------------------------------------------------- limits
  console.log("\n2. Output limits (max 2 Vpp, max ±1 V)");
  s = await startServer({ SIGLENT_MAX_AMPLITUDE_VPP: "2", SIGLENT_MAX_VOLTAGE: "1" });
  check("connect", s.conn.ok);

  r = await s.call("configure_basic_wave", { channel: "C1", amplitude: 1.5, offset: 0 });
  rb = (await s.call("get_basic_wave", { channel: "C1" })).text;
  check("1.5 Vpp within limit accepted", r.ok && /AMP,1\.5V/i.test(rb), rb);

  for (const [label, args] of [
    ["3 Vpp rejected", { channel: "C1", amplitude: 3 }],
    ["offset 2 V rejected", { channel: "C1", offset: 2 }],
    ["Vrms amplitude rejected", { channel: "C1", amplitude_vrms: 0.5 }],
  ]) {
    r = await s.call("configure_basic_wave", args);
    rb = (await s.call("get_basic_wave", { channel: "C1" })).text;
    check(label + ", instrument unchanged", !r.ok && /AMP,1\.5V/i.test(rb) && /OFST,0V/i.test(rb), r.text.slice(0, 70));
  }
  check("output still OFF", (await outputState(s.call)) === "OFF");
  await s.client.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Hardware check error:", err);
  process.exit(1);
});
