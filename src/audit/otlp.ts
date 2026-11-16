/**
 * The OpenTelemetry sink: audit events as OTLP log records over HTTP (JSON),
 * to a collector (docs/audit-log-design.md, "OpenTelemetry mapping").
 *
 * The SDK is loaded with a dynamic import() only when an endpoint is
 * configured, so a server without OTLP never runs that code. The exporter
 * reads the standard OTEL_EXPORTER_OTLP_* variables itself (endpoint,
 * headers, timeout); nothing here duplicates them.
 *
 * Losses are counted here, not inside the SDK: the sink refuses records once
 * as many are waiting as the batch processor can hold, so the processor
 * never drops one silently, and every record an export failed to deliver is
 * reported through takeLost().
 */
import type { AuditLevel, AuditRecord, AuditSink } from "./audit.js";

/** The batch processor's queue; the sink refuses records beyond it. */
const MAX_QUEUE = 2048;
const SCHEDULED_DELAY_MS = 1000;

const RESOURCE_KEYS = new Set(["service.name", "service.version", "service.instance.id"]);

/** Records whose outcome means something didn't go as asked. */
function isWarning(r: AuditRecord): boolean {
  const name = r["event.name"];
  const outcome = r["outcome"];
  if (name === "guard.refused" || name === "audit.loss") return true;
  if (name === "mcp.response") return outcome === "tool_error" || outcome === "jsonrpc_error";
  if (name === "scpi.result") return outcome !== "written" && outcome !== "replied";
  if (name === "instrument.connect") return outcome !== "connected";
  return false;
}

/** A one-line body, so a log viewer shows something useful without opening attributes. */
function summary(r: AuditRecord): string {
  const name = String(r["event.name"]);
  const detail =
    r["rule"] ?? r["gen_ai.tool.name"] ?? r["scpi.command"] ?? r["mcp.method.name"] ?? r["reason"] ?? r["outcome"];
  return detail !== undefined ? `${name}: ${String(detail)}` : name;
}

export interface OtlpSinkStatus {
  /** Exports that succeeded / failed so far. */
  exportsOk: number;
  exportsFailed: number;
  lastError?: string;
}

/** The parts of the SDK the sink uses, loaded on demand. */
interface Sdk {
  logger: { emit(record: Record<string, unknown>): void };
  forceFlush(): Promise<void>;
  severity: { INFO: number; WARN: number };
}

export class OtlpSink implements AuditSink {
  readonly name = "otlp";
  readonly level: AuditLevel = "full";
  private accepted = 0;
  private settled = 0;
  private lostLater = 0;
  readonly status: OtlpSinkStatus = { exportsOk: 0, exportsFailed: 0 };
  private sdk?: Sdk;

  /** Called by the exporter wrapper when an export finishes. */
  onExported(count: number, ok: boolean, error?: string): void {
    this.settled += count;
    if (ok) {
      this.status.exportsOk++;
    } else {
      this.status.exportsFailed++;
      this.status.lastError = error;
      this.lostLater += count;
    }
  }

  attach(sdk: Sdk): void {
    this.sdk = sdk;
  }

  write(record: AuditRecord): boolean {
    if (!this.sdk || this.accepted - this.settled >= MAX_QUEUE) return false;
    this.accepted++;
    const attributes: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(record)) {
      if (k !== "time" && k !== "event.name" && !RESOURCE_KEYS.has(k)) attributes[k] = v;
    }
    const warn = isWarning(record);
    this.sdk.logger.emit({
      eventName: `siglent.audit.${String(record["event.name"])}`,
      timestamp: new Date(String(record["time"])),
      severityNumber: warn ? this.sdk.severity.WARN : this.sdk.severity.INFO,
      severityText: warn ? "WARN" : "INFO",
      body: summary(record),
      attributes,
    });
    return true;
  }

  takeLost(): number {
    const n = this.lostLater;
    this.lostLater = 0;
    return n;
  }

  /** True once everything accepted has been exported (or has failed to be). */
  async flush(timeoutMs: number): Promise<boolean> {
    if (!this.sdk) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)));
    await Promise.race([this.sdk.forceFlush().catch(() => {}), timeout]);
    clearTimeout(timer);
    return this.settled === this.accepted;
  }

  /** An HTTP export doesn't use the thread pool, so it never holds up an exit. */
  writeInFlight(): boolean {
    return false;
  }
}

