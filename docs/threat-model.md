# Threat model: siglent-sdg-mcp

**Scope:** version 2.0.0, stdio transport, one Siglent SDG waveform generator on a lab network.
**Out of scope for now:** the HTTP transport and OAuth authorization (planned), the MCP client, and the model itself.

## What we are protecting

| Asset | Why it matters |
|-------|----------------|
| **The device under test (DUT)** connected to the generator output | A wrong amplitude or offset can physically damage it. This is the asset with real consequences. |
| **The generator's configuration** | An unexpected reset, a changed load setting or a raised output limit makes later measurements wrong without anyone noticing. |
| **The lab network** | The server runs on a machine that can reach other hosts. It shouldn't become a way to reach them. |

## Trust boundaries

```
 user ──► MCP client + model ──(1)──► siglent-sdg-mcp ──(2)──► TCP 5025 ──► SDG ──► DUT
                ▲                            │
   documents, web pages, tool output        (3) any host:port the machine can reach
   (prompt injection enters here)
```

1. **Model → server.** Every tool argument is **untrusted**. The model may have been steered by content it read (a datasheet, a web page, a previous tool result). The server can't tell what the user asked for apart from what injected text asked for, so it has to enforce constraints that hold either way.
2. **Server → instrument.** SCPI over raw TCP: newline-terminated, no authentication, no integrity. Anything written to the socket is executed.
3. **Server → network.** The `connect` tool chooses where the socket goes.

Tool annotations such as `readOnlyHint` are **hints for the client, not controls**. Clients may auto-approve tools marked read-only, so a wrong annotation directly weakens the user's approval step.

## Findings in version 1.0.0 and their fixes

| # | Finding | Impact | Fix in 2.0.0 |
|---|---------|--------|--------------|
| F1 | `scpi_query` was annotated `readOnlyHint: true` but wrote any string to the socket. `scpi_query("C1:OUTP ON")` switched the output on, then timed out waiting for a reply. | A client auto-approving "read-only" tools would let a state change through without asking. | Every query is checked structurally: a single header immediately followed by `?`. This is an **allowlist of shape**, not a denylist of setter keywords, so long-form headers can't get around it. Parameters after `?` are only accepted for queries that take them (`STL?`, `MMEMory:CATalog?`), and `*` commands only as pure queries (`*IDN?`, `*OPC?`, ...; not `*ESR?`, which clears the event status register as it reads it), because `C1:BSWV? AMP,10` or `*RST?` might be executed as commands. Since 2.0.5, action commands the programming guide documents with no query form (`C1:TRIGger?`, `C1:FHOP:CFLIst?`, `MMEMory:SAVE:XML?`, ...) are rejected in `?` form too, in long, short and lower-case spellings. Enforced in `connection.query()`, so it covers every tool. |
| F2 | String parameters (`configure_output.load`, `configure_burst.cycles`, `set_arbitrary_wave.name`, raw SCPI) were interpolated into commands unchecked. A `\n` or `;` injected extra commands; a `"` broke out of the quoted waveform name. | Any tool with a string parameter was effectively a raw command channel. | Two layers. (a) **Command-boundary check** on every string written to the socket: no control characters, no `;`, ASCII only, max length. (b) **Strict formats** for each free-text parameter. Layer (a) stops command smuggling even if a schema is wrong; layer (b) is the only defence against quote break-out *within* a single command, which (a) can't see. |
| F3 | `connect` accepted any host and port. | Combined with raw SCPI: a line-oriented TCP client to anything reachable, e.g. a cloud metadata endpoint, internal HTTP services or Redis. | Hosts restricted to `SIGLENT_SDG_IP` and `SIGLENT_ALLOWED_HOSTS`. If neither is set, only private-LAN IP literals are accepted (no host names, loopback or link-local). Ports restricted to 5025 and the configured instrument port. Raw SCPI can only be enabled with named hosts, because "any private-LAN IP on 5025" also matches bench power supplies and electronic loads. |
| F4 | No limits on output amplitude or voltage. | Excessive agency with a physical consequence. | **Not fixed in 2.0.0.** See the next section. |

