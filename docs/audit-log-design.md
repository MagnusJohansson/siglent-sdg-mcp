# Design: audit log and OpenTelemetry export

**Status:** proposal, not implemented. Applies to siglent-sdg-mcp and siglent-sds-mcp; the same document is in both repositories. Target: 2.1.0 in each.

## Problem

Both threat models list **"No audit trail of tool calls"** as a residual risk. Today, if a prompt injection makes the model call `scpi_query("C1:OUTP ON")`, the guard refuses it, and nobody learns that it happened. The refusal goes back to the model and is gone. There's also no record of what the server actually sent to the instrument, which is what matters after an incident on the bench.

## Goals

1. Record every MCP request the server receives, and its outcome.
2. Record every guard decision that refuses something, with the rule that refused it.
3. Record every line written to the instrument socket, and every connect attempt, attributed to the tool call that caused it.
4. Make gaps detectable: a reader of the log can tell that events are missing.
5. Optionally ship events off the machine over OpenTelemetry (OTLP), so a compromised server process can't rewrite what has already left.
6. Change nothing for users who don't configure it, beyond what's stated under "Defaults".

## Non-goals

- **Caller identity.** Over stdio there is no authenticated caller. The client's name and version come from its own `initialize` request and are recorded as self-reported. Real identity comes with the planned HTTP transport and OAuth, which will add a `subject` field from the token.
- **Tamper-proof local logs.** A compromised server process runs as the same user as the log file and can rewrite it. See "Integrity".
- **Traces and metrics.** Only the OTEL logs signal. Traces get sampled, and sampling is wrong for an audit trail.
- **Log rotation and retention.** Left to the environment (logrotate, the collector, the backend).
- **Using the log as a control.** The audit log records decisions; it doesn't make them. Nothing is allowed or refused because of it.

## Where events are emitted

Both servers already have a single choke point for instrument traffic: `SiglentConnection` in `src/connection.ts`. Every `sendCommand`, `query` and (sds) `queryBinary` passes through it, and so do the guards (`assertWireSafe`, `assertIsQuery`). Events come from three places:

| Source | Hook | Events |
|---|---|---|
| MCP transport | Wrap `transport.onmessage` and `transport.send` in `src/index.ts`, after `server.connect(transport)` | `mcp.request`, `mcp.response` |
| Guards | `ScpiPolicyError`, which both the SCPI guard and the host policy throw, caught and re-thrown in `SiglentConnection` | `guard.refused` |
| Socket | Immediately before each `socket.write`, and when the reply, timeout or write error arrives | `scpi.write`, `scpi.result` |
| Connection | `connect`, `disconnect`, (sds) idle close and the reset after a timeout | `instrument.connect`, `instrument.disconnect` |

**Why the transport, not the tool callbacks.** The MCP SDK validates arguments against each tool's schema before the callback runs. A wrapper around the callbacks would miss calls with invalid arguments, calls to unknown tools, and every non-tool request. The transport sees the raw JSON-RPC message first, whatever the SDK does with it afterwards. The transport interface (`onmessage`, `send`) is small and stable, and it is the same interface the planned HTTP transport implements.

**Prerequisite (sdg).** In siglent-sds-mcp, `SiglentConnection.connect` enforces the host policy itself, so every connect path is covered. In siglent-sdg-mcp, it's enforced separately in the `connect` tool (`src/tools/connection.ts`) and in auto-connect (`src/index.ts`). Moving the check into `SiglentConnection.connect`, as in sds, gives one place for the check and its audit event. That change stands on its own and lands first.

### Attributing instrument traffic to a tool call

Every event carries the JSON-RPC request id of the call that caused it, set with `AsyncLocalStorage` when the transport hands a request to the SDK.

The query queue needs care. `drainQueue()` often runs from the socket's `data` handler, after the previous query's reply arrives. That's a different async context, so `AsyncLocalStorage` would attribute the write to whatever call was running, or to none. So each `QueuedQuery` captures the audit context when it's enqueued, and `drainQueue()` uses that captured context for its `scpi.write` and `scpi.result` events, not the ambient one. A unit test runs two tool calls in parallel against the simulator and checks that every wire event carries the right request id.

