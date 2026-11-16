/**
 * Audit log: what's recorded, attributed to which request, at which level.
 * Runs the real MCP server (with the transport hooks) against the simulator.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SdgSimulator, SIM_IDN } from "../simulator/sdg-simulator.js";
import { callTool, captureAudit, createTestServer, getText, MemorySink } from "../helpers.js";
import { audit, type AuditRecord, type AuditSink } from "../../src/audit/audit.js";
import { POLICY_RULES } from "../../src/security/scpi-guard.js";

let sim: SdgSimulator;
let simPort: number;
const full = new MemorySink("full", "full");
const security = new MemorySink("security", "security");

beforeAll(async () => {
  sim = new SdgSimulator();
  simPort = await sim.start();
});
afterAll(async () => {
  audit.reset();
  await sim.stop();
});

function simEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { SIGLENT_SDG_IP: "127.0.0.1", SIGLENT_SDG_PORT: String(simPort), ...extra };
}

/** The request id the server saw for the call whose arguments contain `marker`. */
function requestIdFor(sink: MemorySink, marker: string): string {
  const req = sink
    .events("mcp.request")
    .find((r) => String(r["gen_ai.tool.call.arguments"] ?? "").includes(marker));
  expect(req, `an mcp.request containing ${marker}`).toBeDefined();
  return String(req!["jsonrpc.request.id"]);
}

function writesOf(sink: MemorySink, command: string): AuditRecord[] {
  return sink.events("scpi.write").filter((r) => r["scpi.command"] === command);
}

function resultOf(sink: MemorySink, writeId: unknown): AuditRecord[] {
  return sink.events("scpi.result").filter((r) => r["scpi.write_id"] === writeId);
}

