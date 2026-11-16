# Changelog

## 2.1.0

### Added

- **Audit log.** The server records what it refused, what it connected to and, optionally, every line it wrote to the generator, as JSON lines. Configured with `SIGLENT_AUDIT_LOG`; see the README's "Audit log" section and `docs/audit-log-design.md`.
  - By default, security events go to stderr: every refusal (`guard.refused`) with a stable rule id, `instrument.connect` and `instrument.disconnect`, every state-changing tool call (`readOnlyHint: false`) with its arguments and result, `server.start`/`server.stop` and `audit.loss`.
  - `SIGLENT_AUDIT_LOG=stderr` gives the full trail on stderr: also every MCP message, read-only calls and every instrument write with its reply. An absolute path gives the full trail in that file (mode `0600`); `off` disables it. A relative path, or a file that can't be opened, stops the server at startup.
  - Refusals the SDK makes before a tool runs are recorded too: arguments that fail the tool's schema (`schema.invalid`, e.g. a newline in `load`) and calls to `scpi_command` while it's disabled (`raw.disabled`). Lines that aren't valid JSON-RPC are recorded as `mcp.malformed`.
  - Every event carries the JSON-RPC request id of the call that caused it, including instrument writes made later from the query queue. A cancelled call is closed with `outcome: cancelled`.
  - Each sink numbers its records without gaps; lost records are counted and reported with `audit.loss` (and a warning on stderr) once the sink accepts records again.
- **OpenTelemetry export.** With `SIGLENT_AUDIT_OTLP=1` and the standard `OTEL_EXPORTER_OTLP_ENDPOINT`, or with `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` alone, the full audit trail is also exported as OTLP log records over HTTP with JSON payloads, independent of `SIGLENT_AUDIT_LOG`. Event names are `siglent.audit.<event>`; refusals and failures are `WARN`. It's opt-in because the generic endpoint is often inherited from another application's environment: that endpoint alone gets a startup note, not an export. `OTEL_LOGS_EXPORTER=none` keeps it off in any case. An invalid endpoint stops the server at startup; a failing collector doesn't, but the server warns on stderr (rate-limited) and counts the records that didn't arrive, including those a collector rejects in a partial-success answer, reporting them with `audit.loss` once the export works. Records still unexported at shutdown are reported on the other sinks (`otlp.unexported` on `server.stop`, and a stderr line). The key in `OTEL_EXPORTER_OTLP_HEADERS` isn't logged: the logged endpoint has no userinfo or query string, the exporter's errors are logged as message and status only (no response body, no stack), and configured header values, and their parts, are redacted. Adds 11 dependencies, all from the OpenTelemetry project (`@opentelemetry/api`, `api-logs`, `core`, `sdk-logs`, `exporter-logs-otlp-http`, `resources` and what they pull in), loaded only when an endpoint is set.
- `ScpiPolicyError` carries a stable `rule` id (`query.not_a_query`, `wire.compound`, `host.not_allowed`, ...).

### Changed

- **All stderr output goes through one non-blocking writer**, the human-readable lines and Node's process warnings included. A client that pipes the server's stderr and never reads it can no longer stall tool calls once the pipe is full; lines are dropped and counted instead.
- **The server exits when stdin closes.** Until now an open instrument connection kept the process alive after the client had gone. On stdin end, SIGTERM or SIGINT, the server closes the instrument connection, flushes the audit log (up to 1 s), writes `server.stop`, flushes again (up to 1 s) and exits. If a write is still stuck in the kernel then (a file on a hung network filesystem, say), the server kills itself with SIGKILL instead of waiting for it, since an ordinary exit would wait without a time limit; it then ends with status 137 (killed by SIGKILL) and no `server.stop`, which is expected, not a crash. A second signal during shutdown does the same.
- **Docker:** the server still writes no files by default, so `--read-only` works unchanged. A file audit log needs a mounted directory writable by UID 1000; `scripts/check-image.sh` checks that.
- The connect allowlist is enforced inside `SiglentConnection.connect`, the one path every connection takes, instead of separately in the `connect` tool and in auto-connect. No behaviour change: the same targets are allowed and refused, and a refused connect still leaves the current connection, or a connect in progress, untouched. A path added later can't skip the check. siglent-sds-mcp already works this way, and the audit log records connect refusals in this one place.

### Tests

- OTLP tests run the server process against a local HTTP server standing in for a collector: the exported records, their names, severities, attributes and resource, the flush on shutdown, the export-only mode, losses while the collector rejects exports and their report once it accepts them, an invalid endpoint, and that the key appears in no record and no stderr line.
- Audit tests run the MCP server against the simulator and check attribution with parallel calls, after a timeout and when a disconnect cuts queued queries off, the per-sink numbering, bounded strings, and that every rule id is produced. A contract test pins the SDK behaviours the transport hooks rely on. Process tests check that stdout stays JSON-RPC, shutdown on stdin end and SIGTERM, the file mode, fail-closed startup, and that 2,000 tool calls complete with stderr unread.
- The hardware check drains the server's stderr and uses the audit log as a second oracle: every security probe must be recorded as `guard.refused` with its expected rule, and no probe's payload may appear in any instrument write.

