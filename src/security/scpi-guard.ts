/**
 * SCPI guard: checks applied to every string before it is written to the
 * instrument socket.
 *
 * Tool arguments come from a language model and must be treated as untrusted
 * input. The connection layer is the single choke point every command and
 * query passes through, so these checks live there rather than in each tool.
 */

/** Raised when a command or argument violates the security policy. */
export class ScpiPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScpiPolicyError";
  }
}

/**
 * Reject anything that could smuggle a second command onto the wire.
 *
 * - Control characters (incl. \n and \r): the connection terminates every
 *   command with "\n", so an embedded newline would start a new command.
 * - ';': the SCPI compound-command separator ("C1:OUTP?;C1:OUTP ON").
 * - Non-printable or non-ASCII bytes: SCPI is ASCII; nothing legitimate needs them.
 */
export function assertWireSafe(cmd: string): void {
  if (cmd.length === 0) {
    throw new ScpiPolicyError("Empty SCPI command.");
  }
  if (cmd.length > 512) {
    throw new ScpiPolicyError("SCPI command too long (max 512 characters).");
  }
  for (let i = 0; i < cmd.length; i++) {
    const code = cmd.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) {
      throw new ScpiPolicyError(
        `SCPI command contains a control or non-ASCII character at position ${i} (code ${code}). ` +
          "Embedded newlines would inject additional commands."
      );
    }
  }
  if (cmd.includes(";")) {
    throw new ScpiPolicyError(
      "SCPI compound commands (';') are not allowed. Send one command per call."
    );
  }
}

/**
 * A query is a single SCPI header immediately followed by '?', optionally
 * followed by query parameters, e.g. "*IDN?", "C1:BSWV?", "WVDT? USER,wave1",
 * ":SENSe:COUNTer:FREQuency?" (absolute path with a leading root colon).
 *
 * This is a structural check (allowlist of shape), not a denylist of setter
 * keywords, so long-form headers or unusual setters cannot slip through:
 * anything without '?' directly after the header is not a query.
 */
