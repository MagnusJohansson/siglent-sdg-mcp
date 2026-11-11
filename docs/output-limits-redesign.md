# Output limits: redesign notes

**Status:** the limits on this branch were withdrawn from 2.0.0 (PR #3), because a second review showed they could be bypassed. This branch keeps that code as a starting point. This document lists what the redesign has to solve. Treat the current code as **not safe to ship**.

## Confirmed bypasses (proof of concept in the simulator)

| # | Bypass | Where | Example (limits 5 Vpp / ±3 V unless stated) |
|---|--------|-------|----------------------------------------------|
| 1 | Amplitude and offset are checked separately, never the peak `|OFST| + AMP/2`. Nothing is checked while an output is on. With only `SIGLENT_MAX_VOLTAGE` set, amplitude is never checked at all. | `src/security/scpi-guard.ts` (`checkVoltageParams`, `assertWithinLimits`) | Output on, then `amplitude 5, offset 3`: 5.5 V peak. With only a ±3 V limit: `amplitude 20` gives ±10 V. |
| 2 | The read-back before switching on isn't atomic with the switch-on. `sendCommand` writes outside the query queue. | `src/connection.ts` (`sendCommand`) | Parallel `configure_output ON` and `configure_basic_wave amplitude 5, offset 3`. Wire order: `BSWV?`, then `BSWV AMP,5,OFST,3`, then `OUTP ON`. |
| 3 | A late reply after a query timeout is consumed by the next query, including the read-back. The model controls `timeout_ms`. The reply's channel isn't checked. | `src/connection.ts` (`drainQueue`), `src/tools/scpi.ts` | `scpi_query C2:BSWV?` with `timeout_ms: 5`, in parallel with `C1 ON`: C2's safe reply satisfies C1's check, and C1 comes on at 8 Vpp. |
| 4 | Limits compare against the *displayed* voltage, which depends on the configured load. The load setting is unrestricted. | `src/tools/output.ts` | Load 50 Ω driving a high-Z DUT: about 2× the displayed voltage. |

## Also found

- Read-back fails closed only when *no* recognised field is present; a reply with only `AMP` passes.
- Multi-command tools (burst, sweep, modulation) send some commands, then reject a later one, so part of the change is applied. Example: `configure_burst {state: ON, carrier_offset: 5}` sends `BTWV STATE,ON`, then reports an error.
- Peaks the limits can't see: AM depth > 100 %, external or other-channel modulation sources, channel coupling/tracking (`COUP`), and noise `MEAN + 3σ`.
- Two tests asserted unsafe behaviour as correct: "allows output within limits" (5 Vpp at −3 V offset) and "applies only the limits that are configured" (10 Vpp under a ±3 V limit).
- The simulator replies instantly and in order, and doesn't model load, coupling or slow replies, so races can't show up in the tests.

## Redesign direction: an interlock, not a filter

The property to protect is **the voltage at the output terminal, at every moment the output is on, under concurrency.**

1. **One lock** around all instrument traffic: check, read-back and write happen as one atomic operation. Queries and commands share it.
2. **Reset the connection after any timeout** (or resync with a `*OPC?` barrier). Set a minimum `timeout_ms`. Check the channel in each reply.
3. **No waveform, load or modulation changes while that channel's output is on** while limits are set. To change something: switch off, change, switch on.
4. **A full read-back before switch-on:** `BSWV?` (require AMP and OFST, compute the peak from them), `OUTP?` (scale by the load: open-circuit voltage = displayed × (R + 50) / R; HiZ = 1), `MDWV?` (refuse if AM depth > 100 % or the source isn't internal), and `COUP?` (refuse if channels are coupled). Fail closed on anything unparseable.
5. **Validate every command a tool will send before sending any**, and report what was actually sent.
6. **Semantics:** `SIGLENT_MAX_VOLTAGE` bounds the absolute peak, so it includes AMP/2 even without an amplitude limit.
7. **Tests:** a simulator mode with delayed replies; tests for a combined peak while on, a parallel ON plus change, a stale reply after a timeout, a load change, and partial multi-command sends.
8. **Hardware:** confirm which value the SDG keeps when the load setting changes. Test the switch-on read-back on hardware only with nothing connected, and with the instrument's own `MAX_OUTPUT_AMP` set as a backstop.
