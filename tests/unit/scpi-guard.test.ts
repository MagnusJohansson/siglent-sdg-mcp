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
    ["empty header node", "C1::TRIG?"],
    ["empty last node", "C1:TRIG:?"],
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
    "EQPHASE?",
    // Spellings outside the guide's notation that SCPI parsers commonly accept.
    "C1:TRIGger1?",
    "SENS1:COUNT:CLE?",
    "C1:SENS:COUNT:CLE?",
    "C1:MMEM:DEL?",
    "C1:SEQ:SEGM:DELE?",
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
  ])("accepts the neighbouring query %s", (cmd) => {
    expect(() => assertIsQuery(cmd)).not.toThrow();
  });

  it("accepts every query documented in the programming guide, in long and short form", () => {
    const guide = readFileSync(new URL("../../docs/programming-guide.md", import.meta.url), "utf8");
    const documented = [
      ...guide.matchAll(/QUERY SYNTAX\**\s*(?:\(\^\)\s*)?(?:Format\s*\d:\s*)?([^\n]*\?)/g),
    ].map((m) =>
      m[1]
        .replace(/<\s*channel\s*>/gi, "C1")
        .replace(/<\s*(x|index)\s*>/gi, "1")
        .replace(/\[[^\]]*\]/g, "")
        .replace(/\s+/g, "")
    );
    // The SCPI short form of each node: "SWEep" -> "SWE". Siglent's older
    // mixed-case names (Comm_HeaDeR, BursTWaVe) aren't SCPI mnemonics.
    const short = (q: string) =>
      q
        .slice(0, -1)
        .split(":")
        .map((n) => (/^[A-Z0-9]+[a-z]+\d*$/.test(n) ? n.replace(/[a-z]+/, "") : n))
        .join(":") + "?";
    // Typos in the guide's own syntax lines, not queries anyone can send.
    const notQueries = new Set(["C1:BTWV(BursTWaVe)?", ":SENSe:COUNTer:CONFig:<parameter>?"]);

    const queries = new Set(documented.filter((q) => !notQueries.has(q)).flatMap((q) => [q, short(q)]));
    expect(queries.size).toBeGreaterThan(250);
    const rejected = [...queries].filter((q) => {
      try {
        assertIsQuery(q);
        return false;
      } catch {
        return true;
      }
    });
    expect(rejected).toEqual([]);
  });
});
