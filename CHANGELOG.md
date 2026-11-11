# Changelog

## 2.0.0

Security release. Tool arguments come from a language model and are now treated as untrusted input. See [docs/threat-model.md](docs/threat-model.md) for the full analysis.

### Breaking changes

- **`scpi_command` is no longer registered by default.** Set `SIGLENT_ALLOW_RAW_SCPI=true` to enable it. It stays disabled when output limits are configured.
- **`scpi_query` only accepts queries:** a single SCPI header immediately followed by `?` (e.g. `C1:BSWV?`). Previously it would send any string, including commands that change state.
- **`connect` is restricted.** Allowed hosts are `SIGLENT_SDG_IP` / `SIGLENT_IP` plus `SIGLENT_ALLOWED_HOSTS`. If none are set, only private-LAN IP addresses are accepted. Ports are limited to 5025 and the configured `SIGLENT_SDG_PORT`.
- **Stricter parameter formats:** `configure_output.load` must be `HZ` or a number, `configure_burst.cycles` must be an integer or `INF`, and `set_arbitrary_wave.name` may only contain letters, digits, space, `_ - . /` (no quotes).
- Invalid values for the numeric environment variables now stop the server at startup instead of being ignored.

### Security fixes

- Command injection: newlines, other control characters and `;` are rejected in every command and query before it reaches the socket.
- `scpi_query` was annotated read-only but could change instrument state.
- `connect` could be used to open TCP connections to arbitrary hosts and ports.

### Added

- Optional output limits: `SIGLENT_MAX_AMPLITUDE_VPP` and `SIGLENT_MAX_VOLTAGE`, enforced on every waveform command from any tool. With limits set:
  - the span between high and low level is checked, and a single level can't be set while an amplitude cap is active;
  - `reset` and `copy_channel` are rejected, because they load unchecked settings;
  - before an output is switched on, the instrument's settings are read back and checked, and the output is refused if they can't be verified.
- `scpi_query` accepts absolute queries with a leading root colon (e.g. `:SENSe:COUNTer:FREQuency?`).
- `destructiveHint` on `reset` and `scpi_command`.
- SCPI simulator and end-to-end security tests (`npm test`), plus a CI workflow. Tests also run before npm publish.
- Threat model: `docs/threat-model.md`.
