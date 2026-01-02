// scripts/import-taxfoundation.ts
//
// Importa o XLSX do Tax Foundation (layout multi-linha por estado) e
// gera src/lib/tax/2026/<STATE>.json para FilingStatus=single.
//
// Requer:
//   npm i xlsx
//
// Coloque o arquivo em:
//   scripts/data/taxfoundation-2026.xlsx
//
// Rode:
//   npx ts-node scripts/import-taxfoundation.ts

import fs from "fs";
import path from "path";
import * as XLSX from "xlsx";

type FilingStatus = "single";
type TaxType = "flat" | "progressive";

type TaxBracket = { upTo: number | null; rate: number };

type StateTaxRules = {
  state: string; // ex "NC"
  year: number;
  hasIncomeTax: boolean;

  taxType?: TaxType;
  flatRate?: { filingStatus: FilingStatus; rate: number };
  brackets?: Partial<Record<FilingStatus, TaxBracket[]>>;

  standardDeduction?: Partial<Record<FilingStatus, number>>;
  personalExemption?: Partial<Record<FilingStatus, number>>;

  notes?: string;
  verified: boolean;
  confidence: "verified" | "estimated";
  source: string[];
  lastReviewed: string;

  errors?: string[];
};

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function writeJson(filePath: string, obj: any) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + "\n", "utf-8");
}

function isFiniteNumber(x: any): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function parseRateCell(v: any): number | null {
  // Tax Foundation XLSX normalmente traz rate como 0.0425 (não 4.25)
  if (v == null) return null;

  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    return v > 1 ? v / 100 : v;
  }

  const t = String(v).trim();
  if (!t) return null;

  const low = t.toLowerCase();
  if (low === "n.a." || low === "na") return null;
  if (low === "none") return null;

  if (t.includes("%")) {
    const n = Number(t.replace("%", "").trim());
    return Number.isFinite(n) ? n / 100 : null;
  }

  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return n > 1 ? n / 100 : n;
}