The raw `scpi_command` tool is also **off by default** now (`SIGLENT_ALLOW_RAW_SCPI=true` enables it), and `reset` / `scpi_command` carry `destructiveHint: true`.

## Output limits: built, reviewed, and withdrawn

A first version of server-side output limits (`SIGLENT_MAX_AMPLITUDE_VPP`, `SIGLENT_MAX_VOLTAGE`) was built for this release and went through two rounds of independent review.

**Round 1 (GitHub Copilot)** found that `*RST` and channel copy bypassed the limits, and that the span between high and low level wasn't checked. It also found two problems in the tests and the hardware check (below). The response added a read-back of the instrument's settings before switching an output on.

**Round 2 (a separate Claude review session, with proof-of-concept tests in the simulator)** showed the design was still bypassable in four confirmed ways:

1. Amplitude and offset were checked separately, never their combined peak, and nothing was checked while the output was on. With 5 Vpp / ±3 V limits, `amplitude 5, offset 3` gave a 5.5 V peak on a live output.
2. The read-back before switching on wasn't atomic with the switch-on. Two tool calls in parallel produced read-back → waveform change → output ON, energizing the new, unchecked settings.
3. A late reply from a timed-out query could be consumed by the next query. A C2 reply satisfied C1's read-back, and C1 came on at 8 Vpp against a 5 Vpp limit.
4. Limits compared against the *displayed* voltage, which depends on the configured load. A 50 Ω setting driving a high-impedance circuit gives about twice the displayed voltage, and the load setting was unrestricted.

It also found that two tests asserted the unsafe behaviour as correct, and that multi-command tools could apply part of a change before rejecting the rest.

**Decision:** a limit that can be bypassed is worse than no limit, because people trust it. The limits were removed from 2.0.0, and the work continues on a separate branch (`security/output-limits`) as a redesign. The redesign uses one lock around all instrument traffic, resets the connection after a timeout, accepts no waveform changes while an output is on, and does a full read-back before switch-on (amplitude, offset, load, modulation, coupling).

**The lesson:** each round moved the question closer to the property that matters. The first version guarded *commands*. Round 1 moved to *the settings at switch-on*. Round 2 showed the real property is *the voltage at the terminal, at every moment the output is on, under concurrency*. That needs an interlock, not a filter.

Review findings that apply to the code that was kept, all fixed in 2.0.0:

| # | Finding | Fix |
|---|---------|-----|
| R1 | The hardware check used "output ON" as its injection payload. If a guard regressed, the safety test itself would energize the output, and it carried on afterwards. | Probes use a harmless frequency change (1000 → 1234 Hz) and verify it's unchanged. The output state is read after every probe; if it's ever ON, the script switches it off and aborts. |
| R4 | The test helper's `try/catch` also caught its own "expected rejected" assertion, so a tool that **succeeded** without sending anything would pass a rejection test. | Only the tool call is inside the `try`; the assertion is outside. |
| R5 | Valid absolute queries with a root colon (`:SENSe:COUNTer:FREQuency?`) were rejected. | An optional leading `:` is allowed; the single-header and `?` checks are unchanged. |
| R7 | `scpi_query` accepted parameters after `?` and `*RST?`-style forms. | See F1. |
| R9 | Without named hosts, raw SCPI could reach any SCPI device on the LAN on port 5025. | See F3. |

A third review of the withdrawal commit found no remaining way to change state through `scpi_query`. It did find four further issues, all fixed:
- `SIGLENT_ALLOWED_HOSTS=*` satisfied the named-hosts rule for raw SCPI. `*` is now rejected for it.
- The parameter allowlist was too loose. `STL?` and `MMEMory:CATalog?` now accept only their documented parameter forms.
- `WVDT?` is no longer accepted. Its reply is binary, which the text query path can't frame, and its parameters overlap the `WVDT` setter.
- The unused `queryBinary` path, which had no query-shape check, was removed.

