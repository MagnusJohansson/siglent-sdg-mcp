import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config.js";

describe("loadConfig", () => {
  it("defaults to secure settings with an empty environment", () => {
    const c = loadConfig({});
    expect(c.rawScpiEnabled).toBe(false);
    expect(c.defaultHost).toBeUndefined();
    expect(c.defaultPort).toBe(5025);
    expect(c.hostPolicy).toEqual({ allowedHosts: [], allowedPorts: [5025] });
    expect(c.outputLimits).toEqual({ maxAmplitudeVpp: undefined, maxVoltage: undefined });
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
    expect(loadConfig({ SIGLENT_ALLOW_RAW_SCPI: "true" }).rawScpiEnabled).toBe(true);
    expect(loadConfig({ SIGLENT_ALLOW_RAW_SCPI: "no" }).rawScpiEnabled).toBe(false);
  });

  it("refuses raw SCPI when output limits are configured", () => {
    const c = loadConfig({ SIGLENT_ALLOW_RAW_SCPI: "true", SIGLENT_MAX_AMPLITUDE_VPP: "5" });
    expect(c.rawScpiEnabled).toBe(false);
    expect(c.notes.join(" ")).toMatch(/ignored because output limits/);
  });

  it.each([
    ["SIGLENT_MAX_AMPLITUDE_VPP", "-1"],
    ["SIGLENT_MAX_AMPLITUDE_VPP", "five"],
    ["SIGLENT_MAX_VOLTAGE", "0"],
    ["SIGLENT_SDG_PORT", "70000"],
    ["SIGLENT_SDG_PORT", "50.5"],
  ])("fails closed on invalid %s=%s", (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow();
  });
});
