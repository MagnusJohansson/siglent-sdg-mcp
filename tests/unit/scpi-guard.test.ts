import { describe, it, expect } from "vitest";
import { assertIsQuery, assertWireSafe, ScpiPolicyError } from "../../src/security/scpi-guard.js";

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
  it.each([
    "*IDN?",
    "*OPC?",
    "C1:OUTP?",
    "C1:BSWV?",
    "c1:outp?",
    ":SENSe:COUNTer:FREQuency?",
    "STL?",
    "STL? BUILDIN",
    "STL? USER",
    'STL? USER,"net_storage/wave"',
    'MMEMory:CATalog? "Local"',
    'MMEM:CAT? "Local"',
    'MMEMory:CATalog:DATA:ARBitrary? "Local"',
    'MMEM:CAT:STAT:XML? "Local"',
  ])("accepts query %s", (cmd) => {
    expect(() => assertIsQuery(cmd)).not.toThrow();
  });

  it.each([
    ["setter via read-only tool (the original F1)", "C1:OUTP ON"],
    ["reset", "*RST"],
    ["long-form setter", "C1:OUTPut ON"],
    ["question mark after parameters", "C1:OUTP ON?"],
    ["compound query hiding a setter", "C1:OUTP?;C1:OUTP ON"],
    ["newline hiding a setter", "C1:OUTP?\nC1:OUTP ON"],
    ["two question marks", "C1:OUTP??"],
    ["header with space before ?", "C1:OUTP ?"],
    ["double root colon", "::SENS?"],
    ["root colon on a common command", ":*IDN?"],
    ["root-colon setter", ":SENSe:COUNTer:STATe ON"],
    ["setter parameters after a query header", "C1:BSWV? FRQ,1234"],
    ["ON after an output query", "C1:OUTP? ON"],
    ["reset in query form", "*RST?"],
    ["self-test in query form", "*TST?"],
    ["clear status in query form", "*CLS?"],
    ["event status register read (clears the register)", "*ESR?"],
    ["WVDT? (binary reply; parameters overlap the WVDT setter)", "WVDT? USER,wave1"],
    ["setter-shaped WVDT? parameters", "WVDT? WVNM,x,WAVEDATA,AAAA"],
    ["undocumented STL? parameters", "STL? WVNM,x"],
    ["STL? path without quotes", "STL? USER,net_storage"],
    ["MMEM catalog without a quoted path", "MMEM:CAT? Local"],
    ["parameters on a query that takes none", 'C1:BSWV? "Local"'],
  ])("rejects %s", (_label, cmd) => {
    expect(() => assertIsQuery(cmd)).toThrow(ScpiPolicyError);
  });
});
