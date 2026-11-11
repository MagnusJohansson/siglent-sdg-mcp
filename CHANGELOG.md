# Changelog

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

### Added

- `scpi_query` accepts absolute queries with a leading root colon (e.g. `:SENSe:COUNTer:FREQuency?`). Parameters after `?` are only accepted for `STL?` and `MMEMory:CATalog?`, in their documented forms. `WVDT?` (binary reply) is not accepted. `*` commands are only accepted as pure queries (`*IDN?`, `*OPC?`, `*ESR?`, `*STB?`, `*ESE?`, `*SRE?`, `*OPT?`).
- `destructiveHint` on `reset` and `scpi_command`.
- SCPI simulator and end-to-end security tests (`npm test`), plus a CI workflow. Tests also run before npm publish.
- Threat model: `docs/threat-model.md`.
- Hardware check against a real SDG (`npm run hardware-check -- <ip>`), which verifies the security checks by reading the instrument state back. Its probes never request output ON.