Traffic that no tool call caused (auto-connect at startup, sds reconnect after idle) carries `jsonrpc.request.id: null` and a `cause` field (`auto-connect`, `reconnect`, `idle-close`).

## Event schema

One flat JSON object per event. The JSONL sinks write it as-is; the OTEL sink maps it to a log record (see "OpenTelemetry mapping"). Names follow the OpenTelemetry semantic conventions where one exists, so the two sinks use the same field names.

Common to every event:

| Field | Example | Notes |
|---|---|---|
| `time` | `2026-11-16T09:12:03.412Z` | ISO 8601, UTC, ms |
| `event.name` | `guard.refused` | One of the event names below, prefixed `siglent.audit.` in OTEL |
| `audit.seq` | `57` | Per-process counter, starts at 1, no gaps. A missing number means a lost event. |
| `service.instance.id` | `3f0c…` | Random UUID per process start. Together with `audit.seq` it identifies an event uniquely. |
| `service.name`, `service.version` | `siglent-sdg-mcp`, `2.1.0` | |
| `jsonrpc.request.id` | `"12"` or `null` | Correlates every event with the request that caused it |
| `cause` | `tool-call` | `tool-call`, `auto-connect`, `reconnect`, `idle-close`, `shutdown` |

Per event:

| Event | Fields |
|---|---|
| `server.start` | Effective configuration: `raw_scpi_enabled`, `allowed_hosts`, `allowed_ports`, the audit sinks in use. Never environment variables in general. |
| `server.stop` | `reason` (`stdin_closed`, `signal`), `audit.lost` (events lost since start, see "Delivery") |
| `mcp.request` | `mcp.method.name`, `gen_ai.tool.name` (tools/call), `gen_ai.tool.call.arguments` (bounded, see "Content limits"), tool annotations (`read_only_hint`, `destructive_hint`) from the registered tool, `client.name` and `client.version` (from `initialize`, marked `client.self_reported: true`), `mcp.protocol.version` |
| `mcp.response` | `outcome` (`ok`, `tool_error`, `jsonrpc_error`), `error.type`, `rpc.response.status_code` for JSON-RPC errors, `error.message` (bounded), result content summary (types and byte sizes, not content), `duration_ms` |
| `guard.refused` | `guard` (`wire`, `query`, `host`, `raw-scpi`), `rule` (see below), `scpi.command` (bounded) or `server.address`/`server.port`, `error.message` |
| `scpi.write` | `scpi.command` (bounded), `scpi.kind` (`command`, `query`, `binary-query`, `pre`), `server.address`, `server.port`, `scpi.write_id` |
| `scpi.result` | `scpi.write_id`, `outcome` (`written`, `replied`, `timeout`, `write_failed`, `out_of_step`), `reply.bytes`, `reply.text` (text replies only, bounded), `duration_ms` |
| `instrument.connect` | `server.address`, `server.port`, `outcome` (`connected`, `refused_by_policy`, `failed`, `superseded`), `instrument.idn` |
| `instrument.disconnect` | `server.address`, `reason` (`requested`, `idle`, `reset_after_timeout`, `socket_error`, `shutdown`) |

`scpi.write` is emitted **before** the bytes are written, so an attempt is on record even if the process dies during the write. `scpi.result` follows with the same `scpi.write_id`.

### Rule identifiers

`ScpiPolicyError` (thrown by both the SCPI guard and the host policy) currently carries only a message. It gets a stable `rule` field, so refusals can be counted and alerted on without parsing messages:

`wire.empty`, `wire.too_long`, `wire.control_char`, `wire.compound`, `wire.non_ascii`, `query.not_a_query`, `query.parameters_not_allowed`, `query.action_command`, `query.read_and_clear`, `query.empty_node`, `host.not_allowed`, `host.port_not_allowed`, `raw.disabled`.

The final list follows the guard code. A unit test checks that every `throw new ScpiPolicyError` passes a rule from this list.

### Content limits

