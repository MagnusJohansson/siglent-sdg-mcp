import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
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

describe("assertIsQuery: action commands in query form", () => {
  it.each([
    // Long, short, in-between and lower-case spellings, with and without a channel.
    "C1:SWEep:MTRigger?",
    "C2:SWE:MTR?",
    "C1:TRIGger?",
    "C1:TRIG?",
    ":C2:TRIG:SEQ:IMM?",
    "C1:TRIGger:IMMediate?",
    "C1:TRIGger:SEQuence?",
    "TRIG?",
    "C1:SEQuence:DEFAult?",
    "C1:SEQ:NEW?",
    "C1:SEQ:REC?",
    "C1:SEQuence:SAVe?",
    "C1:SEQuence:SEGMent3:DELEte?",
    "C1:SEQ:SEGM12:INSE?",
    "C1:FHOP:CFLIst?",
    "C1:FHOP:CFLIS?",
    "c1:fhop:cflist?",
    "C1:FHOP:COLI?",
    "C1:FHOP:CALIst?",
    "C1:FHOP:DALIst?",
    "C2:FHOP:SFLI?",
    ":SENSe:COUNTer:CLEar?",
    "SENS:COUNT:CLE?",
    "PACP?",
    "PARACOPY?",
    "VKEY?",
    "MMEMory:DELete?",
    "MMEM:MDIR?",
    "MMEM:TRAN?",
    "MMEM:SAVE:XML?",
    "MMEMory:LOAD:XML?",
  ])("rejects %s", (cmd) => {
    expect(() => assertIsQuery(cmd)).toThrow(/action command/);
  });

  it.each([
    "C1:TRIGger:SOURce?",
    "C1:TRIG:SEQ:SOUR?",
    "C1:TRIGger:TIMer?",
    "C1:TRIG:SLOP?",
    "IQ:TRIGger:SOURce?",
    "C1:SEQuence:SCALe?",
    "C1:SEQuence:SEGMent3:WAVeform?",
    "C1:FHOP:STATe?",
    "C1:SWEep:FMARker?",
    // Documented with a response format, so a query (see docs/threat-model.md).
    "EQPHASE?",
  ])("accepts the neighbouring query %s", (cmd) => {
    expect(() => assertIsQuery(cmd)).not.toThrow();
  });

  it("blocks no query documented in the programming guide", () => {
    const guide = readFileSync(new URL("../../docs/programming-guide.md", import.meta.url), "utf8");
    const queries = [...guide.matchAll(/^[:*]?[A-Za-z][A-Za-z0-9_<>:[\] ]*\?/gm)].map((m) =>
      m[0]
        .replace(/<channel>/g, "C1")
        .replace(/<x>/g, "1")
        .replace(/\[[^\]]*\]/g, "")
        .replace(/\s+/g, "")
    );
    expect(queries.length).toBeGreaterThan(200);
    const blocked = queries.filter((q) => {
      try {
        assertIsQuery(q);
        return false;
      } catch (err) {
        return /action command/.test(String(err));
      }
    });
    expect(blocked).toEqual([]);
  });
});