## 2.0.7

### Security

- The Docker image no longer runs the server as root. It runs as the base image's `node` user (UID 1000); the app files stay owned by root, so the server can read them but not change them. The setuid and setgid bits are removed from every file in the image. This is defence in depth: no known flaw lets a caller run code in the server, and with the documented `--rm` the container is discarded after each session. It limits a compromised process inside the container; it doesn't limit what that process could send to the instrument.
- The README's `docker run` examples add `--read-only --cap-drop=ALL --security-opt=no-new-privileges`. The server writes no files and needs no Linux capabilities. These flags are optional; existing configurations keep working.

### Release process

- `scripts/check-image.sh` checks a built image: it fails if the image's user is root or the image contains setuid or setgid files, and checks that the server answers an MCP `initialize` request when started with the hardening flags. CI runs it on every pull request, and the release workflow runs it before publishing to npm, so a release can't ship an image that runs as root.
- `scripts/hardware-check.mjs` takes `--docker <image>`, to run the checks against the server in a Docker image with the hardening flags. Hardware check: 18/18 with `--docker` on the new image.

## 2.0.6

### Fixed

- `scpi_query` accepted `OUT_BOTHCH?`. The programming guide documents `OUT_BOTHCH` (switch both outputs on or off at the same time) without a query form, but it's listed inside the `<channel>:OUTPut` section rather than under its own heading, and 2.0.5 missed it. Whether the firmware would run it with a `?` appended isn't documented; without an `ON`/`OFF` value it's unclear what it would do. It's now rejected like the other action commands.

### Tests

- A unit test reads the programming guide and checks that every command it documents without a query form is rejected by `scpi_query` in long, short and lower-case form. Each command in a section is classified on its own, which is how it found `OUT_BOTHCH`. It asserts the exact number of commands found, so a parsing regression can't silently drop one. Until now the guide-driven test only checked the other direction, that documented queries are still accepted. Deleting any one spelling from the action list now fails a test. The short forms `PACP` and `VKEY` are explicit cases: the guide writes those two names as `ParaCoPy` and `VirtualKEY`.
- The hardware check probes `OUT_BOTHCH?`.
- The 2.0.5 entry says every query documented in the guide is still accepted; precisely, every documented query header without parameters. Parameters after `?` remain limited to `STL?` and `MMEMory:CATalog?` (so `WVDT? M50` is refused, as before).

## 2.0.5

### Fixed