const QUERY_PATTERN = /^(?:\*|:)?[A-Za-z][A-Za-z0-9_:]*\?(?: [A-Za-z0-9_,.+\-"/ ]*)?$/;

export function assertIsQuery(cmd: string): void {
  assertWireSafe(cmd);
  if (!QUERY_PATTERN.test(cmd.trim())) {
    throw new ScpiPolicyError(
      `Not a SCPI query: "${cmd}". A query must be a single header ending in '?' ` +
        "(e.g. 'C1:BSWV?'). Commands that change instrument state are not allowed here."
    );
  }
}

/** Optional limits on what the instrument may output. Undefined = no limit. */
export interface OutputLimits {
  /** Maximum amplitude in volts peak-to-peak (AMP, and the HLEV-LLEV span). */
  maxAmplitudeVpp?: number;
  /** Maximum absolute voltage for offset, high/low level and noise mean. */
  maxVoltage?: number;
}

export function hasLimits(limits: OutputLimits): boolean {
  return limits.maxAmplitudeVpp !== undefined || limits.maxVoltage !== undefined;
}

/** Waveform-setting headers whose parameters this server generates and can parse. */
const WAVE_HEADER = /^C[12]:(BSWV|MDWV|SWWV|BTWV)$/i;

/**
 * Commands that replace voltage settings wholesale without an AMP/OFST token:
 * *RST recalls the default setup (4 Vpp on an SDG1032X), PACP copies the
 * other channel's settings, which may already be over the limit.
 */
const BULK_STATE_HEADERS = new Set(["*RST", "PACP", "PARACOPY"]);

/** Parameters expressed as an absolute voltage. */
const VOLTAGE_KEYS = new Set(["OFST", "HLEV", "LLEV", "MEAN"]);

/**
 * Parameters whose peak voltage cannot be bounded without knowing other
 * instrument state (Vrms and dBm depend on waveform shape and load), or that
 * would raise the instrument's own limit. Rejected whenever limits are active.
 */
const UNBOUNDED_KEYS = new Set(["AMPVRMS", "AMPDBM", "MAX_OUTPUT_AMP"]);

function splitHeader(cmd: string): { header: string; params: string } {
  const trimmed = cmd.trim().replace(/^:/, "");
  const spaceIndex = trimmed.indexOf(" ");
  return spaceIndex < 0
    ? { header: trimmed, params: "" }
    : { header: trimmed.slice(0, spaceIndex), params: trimmed.slice(spaceIndex + 1) };
}

/**
 * Check a set of voltage parameters against the limits.
 *
 * Used both for commands about to be sent (values are plain numbers) and for
 * instrument read-backs (values carry units, e.g. "1.5V"). `requireBothLevels`
 * is true for commands: a single HLEV or LLEV changes the amplitude by an
 * amount that depends on the other level, which the command doesn't contain.
 */
function checkVoltageParams(
  pairs: Map<string, string>,
  limits: OutputLimits,
  requireBothLevels: boolean
): void {
  const num = (key: string): number | undefined => {
    const raw = pairs.get(key);
    if (raw === undefined) return undefined;
    // Number("") is 0, so an empty value must be rejected explicitly.
    const value = raw.trim() === "" ? NaN : requireBothLevels ? Number(raw) : parseFloat(raw);
    if (!Number.isFinite(value)) {
      throw new ScpiPolicyError(`${key} requires a numeric value, got "${raw}".`);
    }
    return value;
  };

  const amp = num("AMP");
  if (amp !== undefined && limits.maxAmplitudeVpp !== undefined && Math.abs(amp) > limits.maxAmplitudeVpp) {
    throw new ScpiPolicyError(
      `Amplitude ${amp} Vpp exceeds the configured limit of ${limits.maxAmplitudeVpp} Vpp.`
    );
  }

  for (const key of VOLTAGE_KEYS) {
    const v = num(key);
    if (v !== undefined && limits.maxVoltage !== undefined && Math.abs(v) > limits.maxVoltage) {
      throw new ScpiPolicyError(`${key} ${v} V exceeds the configured limit of ±${limits.maxVoltage} V.`);
    }
  }

  const hlev = num("HLEV");
  const llev = num("LLEV");
  if (limits.maxAmplitudeVpp !== undefined) {
    if (hlev !== undefined && llev !== undefined) {
      const span = Math.abs(hlev - llev);
      if (span > limits.maxAmplitudeVpp) {
        throw new ScpiPolicyError(
          `High/low levels ${hlev} V / ${llev} V give ${span} Vpp, exceeding the configured ` +
            `limit of ${limits.maxAmplitudeVpp} Vpp.`
        );
      }
    } else if (requireBothLevels && (hlev !== undefined || llev !== undefined)) {
      throw new ScpiPolicyError(
        "While an amplitude limit is configured, set high_level and low_level together " +
          "(or use amplitude and offset), so the resulting amplitude can be checked."
      );
    }
  }

  // Noise: treat ±3σ as the practical peak-to-peak span.
  const stdev = num("STDEV");
  if (stdev !== undefined && limits.maxAmplitudeVpp !== undefined && 6 * Math.abs(stdev) > limits.maxAmplitudeVpp) {
    throw new ScpiPolicyError(
      `Noise standard deviation ${stdev} V exceeds the configured limit ` +
        `(6σ must be ≤ ${limits.maxAmplitudeVpp} Vpp).`
    );
  }
}

/**
 * Check a command against configured output limits before it is sent.
 *
 * Only commands generated by this server's own tools reach this check when
 * limits are active (raw SCPI is disabled in that case, see config.ts), so the
 * parser only needs to understand the short-form headers those tools emit.
 *
 * Limitation (documented in docs/threat-model.md): this checks each command
 * on its own. Combined effects across calls are checked when an output is
 * switched on (see assertReadbackWithinLimits), but not for changes made
 * while an output is already on, nor for peaks from modulation or sweeps.
 */
export function assertWithinLimits(cmd: string, limits: OutputLimits): void {
  if (!hasLimits(limits)) return;

  const { header, params } = splitHeader(cmd);
  const upperHeader = header.toUpperCase();

  if (BULK_STATE_HEADERS.has(upperHeader)) {
    throw new ScpiPolicyError(
      `${upperHeader} is not allowed while output limits are configured: it replaces voltage ` +
        "settings with values (defaults or the other channel's) that are not checked against the limits."
    );
  }

  if (!WAVE_HEADER.test(header)) return;

  const tokens = params.split(",").map((t) => t.trim().toUpperCase());
  const pairs = new Map<string, string>();
  for (let i = 0; i < tokens.length; i++) {
    const key = tokens[i];
    if (UNBOUNDED_KEYS.has(key)) {
      throw new ScpiPolicyError(
        `${key} is not allowed while output limits are configured. ` +
          "Use amplitude in Vpp so the limit can be enforced."
      );
    }
    if (key === "AMP" || key === "STDEV" || VOLTAGE_KEYS.has(key)) {
      pairs.set(key, tokens[i + 1] ?? "");
    }
  }
  checkVoltageParams(pairs, limits, true);
}

/** Matches a command that switches an output on, e.g. "C1:OUTP ON,LOAD,50". */
export function outputOnChannel(cmd: string): "C1" | "C2" | undefined {
  const { header, params } = splitHeader(cmd);
  const m = /^(C[12]):OUTP(?:UT)?$/i.exec(header);
  if (!m) return undefined;
  const turnsOn = params.split(",").some((t) => t.trim().toUpperCase() === "ON");
  return turnsOn ? (m[1].toUpperCase() as "C1" | "C2") : undefined;
}

/**
 * Check the instrument's actual basic-wave settings (a "Cn:BSWV?" reply)
 * before an output is switched on. This catches over-limit state however it
 * got there: front panel, settings made before the server started, or a
 * sequence of individually valid changes (HLEV/LLEV include the offset, so
 * the combined peak is checked here).
 *
 * Fails closed: a reply that can't be parsed refuses the output.
 */
export function assertReadbackWithinLimits(reply: string, limits: OutputLimits): void {
  if (!hasLimits(limits)) return;

  // Reply looks like "C1:BSWV WVTP,SINE,FRQ,1000HZ,...,AMP,4V,...,OFST,0V,HLEV,2V,LLEV,-2V,PHSE,0"
  // (the header is present when the instrument ignores CHDR OFF).
  const body = reply.trim().replace(/^\S*BSWV\s+/i, "");
  const tokens = body.split(",").map((t) => t.trim().toUpperCase());
  const pairs = new Map<string, string>();
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    if (tokens[i] === "AMP" || tokens[i] === "STDEV" || VOLTAGE_KEYS.has(tokens[i])) {
      pairs.set(tokens[i], tokens[i + 1]);
    }
  }
  if (pairs.size === 0) {
    throw new ScpiPolicyError(
      `Cannot verify the instrument's output settings against the limits (unrecognised reply: ` +
        `"${reply.slice(0, 80)}"). Output not switched on.`
    );
  }
  try {
    checkVoltageParams(pairs, limits, false);
  } catch (err) {
    throw new ScpiPolicyError(
      `Output not switched on: the instrument's current settings exceed the limits. ` +
        (err instanceof Error ? err.message : String(err))
    );
  }
}
