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

## Design principle

**One choke point, closest to the wire.** All checks that guard the instrument run in `connection.ts`, after a tool has built its command and before it's written. A new tool, or a bug in an existing one, can't skip them. Per-tool schema validation sits on top as an extra layer, not instead.

## Residual risks (accepted or deferred)

| Risk | Status |
|------|--------|
| **The instrument itself has no authentication.** Anyone who can reach TCP 5025 controls it directly and bypasses this server entirely. | Out of the server's control. Mitigation: network segmentation (instrument VLAN, host firewall). |
| **Combined peak isn't tracked.** Limits are checked per parameter. Offset 3 V plus amplitude 5 Vpp in separate calls gives a 5.5 V peak that neither check sees on its own. Modulation depth over 100 % and amplitude sweeps can also exceed the carrier amplitude. | Deferred: needs state tracking or a read-back of the instrument settings. Backstop: set the generator's own `MAX_OUTPUT_AMP`. |
| **Turning the output on needs no confirmation.** | Planned: human-in-the-loop confirmation (MCP elicitation) for physical actions. |
| **No caller identity in stdio mode.** Whoever can start the process has full access; that is the stdio trust model. | Planned: HTTP transport with OAuth 2.1 (Keycloak as authorization server), per-tool scopes, policy-based authorization. |
| **No audit trail** of tool calls. | Planned with the HTTP/OAuth work: one structured log line per call, tied to token identity. |
| **Prompt injection via instrument responses** (e.g. a crafted waveform name returned by a query). | Low: responses are short and mostly numeric. Server-side enforcement means an injected instruction still hits the same limits. |
| **Supply chain:** npm dependencies and base image are not yet pinned by digest, and images are not signed. | Planned: digest pinning, signed images, SBOM and continuous monitoring. |

## How this is tested

`tests/integration/security.test.ts` runs a real MCP client against the real server, over a real TCP socket to a SCPI simulator (`tests/simulator/`). Each rejection is checked by **what did not reach the simulator**. A `*OPC?` round trip is used as a sync barrier, so "nothing was sent" can't pass just because the bytes hadn't arrived yet. With the connection-layer checks disabled, 12 of the 26 end-to-end tests fail.
