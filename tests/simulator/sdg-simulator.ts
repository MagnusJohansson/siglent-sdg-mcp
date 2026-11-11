/**
 * Minimal Siglent SDG simulator: a TCP server that speaks just enough SCPI
 * for tests to run the real connection code over a real socket, without
 * hardware.
 *
 * It records every line it receives, so tests can assert what actually
 * reached the wire. That matters for security tests: "the tool returned an
 * error" is not enough; the proof is that nothing was sent.
 */
import * as net from "node:net";

export const SIM_IDN = "Siglent Technologies,SDG1032X,SIM0000001,1.01.01.33R1";

interface ChannelState {
  output: "ON" | "OFF";
  load: string;
  polarity: string;
}

export class SdgSimulator {
  private server: net.Server;
  private sockets = new Set<net.Socket>();
  /** Every line received, in order (without the terminating newline). */
  readonly received: string[] = [];
  readonly channels: Record<"C1" | "C2", ChannelState> = {
    C1: { output: "OFF", load: "HZ", polarity: "NOR" },
    C2: { output: "OFF", load: "HZ", polarity: "NOR" },
  };

  constructor() {
    this.server = net.createServer((socket) => this.handle(socket));
  }

  /** Start listening on 127.0.0.1 with an ephemeral port; resolves to the port. */
  async start(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    return (this.server.address() as net.AddressInfo).port;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Lines received, excluding *OPC? sync barriers. */
  commands(): string[] {
    return this.received.filter((l) => l !== "*OPC?");
  }

  clear(): void {
    this.received.length = 0;
  }

  private handle(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        this.received.push(line);
        const reply = this.process(line.trim());
        if (reply !== undefined) socket.write(reply + "\n");
      }
    });
  }

  private process(line: string): string | undefined {
    const upper = line.toUpperCase();

    if (upper === "*IDN?") return SIM_IDN;
    // Operation complete: used by tests as a sync barrier.
    if (upper === "*OPC?") return "1";

    const outQuery = /^(C[12]):OUTP\?$/.exec(upper);
    if (outQuery) {
      const ch = this.channels[outQuery[1] as "C1" | "C2"];
      return `${outQuery[1]}:OUTP ${ch.output},LOAD,${ch.load},PLRT,${ch.polarity}`;
    }

    const outSet = /^(C[12]):OUTP (.+)$/.exec(upper);
    if (outSet) {
      const ch = this.channels[outSet[1] as "C1" | "C2"];
      const parts = outSet[2].split(",").map((p) => p.trim());
      for (let i = 0; i < parts.length; i++) {
        if (parts[i] === "ON" || parts[i] === "OFF") ch.output = parts[i] as "ON" | "OFF";
        else if (parts[i] === "LOAD") ch.load = parts[++i];
        else if (parts[i] === "PLRT") ch.polarity = parts[++i];
      }
      return undefined;
    }

    if (upper === "*RST") {
      for (const ch of Object.values(this.channels)) {
        ch.output = "OFF";
        ch.load = "HZ";
        ch.polarity = "NOR";
      }
      return undefined;
    }

    // Any other query gets a generic echo so tests don't hit timeouts.
    if (upper.includes("?")) return upper.replace("?", "") + " SIM";
    return undefined;
  }
}
