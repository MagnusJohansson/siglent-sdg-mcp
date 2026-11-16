/**
 * The audit log in a real server process (build/index.js; CI builds first).
 * Covers what only a process shows: stdout stays JSON-RPC, shutdown on stdin
 * end and SIGTERM, file permissions, fail-closed startup, and an unread
 * stderr pipe that must not stall the server.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SdgSimulator, SIM_IDN } from "../simulator/sdg-simulator.js";

const SERVER = join(__dirname, "../../build/index.js");
let sim: SdgSimulator;
let simPort: number;
let dir: string;

beforeAll(async () => {
  if (!existsSync(SERVER)) throw new Error("build/index.js is missing: run `npm run build` first.");
  sim = new SdgSimulator();
  simPort = await sim.start();
  dir = mkdtempSync(join(tmpdir(), "sdg-audit-"));
});
afterAll(async () => {
  await sim.stop();
  rmSync(dir, { recursive: true, force: true });
});

/** A minimal JSON-RPC client over the child's stdio. */
function start(env: Record<string, string>, opts: { readStderr?: boolean } = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: { PATH: process.env.PATH ?? "", SIGLENT_SDG_IP: "127.0.0.1", SIGLENT_SDG_PORT: String(simPort), ...env },
  }) as ChildProcessWithoutNullStreams;
  const stdoutLines: string[] = [];
  const replies = new Map<number, Record<string, unknown>>();
  let buf = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      stdoutLines.push(line);
      const msg = JSON.parse(line) as { id?: number };
      if (typeof msg.id === "number") replies.set(msg.id, msg);
    }
  });
  let stderr = "";
  const readStderr = () => child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
  if (opts.readStderr !== false) readStderr();
  // "close", not "exit": exit can fire before the stdio streams have delivered everything.
  const exited = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  let nextId = 1;
  const send = (msg: Record<string, unknown>) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const id = nextId++;
    send({ id, method, params });
    for (let t = 0; t < 1000 && !replies.has(id); t++) await new Promise((r) => setTimeout(r, 5));
    const reply = replies.get(id);
    if (!reply) throw new Error(`no reply to ${method}`);
    return reply;
  };
  const init = async () => {
    await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "process-test", version: "1" } });
    send({ method: "notifications/initialized" });
  };
  const call = (name: string, args: Record<string, unknown> = {}) => request("tools/call", { name, arguments: args });
  return { child, stdoutLines, stderr: () => stderr, readStderr, exited, init, call };
}

function auditLines(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/**
 * Wait until auto-connect has finished initialising. The socket counts as
 * connected before CHDR OFF and *IDN? have run, so a successful tool call
 * isn't enough; the instrument.connect event is (it's a security-level event).
 */
async function waitConnected(s: ReturnType<typeof start>, auditFile?: string) {
  const read = (file: string) => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return ""; // not created yet
    }
  };
  const text = () => (auditFile ? read(auditFile) : s.stderr());
  for (let t = 0; t < 200; t++) {
    if (text().includes('"event.name":"instrument.connect"')) return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error("auto-connect didn't complete");
}

