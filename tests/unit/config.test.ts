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

describe("SIGLENT_AUDIT_LOG", () => {
  it.each([
    [undefined, { sink: "stderr", level: "security" }],
    ["", { sink: "stderr", level: "security" }],
    ["stderr", { sink: "stderr", level: "full" }],
    ["STDERR", { sink: "stderr", level: "full" }],
    ["off", { sink: "off" }],
    ["/var/log/sdg.jsonl", { sink: "file", level: "full", path: "/var/log/sdg.jsonl" }],
  ])("%s -> %o", (value, expected) => {
    expect(loadConfig(value === undefined ? {} : { SIGLENT_AUDIT_LOG: value }).audit).toEqual(expected);
  });

  it.each(["audit.jsonl", "./logs/a.jsonl", "on"])("fails closed on %s (not an absolute path)", (value) => {
    expect(() => loadConfig({ SIGLENT_AUDIT_LOG: value })).toThrow(/SIGLENT_AUDIT_LOG/);
  });
});

describe("OTLP export configuration", () => {
  it("is off without an endpoint", () => {
    expect(loadConfig({}).otlp).toBeUndefined();
  });

  it("uses OTEL_EXPORTER_OTLP_ENDPOINT, logged without userinfo, query or fragment", () => {
    const c = loadConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "https://user:pw@collector.example:4318/base?api_key=x#f" });
    expect(c.otlp).toEqual({ endpoint: "https://collector.example:4318/base" });
  });

  it("prefers OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", () => {
    const c = loadConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://a.example:4318",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://b.example:4318/v1/logs",
    });
    expect(c.otlp?.endpoint).toBe("http://b.example:4318/v1/logs");
  });

  it("respects OTEL_SDK_DISABLED", () => {
    expect(loadConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://a.example:4318", OTEL_SDK_DISABLED: "true" }).otlp).toBeUndefined();
  });

  it.each(["not a url", "ftp://a.example/", "localhost:4318"])("fails closed on the endpoint %s", (value) => {
    expect(() => loadConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: value })).toThrow(/OTEL_EXPORTER_OTLP_ENDPOINT/);
  });

  it("notes an unsupported protocol instead of ignoring it silently", () => {
    const c = loadConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://a.example:4318", OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" });
    expect(c.notes.join("\n")).toMatch(/grpc is not supported/);
  });
});