## Design principle

**One choke point, closest to the wire.** All checks that guard the instrument run in `connection.ts`, after a tool has built its command and before it's written. A new tool, or a bug in an existing one, can't skip them. Per-tool schema validation sits on top as an extra layer, not instead.

## Residual risks (accepted or deferred)

| Risk | Status |
|------|--------|
| **No limit on output voltage.** The model can set any amplitude and offset the generator allows (up to 20 Vpp on an SDG1032X), and switch the output on. | Deferred to the output-limits redesign. Backstop now: set the generator's own `MAX_OUTPUT_AMP` (front panel or `C1:BSWV MAX_OUTPUT_AMP,<Vpp>`). The backstop only holds while raw SCPI is off: with raw SCPI on, the model can raise it. Whether `*RST` resets it isn't documented and hasn't been verified. |
| **Turning the output on needs no confirmation.** | Planned: human-in-the-loop confirmation (MCP elicitation) for physical actions. |
| **The instrument itself has no authentication.** Anyone who can reach TCP 5025 controls it directly and bypasses this server entirely. | Out of the server's control. Mitigation: network segmentation (instrument VLAN, host firewall). |
| **Other clients on port 5025.** The SDG1032X accepts several TCP connections at once. Another client (a second server instance, a script) can change settings underneath this server, and replies can interleave and time out. | Not detectable from the server. Mitigation: one controller per instrument, network segmentation. |
| **A late reply after a query timeout** is read as the reply to the next query. With the limits removed this is a correctness issue (a wrong answer to the model), not a bypass. | To be fixed with the redesign: reset the connection after a timeout. |
| **No caller identity in stdio mode.** Whoever can start the process has full access; that is the stdio trust model. | Planned: HTTP transport with OAuth 2.1 (Keycloak as authorization server), per-tool scopes, policy-based authorization. |
| **No audit trail** of tool calls. | Planned with the HTTP/OAuth work: one structured log line per call, tied to token identity. |
| **Action commands in `?` form.** Since 2.0.5, every command the programming guide documents without a query form is rejected in `?` form (the list is in `scpi-guard.ts`; a unit test checks that none of the guide's documented queries is caught by it). Two gaps remain: undocumented headers, which only the shape check covers, and `EQPHASE?`, which stays allowed because the guide documents a response format for it, although `EQPHASE` itself aligns the channel phases. | Accepted: phase alignment doesn't energize anything. Whether the firmware runs an action when `?` is appended hasn't been probed on hardware. |
| **Prompt injection via instrument responses** (e.g. a crafted waveform name returned by a query). | Low: responses are short and mostly numeric. |
| **Supply chain:** npm dependencies and base image are not yet pinned by digest, and images are not signed. | Planned: digest pinning, signed images, SBOM and continuous monitoring. |

## How this is tested

`tests/integration/security.test.ts` runs a real MCP client against the real server, over a real TCP socket to a SCPI simulator (`tests/simulator/`). Each rejection is checked by **what did not reach the simulator**. A `*OPC?` round trip is used as a sync barrier, so "nothing was sent" can't pass just because the bytes hadn't arrived yet. With the connection-layer checks disabled, 15 of the 32 end-to-end tests fail. The others are either positive tests or are also covered by the strict parameter formats, which is the second layer.

Limitation: the simulator replies instantly and in order, and doesn't model load, coupling or slow replies. Races and timing problems can't show up in this suite. That's one reason the limits were withdrawn rather than patched again.

`scripts/hardware-check.mjs` repeats the security checks against a real SDG1032X and confirms each one by reading the instrument state back (17 of 17 pass). Its injection probes use a harmless frequency change as the payload, never an output-ON request.