describe("audit log in a server process", () => {
  it("keeps stdout pure JSON-RPC, even with the full trail on stderr", async () => {
    const s = start({ SIGLENT_AUDIT_LOG: "stderr" });
    await s.init();
    await waitConnected(s);
    await s.call("scpi_query", { command: "C1:OUTP ON" });
    await s.call("configure_output", { channel: "C1", load: "50" });
    s.child.stdin.end();
    expect(await s.exited).toBe(0);
    for (const line of s.stdoutLines) expect(JSON.parse(line)).toHaveProperty("jsonrpc", "2.0");
    const events = auditLines(s.stderr()).map((r) => r["event.name"]);
    expect(events).toEqual(expect.arrayContaining(["server.start", "instrument.connect", "guard.refused", "scpi.write", "server.stop"]));
  });

  it("logs only security events on stderr by default", async () => {
    const s = start({});
    await s.init();
    await waitConnected(s);
    await s.call("get_output", { channel: "C1" });
    s.child.stdin.end();
    await s.exited;
    const names = new Set(auditLines(s.stderr()).map((r) => r["event.name"]));
    expect([...names].sort()).toEqual(["instrument.connect", "instrument.disconnect", "server.start", "server.stop"]);
  });

  it("exits on stdin end with an instrument connection open, recording the stop", async () => {
    const s = start({});
    await s.init();
    await waitConnected(s);
    const t0 = Date.now();
    s.child.stdin.end();
    expect(await s.exited).toBe(0);
    expect(Date.now() - t0).toBeLessThan(3000);
    const records = auditLines(s.stderr());
    expect(records.find((r) => r["event.name"] === "server.stop")).toMatchObject({ reason: "stdin_closed", "audit.lost": 0 });
    expect(records.find((r) => r["event.name"] === "instrument.disconnect")).toMatchObject({ reason: "shutdown", cause: "shutdown" });
  });

  it("flushes and exits on SIGTERM; a file sink is created with mode 0600", async () => {
    const file = join(dir, "sigterm.jsonl");
    const s = start({ SIGLENT_AUDIT_LOG: file });
    await s.init();
    await waitConnected(s, file);
    s.child.kill("SIGTERM");
    expect(await s.exited).toBe(0);
    // One descriptor for both the mode and the content.
    const fd = openSync(file, "r");
    const mode = fstatSync(fd).mode;
    const records = auditLines(readFileSync(fd, "utf8"));
    closeSync(fd);
    expect(mode & 0o777).toBe(0o600);
    expect(records.at(-1)).toMatchObject({ "event.name": "server.stop", reason: "signal", "audit.sink": "file" });
    expect(records.find((r) => r["event.name"] === "instrument.connect")).toMatchObject({ outcome: "connected", "instrument.idn": SIM_IDN, cause: "auto-connect" });
    // In the file sink, the full trail: wire events too.
    expect(records.some((r) => r["event.name"] === "scpi.write")).toBe(true);
  });

  it("refuses to start when the audit file can't be opened, or the path is relative", async () => {
    for (const [value, message] of [
      [join(dir, "missing", "x.jsonl"), "can't open the audit log"],
      ["relative.jsonl", "must be"],
    ]) {
      const s = start({ SIGLENT_AUDIT_LOG: value });
      expect(await s.exited, value).toBe(1);
      expect(s.stderr()).toContain(message);
    }
  });

  it("doesn't stall when stderr is a pipe nobody reads; drops are counted and reported", async () => {
    const s = start({ SIGLENT_AUDIT_LOG: "stderr" }, { readStderr: false });
    await s.init();
    // stderr isn't read here, so wait for the auto-connect to finish instead.
    await new Promise((res) => setTimeout(res, 1000));
    // Each query is four events of a few hundred bytes: this fills the pipe
    // (~64 KB) and then the writer's queue (4096 lines), so events are dropped
    // and the loss warning fires, while stderr is stuck.
    const t0 = Date.now();
    for (let i = 0; i < 2000; i++) {
      const r = (await s.call("scpi_query", { command: "*IDN?" })) as { result?: { content?: Array<{ text?: string }> } };
      expect(r.result?.content?.[0]?.text).toBe(SIM_IDN);
    }
    expect(Date.now() - t0).toBeLessThan(60_000);

    // Drain the pipe; the next event reports the loss. stderr may be a
    // non-blocking descriptor, so the writer is in its EAGAIN backoff (up to
    // 1 s): wait until it has caught up.
    s.readStderr();
    let size = -1;
    while (s.stderr().length !== size) {
      size = s.stderr().length;
      await new Promise((r) => setTimeout(r, 1500));
    }
    await s.call("configure_output", { channel: "C1", load: "50" });
    s.child.stdin.end();
    expect(await s.exited).toBe(0);
    const records = auditLines(s.stderr());
    const loss = records.filter((r) => r["event.name"] === "audit.loss");
    expect(loss.length).toBeGreaterThan(0);
    expect(Number(loss[0]["audit.lost"])).toBeGreaterThan(0);
    expect(s.stderr()).toMatch(/audit: \d+ events were lost on the stderr sink/);
    expect(Number(records.find((r) => r["event.name"] === "server.stop")?.["audit.lost"])).toBeGreaterThan(0);
  }, 90_000);
});
