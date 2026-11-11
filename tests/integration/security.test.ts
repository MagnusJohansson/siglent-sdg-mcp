/**
 * End-to-end security tests: real MCP client -> real server -> real TCP
 * socket -> SCPI simulator. Each rejection is proven by what did NOT reach
 * the wire, not just by the error message.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SdgSimulator, SIM_IDN } from "../simulator/sdg-simulator.js";
import { createTestServer, callTool, getText } from "../helpers.js";

/**
 * A tool call is rejected if the server throws (protocol error) or returns
 * isError. Only the call itself is inside try/catch: the assertion must stay
 * outside, or a successful call would turn into a caught assertion error and
 * the test would pass anyway.
 */
async function expectRejected(client: Client, name: string, args: Record<string, unknown>) {
  let result: Awaited<ReturnType<typeof callTool>>;
  try {
    result = await callTool(client, name, args);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  expect(result.isError, `expected ${name} to be rejected, got: ${getText(result)}`).toBe(true);
  return getText(result);
}

let sim: SdgSimulator;
let simPort: number;

beforeAll(async () => {
  sim = new SdgSimulator();
  simPort = await sim.start();
});

afterAll(async () => {
  await sim.stop();
});

/**
 * What reached the instrument. Sends a *OPC? round trip first: the socket is
 * ordered, so once its reply arrives every earlier write has been received.
 * Without this barrier, "nothing was sent" assertions would pass vacuously.
 */
async function wire(client: Client): Promise<string[]> {
  const res = await callTool(client, "scpi_query", { command: "*OPC?" });
  expect(getText(res)).toBe("1");
  return sim.commands();
}

function simEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { SIGLENT_SDG_IP: "127.0.0.1", SIGLENT_SDG_PORT: String(simPort), ...extra };
}

async function connectedServer(extra: Record<string, string> = {}) {
  const ctx = await createTestServer(simEnv(extra));
  const res = await callTool(ctx.client, "connect");
  expect(getText(res)).toContain(SIM_IDN);
  sim.clear();
  sim.resetState();
  return ctx;
}