/** An endpoint as it may be logged: no userinfo, no query string, no fragment. */
export function redactUrl(value: string): string {
  try {
    const u = new URL(value);
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return "[invalid URL]";
  }
}

/**
 * Remove credentials from free text (the SDK's diagnostic messages): URL
 * userinfo and query strings, and every header value configured in
 * OTEL_EXPORTER_OTLP_HEADERS / OTEL_EXPORTER_OTLP_LOGS_HEADERS.
 */
export function redactText(text: string, env: NodeJS.ProcessEnv): string {
  let out = text
    .replace(/(https?:\/\/)[^\s/@]+@/gi, "$1***@")
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/gi, "$1?***");
  for (const name of ["OTEL_EXPORTER_OTLP_HEADERS", "OTEL_EXPORTER_OTLP_LOGS_HEADERS"]) {
    for (const pair of (env[name] ?? "").split(",")) {
      const i = pair.indexOf("=");
      if (i < 0) continue;
      const raw = pair.slice(i + 1).trim();
      let decoded = raw;
      try {
        decoded = decodeURIComponent(raw);
      } catch {
        // keep the raw value
      }
      for (const secret of new Set([raw, decoded])) {
        if (secret.length >= 4) out = out.split(secret).join("***");
      }
    }
  }
  return out;
}

/**
 * Load the SDK and start the sink. The SDK's diagnostic messages (WARN and
 * above) go to `log`, with credentials removed, never to the console.
 */
export async function startOtlpSink(options: {
  service: { name: string; version: string; instanceId: string };
  log: (message: string) => void;
  env?: NodeJS.ProcessEnv;
}): Promise<OtlpSink> {
  const env = options.env ?? process.env;
  const [api, apiLogs, sdkLogs, exporterHttp, resources] = await Promise.all([
    import("@opentelemetry/api"),
    import("@opentelemetry/api-logs"),
    import("@opentelemetry/sdk-logs"),
    import("@opentelemetry/exporter-logs-otlp-http"),
    import("@opentelemetry/resources"),
  ]);

  const diagLog = (level: string) => (message: string, ...args: unknown[]) =>
    options.log(
      redactText(`otlp ${level}: ${[message, ...args.map((a) => (a instanceof Error ? a.message : String(a)))].join(" ")}`, env)
    );
  api.diag.setLogger(
    {
      error: diagLog("error"),
      warn: diagLog("warn"),
      info: () => {},
      debug: () => {},
      verbose: () => {},
    },
    { logLevel: api.DiagLogLevel.WARN, suppressOverrideMessage: true }
  );

  const sink = new OtlpSink();
  const inner = new exporterHttp.OTLPLogExporter();
  type Records = Parameters<typeof inner.export>[0];
  type Callback = Parameters<typeof inner.export>[1];
  const exporter = {
    export(records: Records, done: Callback): void {
      inner.export(records, (result) => {
        sink.onExported(records.length, result.code === 0, result.error ? redactText(result.error.message, env) : undefined);
        done(result);
      });
    },
    shutdown: () => inner.shutdown(),
    forceFlush: () => inner.forceFlush(),
  };

  // Ours first; OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES override them.
  const resource = resources
    .resourceFromAttributes({
      "service.name": options.service.name,
      "service.version": options.service.version,
      "service.instance.id": options.service.instanceId,
    })
    .merge(resources.detectResources({ detectors: [resources.envDetector] }));

  const provider = new sdkLogs.LoggerProvider({
    resource,
    processors: [
      new sdkLogs.BatchLogRecordProcessor({
        exporter,
        maxQueueSize: MAX_QUEUE,
        scheduledDelayMillis: SCHEDULED_DELAY_MS,
      }),
    ],
  });
  sink.attach({
    logger: provider.getLogger(options.service.name, options.service.version),
    forceFlush: () => provider.forceFlush(),
    severity: { INFO: apiLogs.SeverityNumber.INFO, WARN: apiLogs.SeverityNumber.WARN },
  });
  return sink;
}
