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
  /** Basic wave amplitude (Vpp) and offset (V). HLEV/LLEV are derived. */
  amp: number;
  offset: number;
}

/** SDG1032X default setup, as recalled by *RST (observed on hardware: 4 Vpp, 0 V). */
function defaultChannel(): ChannelState {
  return { output: "OFF", load: "HZ", polarity: "NOR", amp: 4, offset: 0 };
}

export class SdgSimulator {
  private server: net.Server;
  private sockets = new Set<net.Socket>();
  /** Every line received, in order (without the terminating newline). */
  readonly received: string[] = [];
  readonly channels: Record<"C1" | "C2", ChannelState> = {
    C1: defaultChannel(),
    C2: defaultChannel(),
  };
  /** Reset both channels to the default setup (test isolation). */
  resetState(): void {
    this.channels.C1 = defaultChannel();
    this.channels.C2 = defaultChannel();
  }

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
      this.channels.C1 = defaultChannel();
      this.channels.C2 = defaultChannel();
      return undefined;
    }

    const copy = /^PACP (C[12]),(C[12])$/.exec(upper);
    if (copy) {
      const [dest, src] = [copy[1] as "C1" | "C2", copy[2] as "C1" | "C2"];
      this.channels[dest] = { ...this.channels[src], output: this.channels[dest].output };
      return undefined;
    }

    const bswvQuery = /^(C[12]):BSWV\?$/.exec(upper);
    if (bswvQuery) {
      const ch = this.channels[bswvQuery[1] as "C1" | "C2"];
      const h = ch.offset + ch.amp / 2;
      const l = ch.offset - ch.amp / 2;
      return `${bswvQuery[1]}:BSWV WVTP,SINE,FRQ,1000HZ,PERI,0.001S,AMP,${ch.amp}V,AMPVRMS,${(ch.amp / 2.828).toFixed(4)}Vrms,OFST,${ch.offset}V,HLEV,${h}V,LLEV,${l}V,PHSE,0`;
    }

    const bswvSet = /^(C[12]):BSWV (.+)$/.exec(upper);
    if (bswvSet) {
      const ch = this.channels[bswvSet[1] as "C1" | "C2"];
      const t = bswvSet[2].split(",").map((p) => p.trim());
      let hlev: number | undefined;
      let llev: number | undefined;
      for (let i = 0; i + 1 < t.length; i += 2) {
        const v = Number(t[i + 1]);
        if (t[i] === "AMP") ch.amp = v;
        else if (t[i] === "OFST") ch.offset = v;
        else if (t[i] === "HLEV") hlev = v;
        else if (t[i] === "LLEV") llev = v;
      }
      if (hlev !== undefined || llev !== undefined) {
        const hi = hlev ?? ch.offset + ch.amp / 2;
        const lo = llev ?? ch.offset - ch.amp / 2;
        ch.amp = hi - lo;
        ch.offset = (hi + lo) / 2;
      }
      return undefined;
    }

    // Any other query gets a generic echo so tests don't hit timeouts.
    if (upper.includes("?")) return upper.replace("?", "") + " SIM";
    return undefined;
  }
}