describe("default configuration", () => {
  let ctx: Awaited<ReturnType<typeof connectedServer>>;

  beforeAll(async () => {
    ctx = await connectedServer();
  });
  afterAll(async () => {
    await ctx.cleanup();
  });
  beforeEach(() => {
    sim.clear();
    sim.resetState();
  });

  it("does not expose the raw scpi_command tool", async () => {
    const { tools } = await ctx.client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("scpi_command");
    expect(names).toContain("scpi_query");
  });

  it("still performs legitimate operations", async () => {
    const res = await callTool(ctx.client, "configure_basic_wave", {
      channel: "C1",
      waveform_type: "SINE",
      frequency: 1000,
      amplitude: 2,
    });
    expect(res.isError).toBeFalsy();
    expect(await wire(ctx.client)).toEqual(["C1:BSWV WVTP,SINE,FRQ,1000,AMP,2"]);
  });

  it("switches an output on without a read-back when no limits are configured", async () => {
    const res = await callTool(ctx.client, "configure_output", { channel: "C1", state: "ON" });
    expect(res.isError).toBeFalsy();
    expect(await wire(ctx.client)).toEqual(["C1:OUTP ON"]);
  });

  it("allows reset and channel copy when no limits are configured", async () => {
    await callTool(ctx.client, "reset");
    await callTool(ctx.client, "copy_channel", { source: "C2", destination: "C1" });
    expect(await wire(ctx.client)).toEqual(["*RST", "PACP C1,C2"]);
  });

  describe("F1: scpi_query cannot change instrument state", () => {
    it("accepts an absolute query with a leading root colon", async () => {
      const res = await callTool(ctx.client, "scpi_query", { command: ":SENSe:COUNTer:FREQuency?" });
      expect(res.isError).toBeFalsy();
    });

    it("answers a real query", async () => {
      const res = await callTool(ctx.client, "scpi_query", { command: "C1:OUTP?" });
      expect(getText(res)).toBe("C1:OUTP OFF,LOAD,HZ,PLRT,NOR");
    });

    it.each(["C1:OUTP ON", "C1:OUTP?;C1:OUTP ON", "C1:OUTP?\nC1:OUTP ON", "*RST"])(
      "rejects %j and sends nothing",
      async (command) => {
        await expectRejected(ctx.client, "scpi_query", { command });
        expect(await wire(ctx.client)).toEqual([]);
        expect(sim.channels.C1.output).toBe("OFF");
      }
    );
  });

  describe("F2: injection through string parameters", () => {
    it("rejects a newline in configure_output.load", async () => {
      await expectRejected(ctx.client, "configure_output", {
        channel: "C1",
        load: "50\nC1:OUTP ON",
      });
      expect(await wire(ctx.client)).toEqual([]);
      expect(sim.channels.C1.output).toBe("OFF");
    });

    it("rejects a compound command in configure_output.load", async () => {
      await expectRejected(ctx.client, "configure_output", { channel: "C1", load: "50;C1:OUTP ON" });
      expect(await wire(ctx.client)).toEqual([]);
    });

    it("rejects injection in configure_burst.cycles", async () => {
      await expectRejected(ctx.client, "configure_burst", { channel: "C1", cycles: "1\nC1:OUTP ON" });
      expect(await wire(ctx.client)).toEqual([]);
    });

    it("rejects quote break-out in set_arbitrary_wave.name", async () => {
      await expectRejected(ctx.client, "set_arbitrary_wave", {
        channel: "C1",
        name: 'x",MAX_OUTPUT_AMP,20,"',
      });
      expect(await wire(ctx.client)).toEqual([]);
    });

    it("accepts valid values for the same parameters", async () => {
      await callTool(ctx.client, "configure_output", { channel: "C1", load: "50" });
      await callTool(ctx.client, "configure_output", { channel: "C1", load: "HZ" });
      await callTool(ctx.client, "configure_burst", { channel: "C1", cycles: "INF" });
      await callTool(ctx.client, "set_arbitrary_wave", { channel: "C1", name: "Local/wave1.bin" });
      expect(await wire(ctx.client)).toEqual([
        "C1:OUTP LOAD,50",
        "C1:OUTP LOAD,HZ",
        "C1:BTWV TIME,INF",
        'C1:ARWV NAME,"Local/wave1.bin"',
      ]);
    });
  });

  describe("F3: connect cannot be used as a network pivot", () => {
    it.each([
      ["cloud metadata endpoint", { host: "169.254.169.254" }],
      ["another host on the LAN", { host: "192.168.1.1" }],
      ["a different port on the instrument host", { host: "127.0.0.1", port: 22 }],
    ])("rejects %s", async (_label, args) => {
      const text = await expectRejected(ctx.client, "connect", args);
      expect(text).toMatch(/not allowed|not in the allowed list/);
    });
  });
});

describe("raw SCPI explicitly enabled", () => {
  let ctx: Awaited<ReturnType<typeof connectedServer>>;

  beforeAll(async () => {
    ctx = await connectedServer({ SIGLENT_ALLOW_RAW_SCPI: "true" });
  });
  afterAll(async () => {
    await ctx.cleanup();
  });
  beforeEach(() => {
    sim.clear();
    sim.resetState();
  });

  it("exposes scpi_command and sends a single command", async () => {
    const res = await callTool(ctx.client, "scpi_command", { command: "C1:OUTP ON" });
    expect(res.isError).toBeFalsy();
    expect(await wire(ctx.client)).toEqual(["C1:OUTP ON"]);
  });

  it.each(["C1:OUTP ON\n*RST", "C1:OUTP ON;*RST"])(
    "still rejects command smuggling in %j",
    async (command) => {
      await expectRejected(ctx.client, "scpi_command", { command });
      expect(await wire(ctx.client)).toEqual([]);
    }
  );
});

