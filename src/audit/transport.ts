/**
 * Audit hooks on the MCP transport.
 *
 * The SDK validates tool arguments before a tool's callback runs, so hooks in
 * the callbacks would miss invalid arguments, unknown tools and every
 * non-tool message. The transport sees each JSON-RPC message first.
 *
 * Must be installed before server.connect(transport):
 * - `onmessage` becomes an accessor, so whatever handler the SDK assigns is
 *   wrapped as it's assigned. Each request is dispatched inside its own audit
 *   context, which the SDK's handler promise (created synchronously in
 *   onmessage) carries into the tool callback.
 * - `send` is wrapped on the instance; the SDK looks it up at call time.
 * - `onerror` set here is chained by Protocol.connect. The stdio transport
 *   reports lines that aren't valid JSON-RPC there (the raw line isn't
 *   passed on).
 * tests/integration/audit-transport.test.ts pins these SDK behaviours.
 */
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { audit, withAuditContext, type AuditContext, type AuditLevel } from "./audit.js";
import { boundArguments, firstText, summariseContent } from "./bounds.js";

export interface TransportAuditOptions {
  /** Whether scpi_command is registered; a call to it while disabled is a refusal. */
  rawScpiEnabled: boolean;
}

interface Pending {
  method: string;
  tool?: string;
  level: AuditLevel;
  startedAt: number;
}

type MessageHandler = NonNullable<Transport["onmessage"]>;

/** The SDK reports schema failures as a tool error with this prefix (SDK 1.32, pinned by a test). */
const SCHEMA_ERROR = "Input validation error";

export function auditTransport(transport: Transport, options: TransportAuditOptions): void {
  const pending = new Map<string, Pending>();
  let client: { name?: string; version?: string; protocolVersion?: string } = {};
  let inner: MessageHandler | undefined;

  const wrapped: MessageHandler = (message, extra) => {
    const m = message as { id?: string | number; method?: unknown; params?: Record<string, unknown> };
    if (typeof m.method !== "string") return inner?.(message, extra);

    if (m.id === undefined) {
      // A notification (e.g. notifications/cancelled; a cancelled call's
      // instrument writes continue, and the log shows both).
      audit.mcpRequest("full", { method: m.method, client }, { cause: "tool-call" });
      return inner?.(message, extra);
    }

    const ctx: AuditContext = { requestId: String(m.id), cause: "tool-call" };
    if (m.method === "initialize") {
      const info = (m.params?.clientInfo ?? {}) as { name?: unknown; version?: unknown };
      client = {
        name: typeof info.name === "string" ? info.name : undefined,
        version: typeof info.version === "string" ? info.version : undefined,
        protocolVersion: typeof m.params?.protocolVersion === "string" ? m.params.protocolVersion : undefined,
      };
    }
    const tool = m.method === "tools/call" ? String(m.params?.name ?? "") : undefined;
    const level: AuditLevel = tool !== undefined && audit.isStateChanging(tool) ? "security" : "full";
    pending.set(ctx.requestId!, { method: m.method, tool, level, startedAt: Date.now() });
    audit.mcpRequest(level, {
      method: m.method,
      tool,
      arguments: tool !== undefined ? boundArguments(m.params?.arguments) : undefined,
      annotations: tool !== undefined ? audit.registeredTools.get(tool) : undefined,
      client,
    }, ctx);
    if (tool === "scpi_command" && !options.rawScpiEnabled) {
      audit.guardRefused({
        guard: "raw-scpi",
        rule: "raw.disabled",
        message: "scpi_command is disabled (SIGLENT_ALLOW_RAW_SCPI is not set).",
        command: typeof (m.params?.arguments as { command?: unknown })?.command === "string"
          ? ((m.params!.arguments as { command: string }).command)
          : undefined,
      }, ctx);
    }
    return withAuditContext(ctx, () => inner?.(message, extra));
  };

  Object.defineProperty(transport, "onmessage", {
    configurable: true,
    enumerable: true,
    get: () => (inner === undefined ? undefined : wrapped),
    set: (fn: MessageHandler | undefined) => {
      inner = fn;
    },
  });

  const send = transport.send.bind(transport);
  transport.send = (message: JSONRPCMessage, sendOptions?: Parameters<Transport["send"]>[1]) => {
    const m = message as {
      id?: string | number;
      result?: { isError?: boolean; content?: unknown };
      error?: { code?: number; message?: string };
    };
    const p = m.id !== undefined ? pending.get(String(m.id)) : undefined;
    if (p && ("result" in m || "error" in m)) {
      pending.delete(String(m.id));
      const ctx: AuditContext = { requestId: String(m.id), cause: "tool-call" };
      const durationMs = Date.now() - p.startedAt;
      if (m.error) {
        audit.mcpResponse(p.level, {
          method: p.method,
          tool: p.tool,
          outcome: "jsonrpc_error",
          errorType: String(m.error.code ?? "unknown"),
          statusCode: String(m.error.code ?? ""),
          errorMessage: firstText([{ type: "text", text: m.error.message ?? "" }]),
          durationMs,
        }, ctx);
      } else {
        const isError = m.result?.isError === true;
        const errorMessage = isError ? firstText(m.result?.content) : undefined;
        if (isError && p.tool !== undefined && errorMessage?.includes(SCHEMA_ERROR)) {
          audit.guardRefused({ guard: "schema", rule: "schema.invalid", message: errorMessage }, ctx);
        }
        audit.mcpResponse(p.level, {
          method: p.method,
          tool: p.tool,
          outcome: isError ? "tool_error" : "ok",
          errorType: isError ? "tool_error" : undefined,
          errorMessage,
          content: p.tool !== undefined ? summariseContent(m.result?.content) : undefined,
          durationMs,
        }, ctx);
      }
    }
    return send(message, sendOptions);
  };

  const previousOnError = transport.onerror;
  transport.onerror = (error: Error) => {
    audit.mcpMalformed(error);
    previousOnError?.(error);
  };
}
