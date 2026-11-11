import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config.js";

describe("loadConfig", () => {
  it("defaults to secure settings with an empty environment", () => {
    const c = loadConfig({});
    expect(c.rawScpiEnabled).toBe(false);
    expect(c.defaultHost).toBeUndefined();
    expect(c.defaultPort).toBe(5025);
    expect(c.hostPolicy).toEqual({ allowedHosts: [], allowedPorts: [5025] });
  });

  it("allows the configured instrument host and port", () => {
    const c = loadConfig({ SIGLENT_SDG_IP: "192.168.1.126", SIGLENT_SDG_PORT: "5026" });
    expect(c.hostPolicy.allowedHosts).toEqual(["192.168.1.126"]);
    expect(c.hostPolicy.allowedPorts).toEqual([5025, 5026]);
  });

  it("merges explicitly allowed hosts with the configured instrument", () => {
    const c = loadConfig({ SIGLENT_IP: "10.0.0.5", SIGLENT_ALLOWED_HOSTS: "10.0.0.6, sdg.lab" });
    expect(c.hostPolicy.allowedHosts).toEqual(["10.0.0.6", "sdg.lab", "10.0.0.5"]);
  });

  it("enables raw SCPI only when explicitly asked", () => {
    expect(loadConfig({ SIGLENT_SDG_IP: "192.168.1.126", SIGLENT_ALLOW_RAW_SCPI: "true" }).rawScpiEnabled).toBe(true);
    expect(loadConfig({ SIGLENT_SDG_IP: "192.168.1.126", SIGLENT_ALLOW_RAW_SCPI: "no" }).rawScpiEnabled).toBe(false);
  });

  it("refuses raw SCPI unless the reachable hosts are named", () => {
    // Without named hosts, connect accepts any private-LAN IP on 5025, which
    // includes other SCPI instruments such as bench power supplies.
    expect(() => loadConfig({ SIGLENT_ALLOW_RAW_SCPI: "true" })).toThrow(/requires SIGLENT_SDG_IP/);
    expect(loadConfig({ SIGLENT_ALLOWED_HOSTS: "10.0.0.6", SIGLENT_ALLOW_RAW_SCPI: "true" }).rawScpiEnabled).toBe(true);
  });

  it("does not accept '*' as naming a host for raw SCPI", () => {
    expect(() => loadConfig({ SIGLENT_ALLOWED_HOSTS: "*", SIGLENT_ALLOW_RAW_SCPI: "true" })).toThrow(/'\*' is not accepted/);
    expect(() =>
      loadConfig({ SIGLENT_SDG_IP: "192.168.1.126", SIGLENT_ALLOWED_HOSTS: "*", SIGLENT_ALLOW_RAW_SCPI: "true" })
    ).toThrow(/'\*' is not accepted/);
    // '*' on its own (raw SCPI off) is still allowed, with a warning.
    expect(loadConfig({ SIGLENT_ALLOWED_HOSTS: "*" }).notes.join(" ")).toMatch(/any host/);
  });

  it.each([
    ["SIGLENT_SDG_PORT", "70000"],
    ["SIGLENT_SDG_PORT", "50.5"],
    ["SIGLENT_PORT", "abc"],
  ])("fails closed on invalid %s=%s", (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow();
  });
});