describe("audit log", () => {
  let ctx: Awaited<ReturnType<typeof createTestServer>>;

  beforeEach(async () => {
    full.clear();
    security.clear();
    captureAudit(full, security);
    ctx = await createTestServer(simEnv());
    expect(getText(await callTool(ctx.client, "connect"))).toContain(SIM_IDN);
    // Each test sees only its own events.
    full.clear();
    security.clear();
    sim.clear();
    sim.resetState();
    sim.silent.clear();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  it("records a state-changing tool call at the security level, a read-only one only in the full trail", async () => {
    await callTool(ctx.client, "configure_output", { channel: "C1", load: "50" });
    await callTool(ctx.client, "get_output", { channel: "C1" });

    const tools = (s: MemorySink) => s.events("mcp.request").map((r) => r["gen_ai.tool.name"]);
    expect(tools(security)).toContain("configure_output");
    expect(tools(security)).not.toContain("get_output");
    expect(tools(full)).toEqual(expect.arrayContaining(["configure_output", "get_output"]));

    const req = security.events("mcp.request").find((r) => r["gen_ai.tool.name"] === "configure_output")!;
    expect(req["read_only_hint"]).toBe(false);
    expect(JSON.parse(String(req["gen_ai.tool.call.arguments"]))).toEqual({ channel: "C1", load: "50" });
    const res = security.events("mcp.response").find((r) => r["jsonrpc.request.id"] === req["jsonrpc.request.id"])!;
    expect(res["outcome"]).toBe("ok");

    // Wire events are full-trail only.
    expect(security.events("scpi.write")).toEqual([]);
    expect(writesOf(full, "C1:OUTP LOAD,50")).toHaveLength(1);
  });

  it("records a guard refusal with its rule and request id, and no write", async () => {
    await callTool(ctx.client, "scpi_query", { command: "C1:OUTP ON" });
    const id = requestIdFor(full, "C1:OUTP ON");
    const refused = security.events("guard.refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({
      guard: "query",
      rule: "query.not_a_query",
      "scpi.command": "C1:OUTP ON",
      "jsonrpc.request.id": id,
      cause: "tool-call",
    });
    expect(writesOf(full, "C1:OUTP ON")).toEqual([]);
  });

  it("records a schema refusal (an injection attempt in a tool argument) at the security level", async () => {
    await callTool(ctx.client, "configure_output", { channel: "C1", load: "50\nC1:OUTP ON" });
    const refused = security.events("guard.refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ guard: "schema", rule: "schema.invalid" });
    expect(String(refused[0]["error.message"])).toContain("Input validation error");
    // The request, with the payload, is on record at the security level too.
    const req = security.events("mcp.request").find((r) => r["gen_ai.tool.name"] === "configure_output");
    expect(String(req?.["gen_ai.tool.call.arguments"])).toContain("C1:OUTP ON");
    expect(full.events("scpi.write")).toEqual([]);
  });

  it("doesn't take tool error text that mentions the SDK's schema error for a schema refusal", async () => {
    // The tool error repeats the input; only the SDK's exact prefix counts.
    await callTool(ctx.client, "scpi_query", { command: "Input validation error" });
    expect(security.events("guard.refused").map((r) => r["rule"])).toEqual(["query.not_a_query"]);
  });

  it("closes a cancelled call with outcome cancelled", async () => {
    sim.silent.add("C1:SILENT?");
    const controller = new AbortController();
    const call = ctx.client.callTool(
      { name: "scpi_query", arguments: { command: "C1:SILENT?", timeout_ms: 2000 } },
      undefined,
      { signal: controller.signal }
    );
    await new Promise((r) => setTimeout(r, 100));
    controller.abort();
    await expect(call).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 2200)); // the query itself ends (timeout); no second response
    const id = requestIdFor(full, "C1:SILENT?");
    const responses = full.events("mcp.response").filter((r) => r["jsonrpc.request.id"] === id);
    expect(responses).toEqual([expect.objectContaining({ outcome: "cancelled" })]);
    // The instrument side still ends on record.
    const [write] = writesOf(full, "C1:SILENT?");
    expect(resultOf(full, write["scpi.write_id"])).toEqual([expect.objectContaining({ outcome: "timeout" })]);
  });

  it("records queued queries as not written when the instrument resets the connection", async () => {
    sim.silent.add("C1:SILENT?");
    const pending = [
      callTool(ctx.client, "scpi_query", { command: "C1:SILENT?", timeout_ms: 5000 }),
      callTool(ctx.client, "scpi_query", { command: "C2:BSWV?" }),
    ];
    await new Promise((r) => setTimeout(r, 100));
    sim.resetConnections();
    await Promise.all(pending);

    const [written] = writesOf(full, "C1:SILENT?");
    expect(resultOf(full, written["scpi.write_id"])).toEqual([expect.objectContaining({ outcome: "connection_closed" })]);
    // The queued query never reached the dying socket.
    expect(writesOf(full, "C2:BSWV?")).toEqual([]);
    const nextId = requestIdFor(full, "C2:BSWV?");
    expect(full.events("scpi.result").filter((r) => r["jsonrpc.request.id"] === nextId)).toEqual([
      expect.objectContaining({ outcome: "not_written" }),
    ]);
    await new Promise((r) => setTimeout(r, 50));
    expect(security.events("instrument.disconnect")).toEqual([
      expect.objectContaining({ reason: "socket_error", cause: "socket" }),
    ]);
  });

  it("records a call to the disabled scpi_command as a refusal", async () => {
    await callTool(ctx.client, "scpi_command", { command: "C1:OUTP ON" });
    expect(security.events("guard.refused")).toEqual([
      expect.objectContaining({ guard: "raw-scpi", rule: "raw.disabled", "scpi.command": "C1:OUTP ON" }),
    ]);
    // The request is beside the refusal at the default level.
    const id = security.events("guard.refused")[0]["jsonrpc.request.id"];
    expect(security.events("mcp.request").some((r) => r["jsonrpc.request.id"] === id)).toBe(true);
  });

  it("records an unknown tool in the full trail", async () => {
    await callTool(ctx.client, "no_such_tool", {});
    const res = full.events("mcp.response").find((r) => r["gen_ai.tool.name"] === "no_such_tool");
    expect(res?.["outcome"]).toBe("tool_error");
    expect(security.events("mcp.request").map((r) => r["gen_ai.tool.name"])).not.toContain("no_such_tool");
  });

  it("attributes each write to its own call when calls run in parallel", async () => {
    await Promise.all([
      callTool(ctx.client, "scpi_query", { command: "C1:BSWV?" }),
      callTool(ctx.client, "scpi_query", { command: "C2:BSWV?" }),
      callTool(ctx.client, "scpi_query", { command: "*IDN?" }),
    ]);
    for (const cmd of ["C1:BSWV?", "C2:BSWV?", "*IDN?"]) {
      const id = requestIdFor(full, cmd);
      const write = writesOf(full, cmd).at(-1)!;
      expect(write["jsonrpc.request.id"], cmd).toBe(id);
      const [result] = resultOf(full, write["scpi.write_id"]);
      expect(result).toMatchObject({ outcome: "replied", "jsonrpc.request.id": id });
    }
  });

  it("attributes the next call's write correctly after a timeout", async () => {
    // The second query is written from the first one's timeout callback.
    sim.silent.add("C1:SILENT?");
    await Promise.all([
      callTool(ctx.client, "scpi_query", { command: "C1:SILENT?", timeout_ms: 200 }),
      callTool(ctx.client, "scpi_query", { command: "C2:BSWV?" }),
    ]);
    const silentId = requestIdFor(full, "C1:SILENT?");
    const nextId = requestIdFor(full, "C2:BSWV?");
    expect(silentId).not.toBe(nextId);

    const [silentWrite] = writesOf(full, "C1:SILENT?");
    expect(resultOf(full, silentWrite["scpi.write_id"])).toEqual([
      expect.objectContaining({ outcome: "timeout", "jsonrpc.request.id": silentId }),
    ]);
    const [nextWrite] = writesOf(full, "C2:BSWV?");
    expect(nextWrite["jsonrpc.request.id"]).toBe(nextId);
  });

  it("gives every write id exactly one result when a disconnect cuts queued queries off", async () => {
    sim.silent.add("C1:SILENT?");
    const pending = [
      callTool(ctx.client, "scpi_query", { command: "C1:SILENT?", timeout_ms: 5000 }),
      callTool(ctx.client, "scpi_query", { command: "C2:BSWV?" }),
    ];
    await new Promise((r) => setTimeout(r, 100)); // the first is on the wire, the second queued
    await callTool(ctx.client, "disconnect");
    await Promise.all(pending);

    const [written] = writesOf(full, "C1:SILENT?");
    expect(resultOf(full, written["scpi.write_id"])).toEqual([
      expect.objectContaining({ outcome: "connection_closed" }),
    ]);
    // The queued query was never written: a result without a write.
    expect(writesOf(full, "C2:BSWV?")).toEqual([]);
    const nextId = requestIdFor(full, "C2:BSWV?");
    const notWritten = full.events("scpi.result").filter((r) => r["outcome"] === "not_written");
    expect(notWritten).toEqual([expect.objectContaining({ "jsonrpc.request.id": nextId })]);

    const ids = full.events("scpi.result").map((r) => r["scpi.write_id"]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(security.events("instrument.disconnect")).toEqual([expect.objectContaining({ reason: "requested" })]);
  });

  it("records connects, refusals by policy and a replaced connection", async () => {
    await callTool(ctx.client, "connect");
    await callTool(ctx.client, "connect", { host: "192.168.1.1" });
    await callTool(ctx.client, "connect", { host: "127.0.0.1", port: 22 });

    const connects = security.events("instrument.connect").map((r) => r["outcome"]);
    expect(connects).toEqual(["connected", "refused_by_policy", "refused_by_policy"]);
    // The connect tool's request is on record at the security level.
    expect(security.events("instrument.disconnect")).toEqual([expect.objectContaining({ reason: "replaced" })]);
    expect(security.events("guard.refused").map((r) => r["rule"])).toEqual([
      "host.not_allowed",
      "host.port_not_allowed",
    ]);
    // The connect's own CHDR OFF and *IDN? are attributed to the connect call.
    const connectId = String(security.events("instrument.connect")[0]["jsonrpc.request.id"]);
    expect(writesOf(full, "*IDN?").at(-1)?.["jsonrpc.request.id"]).toBe(connectId);
  });

  it("numbers each sink's records without gaps, whatever its level", async () => {
    await callTool(ctx.client, "configure_output", { channel: "C1", load: "HZ" });
    await callTool(ctx.client, "scpi_query", { command: "C1:OUTP ON" });
    for (const sink of [full, security]) {
      const seqs = sink.records.map((r) => r["audit.seq"] as number);
      expect(seqs.length).toBeGreaterThan(0);
      expect(seqs, sink.name).toEqual(seqs.map((_, i) => seqs[0] + i));
      expect(new Set(sink.records.map((r) => r["audit.sink"]))).toEqual(new Set([sink.name]));
    }
  });

  it("bounds long strings", async () => {
    const long = "C1:BSWV? " + "A".repeat(700);
    await callTool(ctx.client, "scpi_query", { command: long });
    const [refused] = security.events("guard.refused");
    expect(refused["rule"]).toBe("wire.too_long");
    expect(String(refused["scpi.command"])).toMatch(/…\[truncated, 709 chars\]$/);
    expect(String(refused["scpi.command"]).length).toBeLessThan(560);
  });
});

describe("audit log: losses", () => {
  it("reports dropped records with audit.loss once the sink accepts again, and leaves a gap", async () => {
    let accept = false;
    const records: AuditRecord[] = [];
    const flaky: AuditSink = {
      name: "flaky",
      level: "security",
      write(r) {
        if (!accept) return false;
        records.push(r);
        return true;
      },
    };
    captureAudit(flaky);
    audit.serverStart({ rawScpiEnabled: false, allowedHosts: [], allowedPorts: [5025], audit: "test" });
    audit.serverStart({ rawScpiEnabled: false, allowedHosts: [], allowedPorts: [5025], audit: "test" });
    accept = true;
    audit.serverStart({ rawScpiEnabled: false, allowedHosts: [], allowedPorts: [5025], audit: "test" });
    // Seqs 1-3 are missing: two server.start records and the audit.loss
    // attempt made while the sink was still refusing. The count matches the gap.
    expect(records.map((r) => [r["event.name"], r["audit.seq"]])).toEqual([
      ["audit.loss", 4],
      ["server.start", 5],
    ]);
    expect(records[0]["audit.lost"]).toBe(3);
    expect(audit.lost.events).toBe(3);
    audit.reset();
  });
});

describe("audit log: coverage", () => {
  it("every registered tool declares readOnlyHint", async () => {
    captureAudit();
    const ctx = await createTestServer(simEnv({ SIGLENT_ALLOW_RAW_SCPI: "true" }));
    try {
      const { tools } = await ctx.client.listTools();
      expect(tools.length).toBeGreaterThan(15);
      for (const t of tools) {
        expect(typeof t.annotations?.readOnlyHint, t.name).toBe("boolean");
        expect(audit.registeredTools.get(t.name)?.readOnlyHint, t.name).toBe(t.annotations?.readOnlyHint);
      }
    } finally {
      await ctx.cleanup();
    }
  });

  it("every rule in POLICY_RULES is produced", async () => {
    const sink = new MemorySink();
    captureAudit(sink);
    // One server at a time: createServer configures the process-wide connection.
    const ctx = await createTestServer(simEnv());
    try {
      await callTool(ctx.client, "connect");
      const queries = [
        "", "C1:BSWV? " + "A".repeat(600), "C1:OUTP?\tON", 'C1:ARWV NAME,"wåve"?', "C1:OUTP?;C1:OUTP ON",
        "C1:OUTP ON", "*RST?", "C1:TRIGger?", "C1:BSWV? FRQ,1", "STL? WVNM,x",
      ];
      for (const command of queries) await callTool(ctx.client, "scpi_query", { command });
      await callTool(ctx.client, "connect", { host: "127.0.0.1", port: 22 });
      await callTool(ctx.client, "connect", { host: "192.168.1.1" });
      await callTool(ctx.client, "scpi_command", { command: "*RST" });
      await callTool(ctx.client, "configure_output", { channel: "C1", load: "50\n" });
      await ctx.cleanup();

      const loose = await createTestServer({}); // no instrument configured: private-LAN policy
      await callTool(loose.client, "connect", { host: "8.8.8.8", port: 5025 });
      await loose.cleanup();

      const produced = new Set(sink.events("guard.refused").map((r) => r["rule"]));
      expect([...POLICY_RULES].filter((r) => !produced.has(r))).toEqual([]);
    } finally {
      audit.reset();
    }
  });

  it("every ScpiPolicyError in src/ is thrown with a rule from POLICY_RULES", () => {
    const dir = join(__dirname, "../../src");
    const files = readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".ts"))
      .map((e) => join(e.parentPath, e.name));
    let throws = 0;
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/new ScpiPolicyError\(([^`]*?),\s*[`"]/g)) {
        throws++;
        const rules = [...m[1].matchAll(/"([a-z_]+\.[a-z_]+)"/g)].map((r) => r[1]);
        expect(rules.length, `${file}: ${m[0]}`).toBeGreaterThan(0);
        for (const r of rules) expect(POLICY_RULES, `${file}: ${r}`).toContain(r);
      }
    }
    expect(throws).toBe(12);
  });

  it("nothing in src/ outside the audit module writes to stderr or the console", () => {
    const dir = join(__dirname, "../../src");
    const offenders = readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".ts") && !join(e.parentPath, e.name).includes(join("src", "audit")))
      .flatMap((e) => {
        const file = join(e.parentPath, e.name);
        return readFileSync(file, "utf8")
          .split("\n")
          .map((line, i) => ({ file, line: i + 1, text: line }))
          .filter((l) => /\bconsole\.|process\.stderr/.test(l.text));
      });
    expect(offenders).toEqual([]);
  });
});
