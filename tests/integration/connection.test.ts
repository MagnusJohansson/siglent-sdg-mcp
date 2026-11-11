/**
 * Connection lifecycle against the SCPI simulator.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { SdgSimulator, SIM_IDN } from "../simulator/sdg-simulator.js";
import { connection } from "../../src/connection.js";

let sim: SdgSimulator;
let port: number;

beforeAll(async () => {
  sim = new SdgSimulator();
  port = await sim.start();
});

afterAll(async () => {
  await sim.stop();
});

afterEach(() => {
  connection.disconnect();
});

describe("overlapping connect calls", () => {
  it("lets a newer connect win without the older one tearing it down", async () => {
    // Reproduces auto-connect still initializing when the `connect` tool is
    // called: previously the older attempt's error path called disconnect()
    // and killed the newer socket, so both failed.
    const first = connection.connect("127.0.0.1", port);
    await new Promise((r) => setTimeout(r, 20)); // first is now mid-initialization
    const second = connection.connect("127.0.0.1", port);

    const [r1, r2] = await Promise.allSettled([first, second]);

    expect(r2.status).toBe("fulfilled");
    expect(r2.status === "fulfilled" && r2.value).toBe(SIM_IDN);
    expect(r1.status).toBe("rejected");
    expect(connection.isConnected()).toBe(true);
    expect(await connection.query("*IDN?")).toBe(SIM_IDN);
  });

  it("handles two connects started at the same moment", async () => {
    const [r1, r2] = await Promise.allSettled([
      connection.connect("127.0.0.1", port),
      connection.connect("127.0.0.1", port),
    ]);
    expect(r2.status).toBe("fulfilled");
    expect(r1.status).toBe("rejected");
    expect(connection.isConnected()).toBe(true);
    expect(await connection.query("*IDN?")).toBe(SIM_IDN);
  });
});
