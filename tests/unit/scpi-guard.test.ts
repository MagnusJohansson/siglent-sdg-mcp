import { describe, it, expect } from "vitest";
import {
  assertIsQuery,
  assertWireSafe,
  assertWithinLimits,
  ScpiPolicyError,
} from "../../src/security/scpi-guard.js";

describe("assertWireSafe", () => {
  it.each(["*IDN?", "C1:OUTP ON", "C1:BSWV WVTP,SINE,FRQ,1000,AMP,2", 'C1:ARWV NAME,"wave1"'])(
    "accepts %s",
    (cmd) => {
      expect(() => assertWireSafe(cmd)).not.toThrow();
    }
  );

  it.each([
    ["newline injection", "C1:OUTP LOAD,50\nC1:OUTP ON"],
    ["carriage return", "C1:OUTP LOAD,50\rC1:OUTP ON"],
    ["compound command", "C1:OUTP?;C1:OUTP ON"],
    ["NUL byte", "C1:OUTP\u0000ON"],
    ["tab", "C1:OUTP\tON"],
    ["DEL", "C1:OUTP\u007fON"],
    ["non-ASCII", "C1:ARWV NAME,\"wåve\""],
    ["empty", ""],
    ["oversized", "C1:BSWV " + "A".repeat(600)],
  ])("rejects %s", (_label, cmd) => {
    expect(() => assertWireSafe(cmd)).toThrow(ScpiPolicyError);
  });
});

describe("assertIsQuery", () => {
  it.each(["*IDN?", "C1:OUTP?", "C1:BSWV?", "c1:outp?", "WVDT? USER,wave1", "STL? BUILDIN"])(
    "accepts query %s",
    (cmd) => {
      expect(() => assertIsQuery(cmd)).not.toThrow();
    }
  );

  it.each([
    ["setter via read-only tool (the original F1)", "C1:OUTP ON"],
    ["reset", "*RST"],
    ["long-form setter", "C1:OUTPut ON"],
    ["question mark after parameters", "C1:OUTP ON?"],
    ["compound query hiding a setter", "C1:OUTP?;C1:OUTP ON"],
    ["newline hiding a setter", "C1:OUTP?\nC1:OUTP ON"],
    ["two question marks", "C1:OUTP??"],
    ["header with space before ?", "C1:OUTP ?"],
  ])("rejects %s", (_label, cmd) => {
    expect(() => assertIsQuery(cmd)).toThrow(ScpiPolicyError);
  });
});

describe("assertWithinLimits", () => {
  const limits = { maxAmplitudeVpp: 5, maxVoltage: 3 };

  it("is a no-op when no limits are configured", () => {
    expect(() => assertWithinLimits("C1:BSWV AMP,20,OFST,10", {})).not.toThrow();
  });

  it.each([
    "C1:BSWV WVTP,SINE,FRQ,1000,AMP,5,OFST,-3",
    "C2:BSWV HLEV,3,LLEV,-3",
    "C1:MDWV CARR,AMP,4",
    "C1:SWWV TIME,1,CARR,AMP,2",
    "C1:BTWV PRD,0.01,CARR,AMP,5",
    "C1:BSWV WVTP,NOISE,STDEV,0.5,MEAN,1",
    "C1:OUTP ON", // not a waveform header: not checked here
  ])("accepts %s", (cmd) => {
    expect(() => assertWithinLimits(cmd, limits)).not.toThrow();
  });

  it.each([
    ["amplitude over limit", "C1:BSWV AMP,5.01"],
    ["offset over limit", "C1:BSWV OFST,3.5"],
    ["negative offset over limit", "C1:BSWV OFST,-3.5"],
    ["high level over limit", "C1:BSWV HLEV,4"],
    ["low level over limit", "C1:BSWV LLEV,-4"],
    ["noise mean over limit", "C1:BSWV MEAN,4"],
    ["noise sigma too large", "C1:BSWV STDEV,1"],
    ["modulation carrier amplitude", "C1:MDWV CARR,AMP,10"],
    ["sweep carrier amplitude", "C2:SWWV CARR,AMP,10"],
    ["burst carrier offset", "C1:BTWV CARR,OFST,5"],
    ["amplitude in Vrms (cannot be bounded)", "C1:BSWV AMPVRMS,1"],
    ["amplitude in dBm (cannot be bounded)", "C1:BSWV AMPDBM,10"],
    ["raising the instrument's own limit", "C1:BSWV MAX_OUTPUT_AMP,20"],
    ["non-numeric amplitude", "C1:BSWV AMP,MAX"],
    ["missing amplitude value", "C1:BSWV AMP"],
  ])("rejects %s", (_label, cmd) => {
    expect(() => assertWithinLimits(cmd, limits)).toThrow(ScpiPolicyError);
  });

  it("applies only the limits that are configured", () => {
    expect(() => assertWithinLimits("C1:BSWV OFST,10", { maxAmplitudeVpp: 5 })).not.toThrow();
    expect(() => assertWithinLimits("C1:BSWV AMP,10", { maxVoltage: 3 })).not.toThrow();
  });
});