- `scpi_query` no longer accepts action commands written as queries. The programming guide documents some commands with no query form: triggers (`C1:TRIGger`, `C1:SWEep:MTRigger`), sequence and frequency-hop table edits (`C1:SEQuence:DEFAult`, `C1:SEQuence:SEGMent<x>:DELEte`, `C1:FHOP:CFLIst`, ...), `:SENSe:COUNTer:CLEar`, `PACP`, `VKEY` and the `MMEMory` file operations. With a `?` appended they passed the query-shape check, and whether the firmware ignores the `?` or runs the action isn't documented. They are now rejected in long, short and lower-case spellings, with or without a channel prefix or a numeric suffix. A unit test checks that every query documented in the guide, in long and short form, is still accepted.
- `scpi_query` no longer accepts `EQPHASE?`. The guide lists a response format for it, but documents `EQPHASE` only as a command that aligns the phases of both channels, which steps the phase of a running output. The `sync_phase` tool is unaffected.
- `scpi_query` rejects headers with an empty node (`C1::TRIG?`, `C1:TRIG:?`).
- The hardware check probes `C1:TRIGger?` and `*ESR?` through `scpi_query` (both are rejected by the server; the check doesn't test what the firmware would do with them).

## 2.0.4

### Fixed

- `scpi_query` no longer accepts `*ESR?`. Reading the Event Status Register clears it, so a tool marked read-only could discard status events. The other common queries (`*IDN?`, `*OPC?`, `*STB?`, `*ESE?`, `*SRE?`, `*OPT?`) don't change state and are still allowed.

### Release process

- One `Release` workflow replaces the separate npm and Docker workflows. It runs verify, npm and docker jobs in order: nothing is published unless the release tag matches `package.json` and `SERVER_VERSION`, `repository.url` matches the repository, the pre-release flag matches the version, the tagged commit is on `main`, and the tests pass. The Docker image is pushed only after npm succeeds (for v2.0.0 and v2.0.1, GHCR images were pushed although the npm publish failed). Dependency install scripts are disabled in the release jobs and the Docker build.

## 2.0.3

Dependency security update. No changes to the server's own code. `npm audit` goes from 20 vulnerable packages (3 critical, 12 high) to none.

- `@modelcontextprotocol/sdk` 1.27.1 → 1.32.2. Fixes advisories in the SDK's OAuth client and HTTP session handling, and, through its dependencies, in the HTTP stack (express, body-parser, hono, proxy-addr, path-to-regexp, qs and others). This server uses the stdio transport, which doesn't load that code, but the Docker image shipped those versions.
- `zod` 3.25 → 4.6. zod 3 is affected by a memory-exhaustion advisory with no 3.x fix. Validation behaviour is unchanged: the same formats are enforced and unknown arguments are still dropped. The tool schemas sent to clients no longer include `additionalProperties: false`.
- `vitest` 3.2 → 4.1.12 (development only).

## 2.0.2

Release-process fix. **2.0.1 was released on GitHub and GHCR, but never published to npm**: npm rejected the provenance-signed upload because `repository.url` in `package.json` used a different letter case (`magnusjohansson`) than the repository (`MagnusJohansson`). 2.0.2 contains the same code as 2.0.0 and 2.0.1 and is the first 2.x version on npm. All 2.0.0 security fixes and breaking changes apply; see below.

- `repository.url` now matches the repository exactly.
- The npm publish workflow checks `repository.url` before building, so a mismatch fails at the start of the run.

## 2.0.1

Release-process fix. **2.0.0 was released on GitHub and GHCR, but never published to npm**: the publish workflow upgraded to `npm@latest`, and npm 12 no longer supports the Node 20 runtime the workflow used. 2.0.1 contains the same code as 2.0.0 and is the first 2.x version on npm. All 2.0.0 security fixes and breaking changes apply; see below.

- The npm publish workflow runs on Node 26 (LTS) and pins npm to major version 12 instead of `@latest`.
- The Docker image is based on `node:26-slim` (was `node:20-slim`; Node 20 is end-of-life).
- CI tests on Node 20, 22, 24 and 26.
- A test checks that the server version reported to MCP clients matches `package.json`.

## 2.0.0

Security release. Tool arguments come from a language model and are now treated as untrusted input. See [docs/threat-model.md](docs/threat-model.md) for the full analysis.

### Breaking changes

- **`scpi_command` is no longer registered by default.** Set `SIGLENT_ALLOW_RAW_SCPI=true` to enable it. This also requires `SIGLENT_SDG_IP` or `SIGLENT_ALLOWED_HOSTS` naming specific hosts (`*` is not accepted); otherwise the server exits with a configuration error.
- **`scpi_query` only accepts queries:** a single SCPI header immediately followed by `?` (e.g. `C1:BSWV?`). Previously it would send any string, including commands that change state.
- **`connect` is restricted.** Allowed hosts are `SIGLENT_SDG_IP` / `SIGLENT_IP` plus `SIGLENT_ALLOWED_HOSTS`. If none are set, only private-LAN IP addresses are accepted. Ports are limited to 5025 and the configured `SIGLENT_SDG_PORT`.
- **Stricter parameter formats:** `configure_output.load` must be `HZ` or a number, `configure_burst.cycles` must be an integer or `INF`, and `set_arbitrary_wave.name` may only contain letters, digits, space, `_ - . /` (no quotes).
- Invalid values for the numeric environment variables now stop the server at startup instead of being ignored.

### Not included

Server-side output voltage limits were developed for this release but **removed before release**. Two rounds of review showed they could be bypassed (combined peak, changes while the output is on, races, the load setting). They will come back as a separate, redesigned feature. Until then, use the generator's own `MAX_OUTPUT_AMP` limit.

### Security fixes

- Command injection: newlines, other control characters and `;` are rejected in every command and query before it reaches the socket.
- `scpi_query` was annotated read-only but could change instrument state.
- `connect` could be used to open TCP connections to arbitrary hosts and ports.
- `scpi_query` accepted parameters after `?` (`C1:BSWV? AMP,10`) and `*RST?`-style forms of action commands.

### Fixed

- Calling `connect` while auto-connect (`SIGLENT_SDG_IP`) was still initializing could leave the server disconnected: the older attempt's error path closed the newer connection. A superseded connect attempt now leaves the newer one alone.

### Added

- `scpi_query` accepts absolute queries with a leading root colon (e.g. `:SENSe:COUNTer:FREQuency?`). Parameters after `?` are only accepted for `STL?` and `MMEMory:CATalog?`, in their documented forms. `WVDT?` (binary reply) is not accepted. `*` commands are only accepted as pure queries (`*IDN?`, `*OPC?`, `*ESR?`, `*STB?`, `*ESE?`, `*SRE?`, `*OPT?`).
- `destructiveHint` on `reset` and `scpi_command`.
- SCPI simulator and end-to-end security tests (`npm test`), plus a CI workflow. Tests also run before npm publish.
- Publishing to npm and GHCR is triggered by publishing a GitHub Release, not by pushing a tag. The npm workflow checks that the release tag matches `package.json`, and pre-releases go to the npm `next` dist-tag.
- Threat model: `docs/threat-model.md`.
- Hardware check against a real SDG (`npm run hardware-check -- <ip>`), which verifies the security checks by reading the instrument state back. Its probes never request output ON.