function parseMoneyCell(v: any): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;

  const t = String(v).trim();
  if (!t) return null;

  const low = t.toLowerCase();
  if (low === "n.a." || low === "na") return null;
  if (low === "none") return null;

  const cleaned = t.replace(/[$,]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// -------------------- State label normalization --------------------

/**
 * Remove sufixos de notas no final:
 *  - "Colo. (a, o)" -> "Colo."
 *  - "Idaho (j, m, u)" -> "Idaho"
 *  - "Pa. (a)" -> "Pa."
 */
function cleanStateLabel(raw: string): string {
  let s = String(raw || "").trim();
  s = s.replace(/\s*\([^)]*\)\s*$/, "").trim();
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/**
 * Linhas que começam com "(" são notas/rodapés (não são estados)
 * Ex.: "(a, b, c)" ou "(d) ..." etc.
 */
function isFootnoteStateLabel(raw: string): boolean {
  const s = String(raw || "").trim();
  if (!s) return true;
  if (s.startsWith("(")) return true;
  // frases longas também são notas
  if (s.length > 35 && s.includes(")")) return true;
  return false;
}

const STATE_NAME_TO_CODE: Record<string, string> = {
  // Abreviações com ponto (TF usa muito)
  "ala.": "AL",
  "ariz.": "AZ",
  "ark.": "AR",
  "calif.": "CA",
  "colo.": "CO",
  "conn.": "CT",
  "del.": "DE",
  "d.c.": "DC",
  "fla.": "FL",
  "ga.": "GA",
  "ill.": "IL",
  "ind.": "IN",
  "kan.": "KS",
  "kans.": "KS",
  "ky.": "KY",
  "la.": "LA",
  "mass.": "MA",
  "md.": "MD",
  "mich.": "MI",
  "minn.": "MN",
  "miss.": "MS",
  "mo.": "MO",
  "mont.": "MT",
  "neb.": "NE",
  "nebr.": "NE",
  "nev.": "NV",
  "n.h.": "NH",
  "n.j.": "NJ",
  "n.m.": "NM",
  "n.y.": "NY",
  "n.c.": "NC",
  "n.d.": "ND",
  "okla.": "OK",
  "ore.": "OR",
  "pa.": "PA",
  "r.i.": "RI",
  "s.c.": "SC",
  "s.d.": "SD",
  "tenn.": "TN",
  "tex.": "TX",
  "vt.": "VT",
  "va.": "VA",
  "wash.": "WA",
  "wis.": "WI",
  "wyo.": "WY",
  "w. va.": "WV",
  "w.va.": "WV",
  "w.va": "WV",

  // Nomes completos
  "alabama": "AL",
  "alaska": "AK",
  "arizona": "AZ",
  "arkansas": "AR",
  "california": "CA",
  "colorado": "CO",
  "connecticut": "CT",
  "delaware": "DE",
  "district of columbia": "DC",
  "florida": "FL",
  "georgia": "GA",
  "hawaii": "HI",
  "idaho": "ID",
  "illinois": "IL",
  "indiana": "IN",
  "iowa": "IA",
  "kansas": "KS",
  "kentucky": "KY",
  "louisiana": "LA",
  "maine": "ME",
  "maryland": "MD",
  "massachusetts": "MA",
  "michigan": "MI",
  "minnesota": "MN",
  "mississippi": "MS",
  "missouri": "MO",
  "montana": "MT",
  "nebraska": "NE",
  "nevada": "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  "ohio": "OH",
  "oklahoma": "OK",
  "oregon": "OR",
  "pennsylvania": "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  "tennessee": "TN",
  "texas": "TX",
  "utah": "UT",
  "vermont": "VT",
  "virginia": "VA",
  "washington": "WA",
  "west virginia": "WV",
  "wisconsin": "WI",
  "wyoming": "WY",
};

function toStateCodeFromSheet(v: any): string {
  const raw = String(v ?? "").trim();
  if (!raw) return "";

  // já é USPS code
  if (/^[A-Za-z]{2}$/.test(raw)) return raw.toUpperCase();

  const cleaned = cleanStateLabel(raw).toLowerCase();
  return STATE_NAME_TO_CODE[cleaned] ?? "";
}

// -------------------- bracket conversion --------------------

/**
 * TF fornece "over X" (limite inferior). Seu schema usa upTo (limite superior).
 * Convertemos lower bounds em upTo usando o próximo lower como teto.
 *
 * Ex.: lows [0, 500, 3000] rates [0.02,0.04,0.05]
 * => [{upTo:500,rate:0.02},{upTo:3000,rate:0.04},{upTo:null,rate:0.05}]
 */
function lowersToUpTo(lowers: number[], rates: number[]): TaxBracket[] {
  const pairs = lowers
    .map((lo, i) => ({ lo, rate: rates[i] }))
    .filter((p) => isFiniteNumber(p.lo) && isFiniteNumber(p.rate));

  pairs.sort((a, b) => a.lo - b.lo);

  const out: TaxBracket[] = [];
  for (let i = 0; i < pairs.length; i++) {
    const next = pairs[i + 1]?.lo;
    out.push({
      upTo: typeof next === "number" ? next : null,
      rate: pairs[i].rate,
    });
  }
  return out;
}

function pickSheetWithMostRows(wb: XLSX.WorkBook) {
  let best = wb.SheetNames[0];
  let bestCount = -1;

  for (const name of wb.SheetNames) {
    const sh = wb.Sheets[name];
    const aoa = XLSX.utils.sheet_to_json(sh, { header: 1, defval: "" }) as any[][];
    const count = aoa.length;
    if (count > bestCount) {
      bestCount = count;
      best = name;
    }
  }
  return best;
}

function main() {
  const year = 2026;

  const xlsxPath = path.resolve(process.cwd(), "scripts/data/taxfoundation-2026.xlsx");
  if (!fs.existsSync(xlsxPath)) throw new Error(`Missing XLSX: ${xlsxPath}`);

  const wb = XLSX.readFile(xlsxPath);

  // geralmente é "Sheet1", mas escolher a maior aba evita "Cover/Notes"
  const sheetName = pickSheetWithMostRows(wb);
  const sheet = wb.Sheets[sheetName];

  // Ler como AOA para usar índices fixos de coluna
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" }) as any[][];

  // Detectar header procurando "State" na primeira coluna
  let headerRowIdx = -1;
  for (let i = 0; i < Math.min(10, aoa.length); i++) {
    const first = String(aoa[i]?.[0] ?? "").trim().toLowerCase();
    if (first === "state") {
      headerRowIdx = i;
      break;
    }
  }
  if (headerRowIdx === -1) {
    throw new Error(
      `Could not find header row with "State" in first column. Sheet="${sheetName}".`
    );
  }

  const data = aoa.slice(headerRowIdx + 1);

  // Índices (layout comum do TF 2026)
  // A: State
  // B: Single Rates
  // D: Single Brackets (lower bound / "over")
  // H: Standard Deduction (single)
  // J: Personal Exemption (single)
  const idxState = 0;
  const idxSingleRate = 1;
  const idxSingleBracket = 3;
  const idxStdDedSingle = 7;
  const idxPersExSingle = 9;

  type Tmp = {
    stateLabel: string;
    stCode: string;
    hasIncomeTax: boolean;
    lows: number[];
    rates: number[];
    stdDedSingle: number | null;
    persExSingle: number | null;
    errors: string[];
  };

  const states: Tmp[] = [];
  let cur: Tmp | null = null;

  for (const row of data) {
    const stateCell = row[idxState];

    // Novo estado se coluna A está preenchida
    if (String(stateCell ?? "").trim()) {
      const rawLabel = String(stateCell).trim();

      // Ignorar notas/rodapés
      if (isFootnoteStateLabel(rawLabel)) continue;

      // flush anterior
      if (cur) states.push(cur);

      const label = cleanStateLabel(rawLabel);
      const code = toStateCodeFromSheet(label);

      cur = {
        stateLabel: label,
        stCode: code,
        hasIncomeTax: true,
        lows: [],
        rates: [],
        stdDedSingle: parseMoneyCell(row[idxStdDedSingle]),
        persExSingle: parseMoneyCell(row[idxPersExSingle]),
        errors: [],
      };

      if (!code) {
        cur.errors.push(`Unmapped state label: "${label}" (raw="${rawLabel}")`);
      }
    }

    if (!cur) continue;

    // Se taxa vier "none" => sem imposto de renda (no wage income tax)
    const rateRaw = row[idxSingleRate];
    if (typeof rateRaw === "string" && rateRaw.trim().toLowerCase() === "none") {
      cur.hasIncomeTax = false;
      continue;
    }

    const r = parseRateCell(rateRaw);
    const lo = parseMoneyCell(row[idxSingleBracket]);

    // Muitas linhas são vazias; ignore
    if (r == null && lo == null) continue;

    if (r != null) cur.rates.push(r);
    if (lo != null) cur.lows.push(lo);
  }

  if (cur) states.push(cur);

  const outDir = path.resolve(process.cwd(), "src/lib/tax", String(year));
  ensureDir(outDir);

  let written = 0;

  for (const s of states) {
    if (!s.stCode) continue;

    const rule: StateTaxRules = {
      state: s.stCode,
      year,
      hasIncomeTax: s.hasIncomeTax,

      taxType: undefined,
      flatRate: undefined,
      brackets: { single: [] },

      standardDeduction: { single: s.stdDedSingle ?? 0 },
      personalExemption: { single: s.persExSingle ?? 0 },

      notes:
        "Imported from Tax Foundation XLSX (2026). Thresholds converted from lower-bounds to upTo using the next bracket threshold.",
      verified: true,
      confidence: "verified",
      source: ["https://taxfoundation.org/data/all/state/state-income-tax-rates/"],
      lastReviewed: nowIso(),
      errors: s.errors.length ? s.errors : [],
    };

    if (!s.hasIncomeTax) {
      rule.taxType = undefined;
      rule.flatRate = undefined;
      rule.brackets = { single: [] };
      writeJson(path.join(outDir, `${rule.state}.json`), rule);
      written++;
      continue;
    }

    const uniqRates = Array.from(new Set(s.rates.map((x) => Number(x.toFixed(6)))));
    const n = Math.min(s.lows.length, s.rates.length);

    const lows = s.lows.slice(0, n);
    const rates = s.rates.slice(0, n);

    const hasMultipleBrackets = lows.length >= 2 || uniqRates.length >= 2;

    if (!hasMultipleBrackets && uniqRates.length === 1) {
      rule.taxType = "flat";
      rule.flatRate = { filingStatus: "single", rate: uniqRates[0] };
      rule.brackets = { single: [] };
    } else {
      rule.taxType = "progressive";
      const br = lowersToUpTo(lows, rates);

      // fallback safety
      if (!br.length && uniqRates.length === 1) {
        rule.taxType = "flat";
        rule.flatRate = { filingStatus: "single", rate: uniqRates[0] };
        rule.brackets = { single: [] };
      } else {
        rule.brackets = { single: br };
      }
    }

    writeJson(path.join(outDir, `${rule.state}.json`), rule);
    written++;
  }

  console.log(`Wrote ${written} states to ${outDir}`);

    // -------------------- compile all states into one file --------------------

const compiled: Record<string, any> = {};
for (const f of fs.readdirSync(outDir).filter((x) => x.endsWith(".json"))) {
  const st = f.replace(/\.json$/i, "").toUpperCase();
  compiled[st] = JSON.parse(
    fs.readFileSync(path.join(outDir, f), "utf-8")
  );
}

const compiledPath = path.join(
  path.dirname(outDir),
  `compiled_${year}_all_states.json`
);

fs.writeFileSync(
  compiledPath,
  JSON.stringify(compiled, null, 2) + "\n",
  "utf-8"
);

console.log("Compiled:", compiledPath);

  const unmapped = states.filter((x) => !x.stCode).map((x) => x.stateLabel);
  if (unmapped.length) {
    console.warn(`Unmapped state labels (${unmapped.length}):`, unmapped);
  }
}

main();