describe("F4: output limits", () => {
  let ctx: Awaited<ReturnType<typeof connectedServer>>;

  beforeAll(async () => {
    ctx = await connectedServer({
      SIGLENT_MAX_AMPLITUDE_VPP: "5",
      SIGLENT_MAX_VOLTAGE: "3",
      SIGLENT_ALLOW_RAW_SCPI: "true", // must be ignored: limits and raw SCPI are exclusive
    });
  });
  afterAll(async () => {
    await ctx.cleanup();
  });
  beforeEach(() => {
    sim.clear();
    sim.resetState();
  });

  it("drops scpi_command even though it was requested", async () => {
    const { tools } = await ctx.client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("scpi_command");
  });

  it("accepts high/low levels whose span is within the limit", async () => {
    const res = await callTool(ctx.client, "configure_basic_wave", { channel: "C1", high_level: 2, low_level: -2 });
    expect(res.isError).toBeFalsy();
    expect(await wire(ctx.client)).toEqual(["C1:BSWV HLEV,2,LLEV,-2"]);
  });

  describe("read-back before switching an output on", () => {
    it("switches on when the instrument's settings are within limits", async () => {
      // Simulator default is 4 Vpp, 0 V: within 5 Vpp / ±3 V.
      const res = await callTool(ctx.client, "configure_output", { channel: "C1", state: "ON" });
      expect(res.isError).toBeFalsy();
      expect(await wire(ctx.client)).toEqual(["C1:BSWV?", "C1:OUTP ON"]);
      expect(sim.channels.C1.output).toBe("ON");
    });

    it("refuses when the amplitude was set over the limit outside the server (e.g. front panel)", async () => {
      sim.channels.C1.amp = 8;
      const text = await expectRejected(ctx.client, "configure_output", { channel: "C1", state: "ON", load: "50" });
      expect(text).toMatch(/Output not switched on/);
      expect(await wire(ctx.client)).toEqual(["C1:BSWV?"]);
      expect(sim.channels.C1.output).toBe("OFF");
    });

    it("refuses when individually valid changes combine to an over-limit peak", async () => {
      // amplitude 5 then offset 2.5 are each within 5 Vpp / ±3 V, but the peak is 5 V.
      await callTool(ctx.client, "configure_basic_wave", { channel: "C1", amplitude: 5 });
      await callTool(ctx.client, "configure_basic_wave", { channel: "C1", offset: 2.5 });
      const text = await expectRejected(ctx.client, "configure_output", { channel: "C1", state: "ON" });
      expect(text).toMatch(/HLEV 5 V exceeds/);
      expect(sim.channels.C1.output).toBe("OFF");
    });

    it("fails closed when the read-back can't be parsed", async () => {
      sim.bswvReplyOverride = "C1:BSWV GARBAGE";
      const text = await expectRejected(ctx.client, "configure_output", { channel: "C1", state: "ON" });
      expect(text).toMatch(/Cannot verify/);
      expect(sim.channels.C1.output).toBe("OFF");
    });

    it("needs no read-back to switch an output off", async () => {
      const res = await callTool(ctx.client, "configure_output", { channel: "C1", state: "OFF" });
      expect(res.isError).toBeFalsy();
      expect(await wire(ctx.client)).toEqual(["C1:OUTP OFF"]);
    });
  });

  it("allows output within limits", async () => {
    const res = await callTool(ctx.client, "configure_basic_wave", {
      channel: "C1",
      amplitude: 5,
      offset: -3,
    });
    expect(res.isError).toBeFalsy();
    expect(await wire(ctx.client)).toEqual(["C1:BSWV AMP,5,OFST,-3"]);
  });

  it.each([
    ["reset (recalls 4 Vpp default)", "reset", {}],
    ["channel copy (other channel may be over the limit)", "copy_channel", { source: "C2", destination: "C1" }],
    ["high/low span over the amplitude limit", "configure_basic_wave", { channel: "C1", high_level: 3, low_level: -3 }],
    ["a single level while an amplitude limit is set", "configure_basic_wave", { channel: "C1", high_level: 2 }],
    ["basic amplitude", "configure_basic_wave", { channel: "C1", amplitude: 20 }],
    ["basic offset", "configure_basic_wave", { channel: "C1", offset: 4 }],
    ["amplitude in Vrms", "configure_basic_wave", { channel: "C1", amplitude_vrms: 1 }],
    ["modulation carrier", "configure_modulation", { channel: "C1", carrier_amplitude: 10 }],
    ["sweep carrier", "configure_sweep", { channel: "C1", carrier_amplitude: 10 }],
    ["burst carrier", "configure_burst", { channel: "C1", carrier_offset: 5 }],
  ])("rejects %s over the limit and sends nothing", async (_label, tool, args) => {
    const text = await expectRejected(ctx.client, tool, args);
    expect(text).toMatch(/limit|not allowed/);
    expect(await wire(ctx.client)).toEqual([]);
  });
});
