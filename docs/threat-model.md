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
| F1 | `scpi_query` was annotated `readOnlyHint: true` but wrote any string to the socket. `scpi_query("C1:OUTP ON")` switched the output on, then timed out waiting for a reply. | A client auto-approving "read-only" tools would let a state change through without asking. | Every query is checked structurally: it must be a single header immediately followed by `?`. This is an **allowlist of shape**, not a denylist of setter keywords, so long-form headers can't get around it. Enforced in `connection.query()`, so it covers every tool. |
| F2 | String parameters (`configure_output.load`, `configure_burst.cycles`, `set_arbitrary_wave.name`, raw SCPI) were interpolated into commands unchecked. A `\n` or `;` injected extra commands; a `"` broke out of the quoted waveform name. | Any tool with a string parameter was effectively a raw command channel. | Two layers. (a) **Command-boundary check** on every string written to the socket: no control characters, no `;`, ASCII only, max length. (b) **Strict formats** for each free-text parameter. Layer (a) stops command smuggling even if a schema is wrong; layer (b) is the only defence against quote break-out *within* a single command, which (a) can't see. |
| F3 | `connect` accepted any host and port. | Combined with raw SCPI: a line-oriented TCP client to anything reachable, e.g. a cloud metadata endpoint, internal HTTP services or Redis. | Hosts restricted to `SIGLENT_SDG_IP` and `SIGLENT_ALLOWED_HOSTS`. If neither is set, only private-LAN IP literals are accepted (no host names, loopback or link-local). Ports restricted to 5025 and the configured instrument port. |
| F4 | No limits on output amplitude or voltage. | Excessive agency with a physical consequence. | Optional `SIGLENT_MAX_AMPLITUDE_VPP` / `SIGLENT_MAX_VOLTAGE`, checked at the connection on every waveform command, whichever tool built it. Units whose peak can't be bounded (Vrms, dBm) and attempts to raise the instrument's own `MAX_OUTPUT_AMP` are rejected while limits are active. Raw SCPI is disabled while limits are active, because a raw channel can't be held to a limit. |

The raw `scpi_command` tool is also **off by default** now (`SIGLENT_ALLOW_RAW_SCPI=true` enables it), and `reset` / `scpi_command` carry `destructiveHint: true`.

## Findings from independent review of the first fix

An automated code review (GitHub Copilot) of the first version of these fixes found five valid issues. A sixth, more fundamental gap followed from them. All six are fixed in 2.0.0.

| # | Finding | Fix |
|---|---------|-----|
| R1 | The hardware check used "output ON" as its injection payload. If a guard regressed, the safety test itself would energize the output, and it carried on afterwards. | Probes now use a harmless frequency change (1000 → 1234 Hz) and verify it's unchanged. The output state is read after every probe; if it's ever ON, the script switches it off and aborts. |
| R2 | `reset` (`*RST`) and `copy_channel` (`PACP`) replace voltage settings without an `AMP`/`OFST` token, so they got around the limits. `*RST` recalls 4 Vpp on an SDG1032X. | Both are rejected while limits are active. |
| R3 | High/low levels were only checked against the voltage limit. `HLEV 3, LLEV -3` passed a 5 Vpp cap while asking for 6 Vpp. | The span is checked when both are given. A single level is rejected while an amplitude cap is active, because the other level isn't known. |
| R4 | The test helper's `try/catch` also caught its own "expected rejected" assertion, so a tool that **succeeded** without sending anything would pass a rejection test. | Only the tool call is inside the `try`; the assertion is outside. |
| R5 | Valid absolute queries with a root colon (`:SENSe:COUNTer:FREQuency?`) were rejected. | An optional leading `:` is allowed; the single-header and `?` checks are unchanged. |
| R6 | **Limits guarded writes, not state.** An output could be switched on while the instrument was already over the limit: set on the front panel, before the server started, or through individually valid changes that combine to a higher peak. | Before switching an output on, the server reads back `Cn:BSWV?` and checks amplitude, offset and high/low levels. High/low levels include the offset, so the combined peak is checked here. A reply that can't be parsed refuses the output (fail closed). |

The lesson: the first fix guarded the **commands**; the review showed the property that matters is the **voltage at the output terminal when it's on**. R6 checks that property directly, at the moment it starts to matter.

## Design principle

**One choke point, closest to the wire.** All checks that guard the instrument run in `connection.ts`, after a tool has built its command and before it's written. A new tool, or a bug in an existing one, can't skip them. Per-tool schema validation sits on top as an extra layer, not instead.

## Residual risks (accepted or deferred)

| Risk | Status |
|------|--------|
| **The instrument itself has no authentication.** Anyone who can reach TCP 5025 controls it directly and bypasses this server entirely. | Out of the server's control. Mitigation: network segmentation (instrument VLAN, host firewall). |
| **Other clients on port 5025.** The SDG1032X accepts several TCP connections at once. Another client (a second server instance, a script) can change settings underneath this server, and replies can interleave and time out. | Not detectable from the server. Mitigation: one controller per instrument, network segmentation. |
| **Combined peak while the output is already on.** The read-back before switching on catches a combined peak (offset plus amplitude/2) at that moment. Changes made *while the output is on* are still checked per command, so an offset change after switching on isn't checked against the amplitude already set. Modulation depth over 100 %, amplitude sweeps and arbitrary waveforms are also not covered by the read-back, which reads basic-wave settings only. | Partly fixed (R6). Remaining: re-check after every change while the output is on. Backstop: set the generator's own `MAX_OUTPUT_AMP`. |
| **Turning the output on needs no confirmation.** | Planned: human-in-the-loop confirmation (MCP elicitation) for physical actions. |
| **No caller identity in stdio mode.** Whoever can start the process has full access; that is the stdio trust model. | Planned: HTTP transport with OAuth 2.1 (Keycloak as authorization server), per-tool scopes, policy-based authorization. |
| **No audit trail** of tool calls. | Planned with the HTTP/OAuth work: one structured log line per call, tied to token identity. |
| **Prompt injection via instrument responses** (e.g. a crafted waveform name returned by a query). | Low: responses are short and mostly numeric. Server-side enforcement means an injected instruction still hits the same limits. |
| **Supply chain:** npm dependencies and base image are not yet pinned by digest, and images are not signed. | Planned: digest pinning, signed images, SBOM and continuous monitoring. |

## How this is tested

`tests/integration/security.test.ts` runs a real MCP client against the real server, over a real TCP socket to a SCPI simulator (`tests/simulator/`). Each rejection is checked by **what did not reach the simulator**. A `*OPC?` round trip is used as a sync barrier, so "nothing was sent" can't pass just because the bytes hadn't arrived yet. With the connection-layer checks disabled, 12 of the original 26 end-to-end tests fail. Each review fix (R2, R3, R6) was checked the same way: with its guard disabled, the tests written for it fail.

`scripts/hardware-check.mjs` repeats the security checks against a real SDG1032X and confirms each one by reading the instrument state back (24 of 24 pass). It doesn't exercise the read-back before switching on, because testing that means asking for output ON. The simulator tests cover it.
