import * as net from "node:net";
import {
  audit,
  auditContext,
  type AuditContext,
  type DisconnectReason,
  type Guard,
  type ScpiOutcome,
} from "./audit/audit.js";
import { assertConnectAllowed, type HostPolicy } from "./security/host-policy.js";
import { assertIsQuery, assertWireSafe, ScpiPolicyError } from "./security/scpi-guard.js";

const DEFAULT_PORT = 5025;
const DEFAULT_TIMEOUT = 5000;

export interface ConnectionOptions {
  /** Where connect() may go. Enforced here, so every connect path is covered. */
  hostPolicy: HostPolicy;
  /** Port used when connect() is called without one (SIGLENT_SDG_PORT). */
  defaultPort: number;
}

export const DEFAULT_OPTIONS: ConnectionOptions = {
  // Until configured: private-LAN IP addresses on the standard port only.
  hostPolicy: { allowedHosts: [], allowedPorts: [DEFAULT_PORT] },
  defaultPort: DEFAULT_PORT,
};

interface QueuedQuery {
  cmd: string;
  binary: boolean;
  timeout: number;
  resolve: (value: Buffer) => void;
  reject: (reason: Error) => void;
  /** Captured at enqueue: the drain runs later, often from another call's socket callback. */
  ctx: AuditContext;
  /** Allocated at enqueue, so a query that's never written still has one result. */
  writeId: number;
  written: boolean;
  startedAt?: number;
}

/** An error that carries the scpi.result outcome it stands for. */
function outcomeError(message: string, outcome: ScpiOutcome): Error {
  return Object.assign(new Error(message), { auditOutcome: outcome });
}

function guardOf(rule: string): Guard {
  return rule.startsWith("wire.") ? "wire" : rule.startsWith("host.") ? "host" : "query";
}

export class SiglentConnection {
  private socket: net.Socket | null = null;
  private host = "";
  private port = DEFAULT_PORT;
  private dataBuffer = Buffer.alloc(0);
  private responseResolve: ((value: Buffer) => void) | null = null;
  private responseReject: ((reason: Error) => void) | null = null;
  private responseTimer: ReturnType<typeof setTimeout> | null = null;
  private expectedBinaryLength: number | null = null;
  private binaryDataStart: number = 0;
  private headerParsed = false;
  private queryQueue: QueuedQuery[] = [];
  private queryRunning = false;
  /**
   * Incremented on every connect(). An attempt that has been superseded by a
   * newer one (e.g. auto-connect still initializing when the `connect` tool is
   * called) must not touch the shared socket, and must not disconnect it.
   */
  private connectGeneration = 0;
  private options: ConnectionOptions;
  /** The last socket error, for the reason recorded when the socket closes. */
  private lastSocketError: string | null = null;

