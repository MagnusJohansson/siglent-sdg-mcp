# Security policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 2.x     | Yes       |
| 1.x     | No. Affected by [GHSA-pvmh-r7xf-3952](https://github.com/MagnusJohansson/siglent-sdg-mcp/security/advisories/GHSA-pvmh-r7xf-3952); upgrade to 2.0.2 or later. |

## Reporting a vulnerability

Please **don't open a public issue** for a vulnerability. Report it privately instead:

1. Go to the repository's [Security tab](https://github.com/MagnusJohansson/siglent-sdg-mcp/security).
2. Click **Report a vulnerability**.

Please include:
- the version, and how you run it (npm, Docker, from source);
- the tool call or input that triggers the problem;
- what reaches the instrument or the network, and what you expected instead;
- the instrument model and firmware, if you tested on hardware.

This project is maintained by one person in their spare time, so responses are best effort. Fixes are released through GitHub Releases, npm and GHCR, and disclosed in a GitHub Security Advisory with credit to the reporter, unless you'd rather not be named.

## What counts as a vulnerability

The server treats every tool argument as untrusted, because it comes from a language model that may have read attacker-controlled content. Reports are especially welcome if you can:
- change the instrument's state through `scpi_query`;
- get a second command, or an unchecked parameter, onto the wire through any tool;
- make `connect` reach a host or port outside the configured policy;
- use `scpi_command` while raw SCPI is disabled.

## Known limitations

These are documented in the [threat model](docs/threat-model.md) and are not vulnerabilities in themselves:
- **The server does not limit output voltage.** Use the generator's own `MAX_OUTPUT_AMP` setting. Server-side limits are tracked in [#4](https://github.com/MagnusJohansson/siglent-sdg-mcp/issues/4).
- Switching an output on needs no extra confirmation.
- The instrument's SCPI port (TCP 5025) has no authentication. Anyone who can reach it controls the instrument directly, without this server.
- In stdio mode there is no caller identity: whoever can start the process has full access.

A way around one of the server's own checks is always in scope, even if it ends in one of the effects above.
