import type { OutputLimits } from "./security/scpi-guard.js";
import type { HostPolicy } from "./security/host-policy.js";

export interface ServerConfig {
  /** Instrument address used for auto-connect and as the default for `connect`. */
  defaultHost?: string;
  defaultPort: number;
  hostPolicy: HostPolicy;
  outputLimits: OutputLimits;
  /** Whether the raw `scpi_command` tool is registered. */
  rawScpiEnabled: boolean;
  /** Human-readable notes about the effective configuration, logged at startup. */
  notes: string[];
}

const DEFAULT_PORT = 5025;

function parsePositiveNumber(name: string, value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive number, got "${value}".`);
  }
  return n;
}

function parsePort(name: string, value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`${name} must be a TCP port (1-65535), got "${value}".`);
  }
  return n;
}

function isTrue(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const notes: string[] = [];

  const defaultHost = (env.SIGLENT_SDG_IP || env.SIGLENT_IP || "").trim() || undefined;
  const defaultPort =
    parsePort("SIGLENT_SDG_PORT", env.SIGLENT_SDG_PORT) ??
    parsePort("SIGLENT_PORT", env.SIGLENT_PORT) ??
    DEFAULT_PORT;

  // Connect-target policy: the configured instrument plus any explicitly
  // allowed hosts. If neither is set, only private-LAN IP literals are accepted.
  const allowedHosts = (env.SIGLENT_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
  if (defaultHost && !allowedHosts.includes(defaultHost)) {
    allowedHosts.push(defaultHost);
  }
  if (allowedHosts.includes("*")) {
    notes.push("WARNING: SIGLENT_ALLOWED_HOSTS=* allows connecting to any host.");
  }

  const outputLimits: OutputLimits = {
    maxAmplitudeVpp: parsePositiveNumber("SIGLENT_MAX_AMPLITUDE_VPP", env.SIGLENT_MAX_AMPLITUDE_VPP),
    maxVoltage: parsePositiveNumber("SIGLENT_MAX_VOLTAGE", env.SIGLENT_MAX_VOLTAGE),
  };
  const limitsActive =
    outputLimits.maxAmplitudeVpp !== undefined || outputLimits.maxVoltage !== undefined;

  // A raw command channel cannot be held to output limits: SCPI has long-form
  // headers and model-specific commands, so any denylist parser is bypassable.
  // Limits and raw SCPI are therefore mutually exclusive.
  let rawScpiEnabled = isTrue(env.SIGLENT_ALLOW_RAW_SCPI);
  if (rawScpiEnabled && limitsActive) {
    rawScpiEnabled = false;
    notes.push(
      "WARNING: SIGLENT_ALLOW_RAW_SCPI ignored because output limits are configured; " +
        "raw commands could bypass them."
    );
  } else if (rawScpiEnabled) {
    notes.push("WARNING: raw scpi_command tool enabled; the model can send any SCPI command.");
  }

  return {
    defaultHost,
    defaultPort,
    hostPolicy: {
      allowedHosts,
      allowedPorts: [...new Set([DEFAULT_PORT, defaultPort])],
    },
    outputLimits,
    rawScpiEnabled,
    notes,
  };
}