- Strings in arguments, commands, replies and error messages are cut at 512 characters (the wire limit is already 512), with `…[truncated, N chars]` appended.
- Tool results are summarised, not copied: for each content item, its type and size. Screenshots and waveform data (sds) are never logged.
- Binary replies: `reply.bytes` only.
- Text replies are included, bounded. They are the evidence if an instrument response ever carries a prompt injection back to the model.
- Nothing from the environment is logged except the effective configuration in `server.start`. That matters for `OTEL_EXPORTER_OTLP_HEADERS`, which commonly holds an API key.

## Sinks

| Setting | Effect |
|---|---|
| `SIGLENT_AUDIT_LOG` unset or `stderr` | JSON lines on stderr (default) |
| `SIGLENT_AUDIT_LOG=/path/to/file.jsonl` | Appended to the file, created with mode `0600`. The path must be absolute. |
| `SIGLENT_AUDIT_LOG=off` | No audit events |
| `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` set | Also exported over OTLP, in addition to the setting above |

Standard OTEL environment variables configure the exporter (`OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`, ...). There's no server-specific duplicate.

**Never stdout.** Stdout carries the MCP protocol. A test starts the server, makes calls that produce every event type, and checks that every line on stdout parses as JSON-RPC.

### Defaults

Audit events go to stderr by default. Stderr already carries the server's human-readable messages, and most clients capture it in their logs (Claude Code writes it to its MCP debug log). The cost is a few hundred bytes per call, and a default that records something beats one that records nothing. See open question 1.

## Delivery and failure behaviour

- **At startup, fail closed.** If a configured file can't be opened, or the OTEL endpoint isn't a valid URL, the server exits with a configuration error. That matches the existing rule for invalid security configuration: no silent fallback.
- **At runtime, fail open, loudly.** A failed write, or an OTLP export the collector rejects or can't receive, never blocks or fails a tool call. The instrument keeps working. Each loss is counted, a warning goes to stderr (rate-limited to one per minute), and the `server.stop` event reports the total. `audit.seq` gaps show the loss in the backend.
- **OTEL batching.** The SDK's batch log record processor, with a bounded queue (2048 records) and a 1 s schedule. On shutdown (stdin closes, or SIGTERM), a flush with a 2 s timeout, then exit. Records still queued after the timeout are counted as lost on stderr.
- **Ordering.** JSONL sinks preserve emission order. OTLP batches may arrive out of order; `audit.seq` restores it.

## Integrity

What this design does and doesn't give:

- Against an honest server with a buggy or misbehaving model: a complete record, with detectable gaps.
- Against a **compromised server process** (code execution inside it): nothing local can be trusted. The process can rewrite the JSONL file, forge events and stop exporting; it can also send any command to the instrument without emitting an event, since the hooks run in the same process. **Events already exported over OTLP are out of its reach**, and `audit.seq` makes a sudden stop or gap visible. That is the main argument for the OTEL sink.
- Hash-chaining the local file wouldn't help on its own: the same process could rewrite the chain from the start. It only helps if the chain head is regularly anchored somewhere the process can't write, which is what the OTEL export already does. Out of scope.

## OpenTelemetry mapping

- **Signal:** logs, via the official SDK: `@opentelemetry/api-logs`, `@opentelemetry/sdk-logs`, `@opentelemetry/exporter-logs-otlp-http`, `@opentelemetry/resources`. **Transport:** OTLP/HTTP.
- **Record:** `eventName` = `siglent.audit.<event.name>`. Severity is `INFO`, except `WARN` for `guard.refused` and failed results. The body is a one-line summary, and every field above becomes an attribute.
- **Resource:** `service.name`, `service.version`, `service.instance.id`.
- **Semantic conventions:** the [MCP conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/mcp.md) are at **Development** status and define spans and metrics, not logs. This design reuses their attribute names on log records (`mcp.method.name`, `gen_ai.tool.name`, `jsonrpc.request.id`, `mcp.protocol.version`, `error.type`, `rpc.response.status_code`), plus `server.address` and `server.port` from the general conventions, because that's what backends and dashboards will recognise. Attributes with no convention use the `scpi.`, `guard.`, `reply.`, `audit.` and `instrument.` prefixes. Because the conventions are still changing, the names are listed in one module, and the CHANGELOG notes any rename.
- **Dependency cost:** measured on 15 Nov 2026, the four packages pull in 11 packages in total, all published by the OpenTelemetry project, about 19 MB installed. They become regular dependencies: an optional dependency is installed by default anyway, so it would save nothing. The exporter is loaded with a dynamic `import()` only when an endpoint is set, so a user without OTEL configured never runs that code. Dependabot and the lockfile already cover them; the image size grows accordingly.