  constructor(options: Partial<ConnectionOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /** Apply the server configuration (host policy, default port). */
  configure(options: Partial<ConnectionOptions>): void {
    this.options = { ...this.options, ...options };
  }

  async connect(host: string, port: number = this.options.defaultPort): Promise<string> {
    const ctx = auditContext();
    // Every connect path (the connect tool, auto-connect) passes through here.
    // Checked first: a refused target must not supersede an attempt in
    // progress or drop the current connection.
    try {
      assertConnectAllowed(host, port, this.options.hostPolicy);
    } catch (err) {
      if (err instanceof ScpiPolicyError) {
        audit.guardRefused({ guard: "host", rule: err.rule, message: err.message, host, port }, ctx);
        audit.instrumentConnect({ host, port, outcome: "refused_by_policy", message: err.message }, ctx);
      }
      throw err;
    }

    const generation = ++this.connectGeneration;
    const superseded = () => generation !== this.connectGeneration;

    if (this.socket) {
      this.disconnect("replaced", ctx);
    }

    this.host = host;
    this.port = port;

    const attempt = this.openSocket(host, port, ctx, superseded);
    return attempt.then(
      (idn) => {
        audit.instrumentConnect({ host, port, outcome: "connected", idn }, ctx);
        return idn;
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        audit.instrumentConnect({ host, port, outcome: superseded() ? "superseded" : "failed", message }, ctx);
        throw err;
      }
    );
  }

  private openSocket(host: string, port: number, ctx: AuditContext, superseded: () => boolean): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();

      const connectTimeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Connection timeout to ${host}:${port}`));
      }, 5000);

      socket.on("connect", async () => {
        clearTimeout(connectTimeout);
        if (superseded()) {
          socket.destroy();
          reject(new Error("Connection attempt superseded by a newer connect."));
          return;
        }
        socket.removeAllListeners("error");
        this.socket = socket;
        this.setupSocketListeners();

        try {
          // Drain any welcome banner
          await this.delay(200);
          if (superseded()) throw new Error("superseded by a newer connect");
          this.dataBuffer = Buffer.alloc(0);

          // Try to set CHDR OFF for clean responses (not all SDG models support it)
          try {
            await this.sendCommand("CHDR OFF");
            await this.delay(100);
          } catch {
            // Some models don't support CHDR — that's OK
          }
          if (superseded()) throw new Error("superseded by a newer connect");

          // Query identification
          const idn = await this.query("*IDN?");
          if (superseded()) throw new Error("superseded by a newer connect");
          resolve(idn);
        } catch (err) {
          // Only the current attempt may tear down the shared connection;
          // a superseded one would otherwise kill the newer socket.
          if (!superseded()) this.disconnect("init_failed", ctx);
          reject(
            new Error(
              `Connected but failed to initialize: ${err instanceof Error ? err.message : String(err)}`
            )
          );
        }
      });

      socket.on("error", (err) => {
        clearTimeout(connectTimeout);
        reject(new Error(`Connection failed: ${err.message}`));
      });

      socket.connect(port, host);
    });
  }

  disconnect(reason: DisconnectReason = "requested", ctx: AuditContext = auditContext()): void {
    if (this.socket) {
      audit.instrumentDisconnect({ host: this.host, port: this.port, reason }, ctx);
    }
    const pending = this.queryQueue.splice(0);
    this.queryRunning = false;
    if (this.responseReject) {
      this.responseReject(new Error("Connection closed"));
    }
    this.clearPending();
    for (const q of pending) {
      q.reject(new Error("Connection closed"));
    }
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    this.dataBuffer = Buffer.alloc(0);
  }

  isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  getConnectionInfo(): string {
    if (!this.isConnected()) return "Not connected";
    return `${this.host}:${this.port}`;
  }

  async sendCommand(cmd: string): Promise<void> {
    const ctx = auditContext();
    // The connection is the single choke point to the instrument, so this
    // check applies regardless of which tool built the command.
    this.guard(() => assertWireSafe(cmd), cmd, ctx);
    this.ensureConnected();

    const writeId = audit.nextWriteId();
    const startedAt = Date.now();
    // Recorded before the bytes are written, so an attempt is on record even
    // if the process dies during the write.
    audit.scpiWrite({ writeId, command: cmd, kind: "command", host: this.host, port: this.port }, ctx);
    return new Promise((resolve, reject) => {
      this.socket!.write(cmd + "\n", (err) => {
        audit.scpiResult({ writeId, outcome: err ? "write_failed" : "written", startedAt }, ctx);
        if (err) reject(new Error(`Write failed: ${err.message}`));
        else resolve();
      });
    });
  }

  async query(cmd: string, timeout: number = DEFAULT_TIMEOUT): Promise<string> {
    // A query must be structurally a query; otherwise "C1:OUTP ON" sent via a
    // read-only tool would change state and simply time out waiting for a reply.
    const ctx = auditContext();
    this.guard(() => assertIsQuery(cmd), cmd, ctx);
    this.ensureConnected();
    const buf = await this.enqueueQuery(cmd, false, timeout, ctx);
    return buf.toString("utf-8").trim();
  }

  /** Run a guard check, recording a refusal before it propagates. */
  private guard(check: () => void, cmd: string, ctx: AuditContext): void {
    try {
      check();
    } catch (err) {
      if (err instanceof ScpiPolicyError) {
        audit.guardRefused({ guard: guardOf(err.rule), rule: err.rule, message: err.message, command: cmd }, ctx);
      }
      throw err;
    }
  }

  private enqueueQuery(
    cmd: string,
    binary: boolean,
    timeout: number,
    ctx: AuditContext
  ): Promise<Buffer> {
    const writeId = audit.nextWriteId();
    return new Promise<Buffer>((resolve, reject) => {
      // Every way a query ends goes through these two, so each write id gets
      // exactly one scpi.result, recorded with the query's own context.
      const q: QueuedQuery = {
        cmd,
        binary,
        timeout,
        ctx,
        writeId,
        written: false,
        resolve: (buf) => {
          audit.scpiResult({ writeId, outcome: "replied", startedAt: q.startedAt, reply: buf, binary }, ctx);
          resolve(buf);
        },
        reject: (err) => {
          const tagged = (err as { auditOutcome?: ScpiOutcome }).auditOutcome;
          const outcome = tagged ?? (q.written ? "connection_closed" : "not_written");
          audit.scpiResult({ writeId, outcome, startedAt: q.startedAt }, ctx);
          reject(err);
        },
      };
      this.queryQueue.push(q);
      this.drainQueue();
    });
  }

  private drainQueue(): void {
    if (this.queryRunning || this.queryQueue.length === 0) return;
    this.queryRunning = true;

    const q = this.queryQueue.shift()!;
    const { cmd, binary, timeout, resolve, reject } = q;

    this.expectedBinaryLength = null;
    this.binaryDataStart = 0;
    this.headerParsed = false;
    this.dataBuffer = Buffer.alloc(0);

    this.responseResolve = (buf) => {
      this.queryRunning = false;
      resolve(buf);
      this.drainQueue();
    };
    this.responseReject = (err) => {
      this.queryRunning = false;
      reject(err);
      this.drainQueue();
    };

    this.responseTimer = setTimeout(() => {
      this.clearPending();
      const err = outcomeError(
        `${binary ? "Binary query" : "Query"} timeout after ${timeout}ms for command: ${cmd}`,
        "timeout"
      );
      this.queryRunning = false;
      reject(err);
      this.drainQueue();
    }, timeout);

    q.written = true;
    q.startedAt = Date.now();
    audit.scpiWrite(
      { writeId: q.writeId, command: cmd, kind: binary ? "binary-query" : "query", host: this.host, port: this.port },
      q.ctx
    );
    this.socket!.write(cmd + "\n", (err) => {
      if (err) {
        this.clearPending();
        this.queryRunning = false;
        reject(outcomeError(`Write failed: ${err.message}`, "write_failed"));
        this.drainQueue();
      }
    });
  }

  private setupSocketListeners(): void {
    this.socket!.on("data", (chunk: Buffer) => {
      this.dataBuffer = Buffer.concat([this.dataBuffer, chunk]);
      this.tryResolve();
    });

    this.socket!.on("close", () => {
      // The instrument (or the network) closed the socket: no call caused it.
      audit.instrumentDisconnect(
        { host: this.host, port: this.port, reason: this.lastSocketError ? "socket_error" : "socket_closed" },
        { cause: "socket" }
      );
      this.lastSocketError = null;
      const pending = this.queryQueue.splice(0);
      this.queryRunning = false;
      if (this.responseReject) {
        this.responseReject(new Error("Connection closed unexpectedly"));
      }
      this.clearPending();
      for (const q of pending) {
        q.reject(new Error("Connection closed unexpectedly"));
      }
      this.socket = null;
    });

    this.socket!.on("error", (err) => {
      this.lastSocketError = err.message;
      if (this.responseReject) {
        this.responseReject(new Error(`Socket error: ${err.message}`));
      }
      this.clearPending();
    });
  }

  private tryResolve(): void {
    if (!this.responseResolve) return;

    // Try to detect binary framing format
    if (!this.headerParsed && this.dataBuffer.length >= 6) {
      // Check for raw BMP: starts with "BM" magic bytes
      if (this.dataBuffer[0] === 0x42 && this.dataBuffer[1] === 0x4d) {
        const bmpSize = this.dataBuffer.readUInt32LE(2);
        if (bmpSize > 0 && bmpSize < 100_000_000) {
          this.expectedBinaryLength = bmpSize;
          this.binaryDataStart = 0;
          this.headerParsed = true;
        }
      }

      // Check for IEEE 488.2 definite length block: #<digitCount><digits><data>
      if (!this.headerParsed) {
        const hashIndex = this.dataBuffer.indexOf(0x23); // '#'
        if (hashIndex >= 0 && hashIndex + 2 <= this.dataBuffer.length) {
          const digitCount = this.dataBuffer[hashIndex + 1] - 0x30;
          if (digitCount >= 1 && digitCount <= 9) {
            const headerSize = 2 + digitCount;
            if (hashIndex + headerSize <= this.dataBuffer.length) {
              const lengthStr = this.dataBuffer
                .subarray(hashIndex + 2, hashIndex + headerSize)
                .toString("ascii");
              const dataLength = parseInt(lengthStr, 10);
              if (!isNaN(dataLength) && dataLength > 0) {
                this.expectedBinaryLength = dataLength;
                this.binaryDataStart = hashIndex + headerSize;
                this.headerParsed = true;
              }
            }
          }
        }
      }
    }

    if (this.expectedBinaryLength !== null && this.headerParsed) {
      const trailingBytes = this.binaryDataStart === 0 ? 1 : 2;
      const totalExpected = this.binaryDataStart + this.expectedBinaryLength + trailingBytes;
      if (this.dataBuffer.length >= totalExpected) {
        const binaryData = this.dataBuffer.subarray(
          this.binaryDataStart,
          this.binaryDataStart + this.expectedBinaryLength
        );
        const resolve = this.responseResolve;
        this.clearPending();
        resolve(Buffer.from(binaryData));
      }
    } else {
      // Text mode: look for newline terminator
      const newlineIndex = this.dataBuffer.indexOf(0x0a);
      if (newlineIndex >= 0) {
        const response = this.dataBuffer.subarray(0, newlineIndex);
        const resolve = this.responseResolve;
        this.clearPending();
        resolve(Buffer.from(response));
      }
    }
  }

  private clearPending(): void {
    if (this.responseTimer) {
      clearTimeout(this.responseTimer);
      this.responseTimer = null;
    }
    this.responseResolve = null;
    this.responseReject = null;
    this.expectedBinaryLength = null;
    this.binaryDataStart = 0;
    this.headerParsed = false;
  }

  private ensureConnected(): void {
    if (!this.isConnected()) {
      throw new Error(
        "Not connected to waveform generator. Use the 'connect' tool first."
      );
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Singleton instance
export const connection = new SiglentConnection();
