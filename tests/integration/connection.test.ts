/**
 * Connection lifecycle against the SCPI simulator.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { SdgSimulator, SIM_IDN } from "../simulator/sdg-simulator.js";
import { connection, DEFAULT_OPTIONS, SiglentConnection } from "../../src/connection.js";
import { assertConnectAllowed } from "../../src/security/host-policy.js";
import { ScpiPolicyError } from "../../src/security/scpi-guard.js";

let sim: SdgSimulator;
let port: number;

beforeAll(async () => {
  sim = new SdgSimulator();
  port = await sim.start();
  // The simulator listens on loopback, on a random port; the default policy
  // only allows private-LAN addresses on 5025.
  connection.configure({ hostPolicy: { allowedHosts: ["127.0.0.1"], allowedPorts: [port] } });
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

describe("host policy in connect()", () => {
  // Every connect path (the connect tool, auto-connect) goes through
  // SiglentConnection.connect, so the policy is checked there.
  it("refuses a host outside the policy", async () => {
    await expect(connection.connect("192.168.1.1", port)).rejects.toThrow(ScpiPolicyError);
    expect(connection.isConnected()).toBe(false);
  });

  it("refuses a port outside the policy on an allowed host", async () => {
    await expect(connection.connect("127.0.0.1", 22)).rejects.toThrow(ScpiPolicyError);
  });

  it("leaves the current connection intact when a connect is refused", async () => {
    await connection.connect("127.0.0.1", port);
    await expect(connection.connect("192.168.1.1", port)).rejects.toThrow(ScpiPolicyError);
    expect(connection.isConnected()).toBe(true);
    expect(await connection.query("*IDN?")).toBe(SIM_IDN);
  });

  it("doesn't supersede a connect in progress when a connect is refused", async () => {
    const first = connection.connect("127.0.0.1", port);
    await new Promise((r) => setTimeout(r, 20)); // first is now mid-initialization
    await expect(connection.connect("192.168.1.1", port)).rejects.toThrow(ScpiPolicyError);
    await expect(first).resolves.toBe(SIM_IDN);
    expect(connection.isConnected()).toBe(true);
  });

  it("uses the configured default port", async () => {
    const conn = new SiglentConnection({
      hostPolicy: { allowedHosts: ["127.0.0.1"], allowedPorts: [port] },
      defaultPort: port,
    });
    try {
      await expect(conn.connect("127.0.0.1")).resolves.toBe(SIM_IDN);
    } finally {
      conn.disconnect();
    }
  });

  it("allows only private-LAN addresses on 5025 until configured", async () => {
    const conn = new SiglentConnection();
    // Loopback isn't a private-LAN address, and the simulator's port isn't 5025.
    await expect(conn.connect("127.0.0.1", port)).rejects.toThrow(ScpiPolicyError);
    await expect(conn.connect("127.0.0.1", 5025)).rejects.toThrow(ScpiPolicyError);
    await expect(conn.connect("192.168.1.186", port)).rejects.toThrow(ScpiPolicyError);
    // The allowing half: a private-LAN address on 5025 passes the default policy.
    expect(() => assertConnectAllowed("192.168.1.186", 5025, DEFAULT_OPTIONS.hostPolicy)).not.toThrow();
    expect(() => assertConnectAllowed("10.0.0.5", 5025, DEFAULT_OPTIONS.hostPolicy)).not.toThrow();
  });
});