## Docker

- The default stderr sink works unchanged with `docker run --read-only`.
- A file sink needs a writable mount: `-v /host/audit:/audit -e SIGLENT_AUDIT_LOG=/audit/sdg.jsonl`. The directory must be writable by UID 1000. The README's claim that "the server writes no files" changes to "the server writes no files unless a file audit log is configured".
- OTLP needs network access to the collector, as instrument access already does.

## Differences between the two servers

| | siglent-sdg-mcp | siglent-sds-mcp |
|---|---|---|
| Host policy | In the `connect` tool and auto-connect today; moves into `SiglentConnection.connect` first (see "Prerequisite") | Already in `SiglentConnection.connect` |
| Writes per query | One | One, or two when a setter is paced by `*OPC?` (`pre`). Each write gets its own `scpi.write` event. |
| Binary transfers | None in use | `queryBinary` for waveform data and screenshots: `reply.bytes` only |
| Connection lifecycle | Explicit connect and disconnect | Also idle close, reconnect on demand, and the reset after a timeout or an out-of-step reply (`out_of_step`) |
| Physical effect | Output on/off. `configure_output` events are the most important ones to alert on. | None directly; `configure_channel` coupling to 50 Ω is the notable setting |

## Tests

- **Unit, with an in-memory sink:**
  - every registered tool produces `mcp.request` and `mcp.response`;
  - schema-invalid arguments and an unknown tool name are recorded;
  - every guard rule produces `guard.refused` with its `rule`, and no `scpi.write`;
  - two parallel tool calls: each `scpi.write` carries the right request id (the queue case);
  - `audit.seq` has no gaps;
  - strings are bounded;
  - image and binary content isn't logged.
- **Unit, OTEL:** a local HTTP server stands in for the collector. It checks the POST to `/v1/logs`, the attribute names, flush on shutdown, the loss count when the collector is down, and that a tool call still succeeds while the collector is down.
- **Process:**
  - stdout carries only JSON-RPC, whichever sinks are configured;
  - a file sink is created with `0600`;
  - an unwritable file path makes the server exit at startup.
- **Hardware check:** runs with a file sink and uses the log as an independent oracle. Every security probe must appear as `guard.refused` with the expected rule, and no refused command may appear in any `scpi.write`. Today the check reads instrument state back; this adds a record of what the server tried to write.
- **Container:** `scripts/check-image.sh` runs the hardened image with a mounted audit directory and checks that events arrive.

## Rollout

1. sdg: move the host-policy check into `SiglentConnection.connect` (its own PR, no behaviour change).
2. Both: add `rule` to `ScpiPolicyError` (no behaviour change).
3. Both: the audit core, the JSONL sinks, the transport and connection hooks, and the tests. Release as 2.1.0.
4. Both: the OTEL sink. Either in 2.1.0 or as 2.2.0, depending on review.
5. Threat models: the "No audit trail" row changes to describe what's recorded and the integrity limits above. The README gets an "Audit log" section with a local collector example.

## Open questions for review

1. **Default on (stderr) or off?** On records something with zero configuration, but adds lines to stderr that some users will find noisy. Off is quieter, and nobody gets a trail they didn't ask for.
2. **Arguments in full or bounded?** `gen_ai.tool.call.arguments` is opt-in in the conventions because arguments can be sensitive. Here they're instrument settings, not personal data, and they're the main evidence. The proposal logs them, bounded.
3. **Reply text:** is logging bounded text replies the right default, given they're short and mostly numeric?
4. **Fail open at runtime:** acceptable for a bench tool? The alternative, refusing tool calls while the audit sink is down, would make the collector a single point of failure for the instrument.
5. **OTEL in 2.1.0 or 2.2.0?** Shipping the JSONL core first keeps the first release free of new dependencies.
