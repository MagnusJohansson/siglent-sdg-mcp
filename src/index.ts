#!/usr/bin/env node

import * as fs from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { audit, JsonlSink, logSync, withAuditContext, type AuditSink } from "./audit/audit.js";
import { FdWriter } from "./audit/writer.js";
import { loadConfig, type AuditConfig, type ServerConfig } from "./config.js";
import { connection } from "./connection.js";
import { connectServer, createServer, SERVER_VERSION } from "./server.js";

// Fail closed on invalid configuration: exit non-zero instead of starting
// with a security setting silently ignored. These are the only synchronous
// stderr writes; everything after goes through the non-blocking queue.
let config: ServerConfig;
try {
  config = loadConfig();
} catch (err) {
  logSync(`Configuration error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

// One writer for everything on stderr, so nothing can block on a full pipe
// and nothing interleaves with an audit event.
const stderr = new FdWriter(2);
const sinks: AuditSink[] = [];
if (config.audit.sink === "stderr") {
  sinks.push(new JsonlSink("stderr", config.audit.level, stderr));
} else if (config.audit.sink === "file") {
  let fd: number;
  try {
    fd = fs.openSync(config.audit.path, "a", 0o600);
  } catch (err) {
    logSync(
      `Configuration error: can't open the audit log ${config.audit.path}: ` +
        (err instanceof Error ? err.message : String(err))
    );
    process.exit(1);
  }
  sinks.push(new JsonlSink("file", "full", new FdWriter(fd)));
}
audit.configure({ service: { name: "siglent-sdg-mcp", version: SERVER_VERSION }, sinks, stderr });

// Prevent uncaught errors from killing the MCP server process
process.on("uncaughtException", (err) => {
  audit.log(`Uncaught exception: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
});
process.on("unhandledRejection", (reason) => {
  audit.log(`Unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
});
// Node's default printer for process warnings writes to stderr synchronously.
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  audit.log(`${warning.name}: ${warning.message}`);
});

for (const note of config.notes) {
  audit.log(note);
}
audit.serverStart({
  rawScpiEnabled: config.rawScpiEnabled,
  allowedHosts: config.hostPolicy.allowedHosts,
  allowedPorts: config.hostPolicy.allowedPorts,
  audit: describeAudit(config.audit),
});
const server = createServer(config);

function describeAudit(a: AuditConfig): string {
  if (a.sink === "off") return "off";
  if (a.sink === "file") return `file:${a.path}`;
  return `stderr:${a.level}`;
}

// Stop on stdin end (the client has gone) or a signal. An open instrument
// socket would otherwise keep the process alive after stdin closes.
let stopping = false;
async function shutdown(reason: "stdin_closed" | "signal"): Promise<void> {
  if (stopping) {
    // A second signal: the first shutdown is stuck. Stop now.
    if (reason === "signal") hardExit();
    return;
  }
  stopping = true;
  connection.disconnect("shutdown", { cause: "shutdown" });
  // Drain first, so server.stop (last, with the final loss count) isn't
  // dropped by a queue that's still full from a stalled stderr.
  await audit.flush(1000);
  audit.serverStop(reason);
  const drained = await audit.flush(1000);
  // process.exit joins the libuv thread pool, so it would wait for a write
  // stuck in the kernel (a hung network filesystem, a FIFO nobody reads)
  // without any time limit. What's still queued is lost either way.
  if (!drained && audit.writeInFlight) hardExit();
  process.exit(0);
}

/** Exit without joining the thread pool. */
function hardExit(): void {
  process.kill(process.pid, "SIGKILL");
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await connectServer(server, transport, config);
  process.stdin.on("end", () => void shutdown("stdin_closed"));
  process.on("SIGTERM", () => void shutdown("signal"));
  process.on("SIGINT", () => void shutdown("signal"));
  audit.log("siglent-sdg-mcp server running on stdio");

  // Auto-connect if env var is set (fire-and-forget, don't block MCP startup)
  const autoIp = config.defaultHost;
  if (autoIp) {
    // connect() applies the host policy.
    withAuditContext({ cause: "auto-connect" }, () => connection.connect(autoIp, config.defaultPort)).then(
      (idn) => audit.log(`Auto-connected to ${autoIp}: ${idn}`),
      (err) => {
        audit.log(`Auto-connect to ${autoIp} failed: ${err instanceof Error ? err.message : String(err)}`);
        audit.log("Use the 'connect' tool to connect manually.");
      }
    );
  }
}

main().catch((error) => {
  audit.log(`Startup error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
});
