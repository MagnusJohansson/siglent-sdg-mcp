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
 * form (*RST?, *TST?, *CLS?) are actions, or would run a self-test. *ESR? is
 * excluded too: reading the Event Status Register clears it, which a tool
 * marked read-only must not do.
 */
const COMMON_QUERIES = new Set(["IDN", "OPC", "STB", "ESE", "SRE", "OPT"]);

/**
 * A SCPI mnemonic as a regex source: the short form (the upper-case part)
 * followed by any leading part of the rest, so "MTRigger" matches MTR, MTRI,
 * ... MTRIGGER. SCPI only defines the short and long forms; accepting the
 * lengths in between is deliberate, because this list blocks, and blocking a
 * spelling the firmware might also accept is the safe direction.
 */
function mnemonic(m: string): string {
  const short = /^[A-Z0-9]+/.exec(m)?.[0] ?? "";
  const tail = m.slice(short.length).toUpperCase();
  return short + [...tail].reduceRight((rest, ch) => `(?:${ch}${rest})?`, "");
}

/**
 * A header pattern written in the programming guide's notation:
 * "<ch>:" an optional channel prefix (C1:, C2:), "A|B" alternatives,
 * "[:NODE]" an optional node, and a trailing "#" a node number (SEGMent3).
 */
function headerPattern(spec: string): RegExp {
  let source = "";
  let rest = spec;
  if (rest.startsWith("<ch>:")) {
    source = "(?:C\\d+:)?";
    rest = rest.slice("<ch>:".length);
  }
  const nodes = rest.match(/\[:[^\]]+\]|[^:[\]]+/g) ?? [];
  nodes.forEach((node, i) => {
    const optional = node.startsWith("[");
    let body = optional ? node.slice(2, -1) : node;
    const numbered = body.endsWith("#");
    if (numbered) body = body.slice(0, -1);
    const pattern = `(?:${body.split("|").map(mnemonic).join("|")})${numbered ? "\\d*" : ""}`;
    source += optional ? `(?::${pattern})?` : `${i === 0 ? "" : ":"}${pattern}`;
  });
  return new RegExp(`^${source}$`, "i");
}

/**
 * Commands the SDG programming guide documents with no query form: actions
 * (trigger, clear, delete, copy, save, load) and setters whose bare form
 * creates or deletes something. The shape check can't tell "C1:TRIGger?" from
 * a real query, and whether the firmware ignores the '?' or runs the action
 * isn't documented, so a tool marked read-only must not send them.
 *
 * Matched against the whole header, so queries that share a node with an
 * action (C1:TRIGger:SOURce?, C1:TRIGger:TIMer?) are unaffected. The channel
 * prefix is optional: blocking the form without it too is the safe direction.
 * Defence in depth on top of the shape check; undocumented headers remain a
 * residual risk (see docs/threat-model.md).
 */
const ACTION_HEADERS = [
  "<ch>:SWEep:MTRigger",
  "<ch>:TRIGger[:SEQuence][:IMMediate]",
  "<ch>:SEQuence:DEFAult|NEW|RECall|SAVe",
  "<ch>:SEQuence:SEGMent#:DELEte|INSErt",
  "<ch>:FHOP:AFLIst|DFLIst|CFLIst|MFLIst|LFLIst|SFLIst",
  "<ch>:FHOP:AOLIst|DOLIst|COLIst|MOLIst|LOLIst|SOLIst",
  "<ch>:FHOP:AALIst|DALIst|CALIst|LALIst|SALIst",
  "SENSe:COUNTer:CLEar",
  "PACP|PARACOPY",
  "VKEY|VIRTUALKEY",
  "MMEMory:DELete|RDIRectory|MDIRectory|COPY|MOVE|TRANsfer",
  "MMEMory:SAVE|LOAD:XML",
].map((spec) => ({ spec, header: headerPattern(spec) }));

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
  if (prefix !== "*") {
    const action = ACTION_HEADERS.find((a) => a.header.test(header));
    if (action) {
      throw new ScpiPolicyError(
        `"${header}?" is not allowed: ${action.spec} is an action command with no documented ` +
          "query form, and the instrument might run it."
      );
    }
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
