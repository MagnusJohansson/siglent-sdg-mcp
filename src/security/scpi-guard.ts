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
 * Query shape: an optional root colon or '*', a header, then '?' immediately
 * after it, optionally followed by parameters.
 *
 * This is a structural check (allowlist of shape), not a denylist of setter
 * keywords, so long-form headers or unusual setters cannot slip through:
 * anything without '?' directly after the header is not a query.
 */
const QUERY_PATTERN = /^(\*|:)?([A-Za-z][A-Za-z0-9_:]*)\?(?: ([A-Za-z0-9_,.+\-"/ ]*))?$/;

/**
 * Queries that legitimately take parameters after the '?', each with the
 * exact parameter shapes the SDG programming guide documents. For any other
 * query, trailing parameters are rejected: whether the instrument ignores
 * them or acts on them ("C1:BSWV? FRQ,1234") is firmware-dependent, so they
 * are not allowed through a tool that promises to be read-only.
 *
 * WVDT? is deliberately absent: its reply is binary waveform data, which the
 * text query path can't frame, and its parameters overlap the WVDT setter.
 */
const QUOTED_PATH = '"[A-Za-z0-9_\\-./ ]{1,64}"';
const QUERY_PARAMETER_RULES: Array<{ name: string; header: RegExp; params: RegExp }> = [
  {
    // STL?, STL? BUILDIN, STL? USER, STL? USER,"net_storage/wave"
    name: "STL?",
    header: /^(STL|STORELIST)$/i,
    params: new RegExp(`^(BUILDIN|USER(,${QUOTED_PATH})?)$`, "i"),
  },
  {
    // MMEMory:CATalog? "Local" (and the :DATA:ARBitrary / :STATe:XMLanguage variants)
    name: "MMEMory:CATalog?",
    header: /^MMEM(ORY)?:CAT(ALOG)?(:DATA:ARB(ITRARY)?|:STAT(E)?:XML(ANGUAGE)?)?$/i,
    params: new RegExp(`^${QUOTED_PATH}$`),
  },
];

/**
 * IEEE 488.2 common commands that are pure queries. Others that accept a '?'
 * form (*RST?, *TST?, *CLS?) are actions, or would run a self-test.
 */
const COMMON_QUERIES = new Set(["IDN", "OPC", "ESR", "STB", "ESE", "SRE", "OPT"]);

export function assertIsQuery(cmd: string): void {
  assertWireSafe(cmd);
  const m = QUERY_PATTERN.exec(cmd.trim());
  if (!m) {
    throw new ScpiPolicyError(
      `Not a SCPI query: "${cmd}". A query must be a single header ending in '?' ` +
        "(e.g. 'C1:BSWV?'). Commands that change instrument state are not allowed here."
    );
  }
  const [, prefix, header, params] = m;
  const name = header.toUpperCase();

  if (prefix === "*" && !COMMON_QUERIES.has(name)) {
    throw new ScpiPolicyError(
      `"*${name}?" is not allowed: only the common queries ` +
        `${[...COMMON_QUERIES].map((q) => `*${q}?`).join(", ")} are permitted.`
    );
  }
  if (params !== undefined && params.trim() !== "") {
    const rule = QUERY_PARAMETER_RULES.find((r) => r.header.test(header));
    if (!rule) {
      throw new ScpiPolicyError(
        `Parameters after '?' are only allowed for ${QUERY_PARAMETER_RULES.map((r) => r.name).join(", ")}. ` +
          `"${cmd}" could be interpreted as a command by the instrument.`
      );
    }
    if (!rule.params.test(params.trim())) {
      throw new ScpiPolicyError(
        `Parameters "${params.trim()}" are not a documented form for ${rule.name}.`
      );
    }
  }
}
