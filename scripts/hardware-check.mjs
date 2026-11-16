#!/usr/bin/env node
/**
 * Hardware check against a real Siglent SDG, through the built server over
 * stdio (the same path an MCP client uses).
 *
 * Usage:  npm run build && node scripts/hardware-check.mjs <instrument-ip>
 *         node scripts/hardware-check.mjs <instrument-ip> --docker <image>
 *
 * --docker runs the server from a Docker image instead of build/, with the
 * hardening flags the README documents (--read-only --cap-drop=ALL
 * --security-opt=no-new-privileges).
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
 * by looking at the error the server returned. The audit log is a second,
 * independent oracle: every probe must be recorded as guard.refused with the
 * expected rule, and no probe's payload may appear in any scpi.write.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ip = process.argv[2];
const dockerFlag = process.argv.indexOf("--docker");
const dockerImage = dockerFlag > 0 ? process.argv[dockerFlag + 1] : undefined;
if (!ip || ip.startsWith("--") || (dockerFlag > 0 && !dockerImage)) {
  console.error("Usage: node scripts/hardware-check.mjs <instrument-ip> [--docker <image>]");
  process.exit(2);
}
const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "build", "index.js");

// The server writes its full audit trail here. With --docker the directory is
// mounted at /audit and must be writable by the container's UID 1000.
const auditDir = mkdtempSync(path.join(tmpdir(), "sdg-hardware-check-"));
chmodSync(auditDir, 0o777);
const auditFile = path.join(auditDir, "audit.jsonl");
const auditEnv = { SIGLENT_AUDIT_LOG: dockerImage ? "/audit/audit.jsonl" : auditFile };

let passed = 0;
let failed = 0;
function check(label, ok, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  [${detail}]` : ""}`);
}

// The server's own environment. With --docker it goes into the container as
// -e flags; the docker CLI itself only gets PATH, HOME and the variables
// that select a daemon (DOCKER_HOST, DOCKER_CONTEXT), when they're set.
function serverCommand(serverEnv) {
  if (!dockerImage) {
    return { command: process.execPath, args: [serverPath], env: { PATH: process.env.PATH ?? "", ...serverEnv } };
  }
  return {
    command: "docker",
    args: [
      "run", "--rm", "-i",
      "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
      "-v", `${auditDir}:/audit`,
      ...Object.entries(serverEnv).flatMap(([k, val]) => ["-e", `${k}=${val}`]),
      dockerImage,
    ],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      ...Object.fromEntries(
        ["DOCKER_HOST", "DOCKER_CONTEXT"].filter((k) => process.env[k]).map((k) => [k, process.env[k]])
      ),
    },
  };
}

async function startServer(extraEnv = {}) {
  const transport = new StdioClientTransport({
    ...serverCommand({ SIGLENT_SDG_IP: ip, ...auditEnv, ...extraEnv }),
    stderr: "pipe",
  });
  const client = new Client({ name: "hardware-check", version: "1.0.0" });
  await client.connect(transport);
  // Drain stderr: a pipe nobody reads fills up. The server doesn't stall on it
  // (its writer is non-blocking), but it would drop audit events.
  transport.stderr?.on("data", () => {});
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
  // [label, tool, arguments, the rule the audit log must record]
  const attacks = [
    ["F1 setter via scpi_query", "scpi_query", { command: payload }, "query.not_a_query"],
    ["F1 compound query hides setter", "scpi_query", { command: `C1:BSWV?;${payload}` }, "wire.compound"],
    ["F1 setter parameters after query header", "scpi_query", { command: "C1:BSWV? FRQ,1234" }, "query.parameters_not_allowed"],
    ["F1 action command in query form (C1:TRIGger?)", "scpi_query", { command: "C1:TRIGger?" }, "query.action_command"],
    ["F1 read-and-clear status query (*ESR?)", "scpi_query", { command: "*ESR?" }, "query.common_not_allowed"],
    // Has no ON/OFF value in query form, and the output check after each probe
    // would catch an output switched on.
    ["F1 both-outputs command in query form (OUT_BOTHCH?)", "scpi_query", { command: "OUT_BOTHCH?" }, "query.action_command"],
    ["F2 newline injection in load", "configure_output", { channel: "C1", load: `50\n${payload}` }, "schema.invalid"],
    ["F2 compound injection in load", "configure_output", { channel: "C1", load: `50;${payload}` }, "schema.invalid"],
    ["F2 newline injection in cycles", "configure_burst", { channel: "C1", cycles: `1\n${payload}` }, "schema.invalid"],
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

  // ---------------------------------------------------------------- audit
  console.log("\n  Audit log (an independent record of what the server refused and wrote)");
  const records = await readAudit();
  const requestId = (tool, args) =>
    records.find(
      (r) => r["event.name"] === "mcp.request" && r["gen_ai.tool.name"] === tool &&
        r["gen_ai.tool.call.arguments"] === JSON.stringify(args)
    )?.["jsonrpc.request.id"];
  const refusals = records.filter((r) => r["event.name"] === "guard.refused");
  const unrecorded = attacks
    .filter(([, tool, args, rule]) => {
      const id = requestId(tool, args);
      return id === undefined || !refusals.some((r) => r["jsonrpc.request.id"] === id && r.rule === rule);
    })
    .map(([label]) => label);
  const f3 = refusals.some((r) => r.rule === "host.not_allowed" && r["server.address"] === probeHost);
  check(
    "every probe recorded as guard.refused with its rule",
    unrecorded.length === 0 && f3,
    unrecorded.length ? `missing: ${unrecorded.join("; ")}` : `${attacks.length + 1} probes`
  );
  const writes = records.filter((r) => r["event.name"] === "scpi.write").map((r) => String(r["scpi.command"]));
  // A leak: a refused query sent as-is, or the frequency payload in any write.
  const refusedQueries = new Set(attacks.filter(([, tool]) => tool === "scpi_query").map(([, , args]) => args.command));
  const leaked = writes.filter((w) => refusedQueries.has(w) || w.includes("FRQ,1234"));
  check("no probe's payload reached the wire", writes.length > 0 && leaked.length === 0, `${writes.length} writes${leaked.length ? `, leaked: ${leaked.join(", ")}` : ""}`);
  if (dockerImage) {
    // The container's files belong to UID 1000; remove them through the image.
    execFileSync("docker", ["run", "--rm", "--user", "0", "-v", `${auditDir}:/audit`, "--entrypoint", "sh", dockerImage, "-c", "rm -rf /audit/*"], { stdio: "ignore" });
  }
  rmSync(auditDir, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

/**
 * The audit file's text. With --docker it belongs to the container's UID 1000
 * with mode 0600, which a different host user can't read on Linux, so it's
 * read through the image as that user.
 */
function auditText() {
  try {
    return dockerImage
      ? execFileSync("docker", ["run", "--rm", "-v", `${auditDir}:/audit`, "--entrypoint", "cat", dockerImage, "/audit/audit.jsonl"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      : readFileSync(auditFile, "utf8");
  } catch {
    return ""; // not written yet
  }
}

/** The audit file, once the server has written its server.stop (it flushes on shutdown). */
async function readAudit() {
  for (let t = 0; t < 100; t++) {
    const text = auditText();
    if (text.includes('"event.name":"server.stop"')) {
      return text.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no server.stop in ${auditFile}`);
}

main().catch((err) => {
  console.error("Hardware check error:", err);
  process.exit(1);
});
