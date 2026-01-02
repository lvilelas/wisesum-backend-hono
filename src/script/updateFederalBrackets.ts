/**
 * Update Federal Tax JSON (brackets + standard deduction from IRS Rev Proc)
 * and merge premium constants from a local template file.
 *
 * Usage:
 *   ts-node scripts/updateFederalBrackets.ts 2026
 *
 * Outputs:
 *   src/data/federal/2026.json
 */

import fs from "fs";
import path from "path";

type FilingStatus = "single" | "mfj" | "hoh" | "mfs";

type Bracket = { upTo: number | null; rate: number };

type FederalPremiumJson = {
  itemized?: {
    saltCap?: number;
  };
  qbi?: {
    rate?: number; // usually 0.20
    threshold?: Partial<Record<FilingStatus, number>>;
  };
  niit?: {
    rate?: number; // usually 0.038
    threshold?: Partial<Record<FilingStatus, number>>;
  };
  ctc?: {
    perQualifyingChild?: number;
    perOtherDependent?: number;
    phaseoutStart?: Partial<Record<FilingStatus, number>>;
    phaseoutStep?: number;
    phaseoutAmountPerStep?: number;
    maxRefundablePerChild?: number;
  };
  eitc?: {
    investmentIncomeLimit?: number;
    table?: Record<
      `${FilingStatus}_${0 | 1 | 2 | 3}`,
      {
        phaseInRate: number;
        maxCredit: number;
        phaseOutStart: number;
        phaseOutRate: number;
      }
    >;
  };
};

type FederalJson = {
  taxYear: number;
  source: string;
  standardDeduction: Record<FilingStatus, number>;
  brackets: Record<FilingStatus, Bracket[]>;
  // premium
  itemized?: { saltCap: number };
  qbi?: { rate: number; threshold: Record<FilingStatus, number> };
  niit?: { rate: number; threshold: Record<FilingStatus, number> };
  ctc?: {
    perQualifyingChild: number;
    perOtherDependent: number;
    phaseoutStart: Record<FilingStatus, number>;
    phaseoutStep: number;
    phaseoutAmountPerStep: number;
    maxRefundablePerChild: number;
  };
  eitc?: {
    investmentIncomeLimit: number;
    table: Record<
      `${FilingStatus}_${0 | 1 | 2 | 3}`,
      { phaseInRate: number; maxCredit: number; phaseOutStart: number; phaseOutRate: number }
    >;
  };
};

const IRS_BASE = "https://www.irs.gov/pub/irs-drop/";

/**
 * Manual mapping:
 * Revenue Procedure YYYY-XX -> Tax Year following year
 * Example: rp-24-40 -> tax year 2026
 */
const REVENUE_PROCEDURE_MAP: Record<number, string> = {
  2026: "rp-24-40",
  // 2026: "rp-25-xx",
};

function parseDollar(v: string) {
  return Number(v.replace(/[$,]/g, ""));
}

function assert(cond: any, msg: string) {
  if (!cond) throw new Error(msg);
}

const RATE_REGEX = /(\d+)%/;
const DOLLAR_REGEX = /\$[\d,]+/g;

async function fetchRevenueProcedure(year: number) {
  const rp = REVENUE_PROCEDURE_MAP[year];
  assert(rp, `No Revenue Procedure mapping for tax year ${year}`);
  const url = `${IRS_BASE}${rp}.html`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch IRS doc (${res.status})`);

  return { html: await res.text(), rp };
}

/**
 * Extremely defensive parsing.
 */
function extractStandardDeduction(html: string) {
  const matches = html.match(/\$[\d,]{4,}/g) || [];

  // Known order in Rev Proc:
  // Single/MFS, MFJ, HOH
  const values = matches
    .map(parseDollar)
    .filter((v) => v > 10000 && v < 60000);

  assert(values.length >= 3, "Failed to parse standard deduction");

  return {
    single: values[0],
    mfs: values[0],
    mfj: values[1],
    hoh: values[2],
  };
}

function extractBrackets(html: string, status: FilingStatus): Bracket[] {
  const statusLabel =
    status === "single"
      ? "Single"
      : status === "mfj"
      ? "Married Filing Jointly"
      : status === "hoh"
      ? "Head of Household"
      : "Married Filing Separately";

  const tableRegex = new RegExp(`Table\\s+\\d+.*?${statusLabel}`, "is");
  const tableMatch = html.match(tableRegex);
  assert(tableMatch, `Failed to locate table for ${status}`);

  const block = tableMatch[0];
  const lines = block.split("\n").map((l) => l.trim());

  const brackets: Bracket[] = [];

  for (const line of lines) {
    // IRS table lines usually contain "over"
    if (!line.toLowerCase().includes("over")) continue;

    const dollars = line.match(DOLLAR_REGEX);
    const rateMatch = line.match(RATE_REGEX);
    if (!rateMatch) continue;

    const rate = Number(rateMatch[1]) / 100;

    if (!dollars || dollars.length === 0) {
      // Top bracket
      brackets.push({ upTo: null, rate });
      continue;
    }

    const upTo = parseDollar(dollars[dollars.length - 1]);
    brackets.push({ upTo, rate });
  }

  assert(brackets.length >= 6, `Unexpected bracket count for ${status}`);
  return brackets;
}

/**
 * Premium constants template:
 * scripts/templates/federal_premium_<year>.json
 */
function loadPremiumTemplate(year: number): FederalPremiumJson {
  const tplPath = path.join("scripts", "templates", `federal_premium_${year}.json`);
  if (!fs.existsSync(tplPath)) {
    console.warn(`⚠️ Premium template not found: ${tplPath}`);
    return {};
  }
  const raw = fs.readFileSync(tplPath, "utf8");
  return JSON.parse(raw);
}

/**
 * Merge + normalize into final shape your backend expects.
 */
function mergePremium(out: Omit<FederalJson, "itemized" | "qbi" | "niit" | "ctc" | "eitc">, premium: FederalPremiumJson): FederalJson {
  const itemized = premium.itemized?.saltCap != null ? { saltCap: Number(premium.itemized.saltCap) } : undefined;

  const qbi =
    premium.qbi
      ? {
          rate: Number(premium.qbi.rate ?? 0.2),
          threshold: {
            single: Number(premium.qbi.threshold?.single ?? 0),
            mfj: Number(premium.qbi.threshold?.mfj ?? 0),
            hoh: Number(premium.qbi.threshold?.hoh ?? 0),
            mfs: Number(premium.qbi.threshold?.mfs ?? 0),
          },
        }
      : undefined;

  const niit =
    premium.niit
      ? {
          rate: Number(premium.niit.rate ?? 0.038),
          threshold: {
            single: Number(premium.niit.threshold?.single ?? 0),
            mfj: Number(premium.niit.threshold?.mfj ?? 0),
            hoh: Number(premium.niit.threshold?.hoh ?? 0),
            mfs: Number(premium.niit.threshold?.mfs ?? 0),
          },
        }
      : undefined;

  const ctc =
    premium.ctc
      ? {
          perQualifyingChild: Number(premium.ctc.perQualifyingChild ?? 0),
          perOtherDependent: Number(premium.ctc.perOtherDependent ?? 0),
          phaseoutStart: {
            single: Number(premium.ctc.phaseoutStart?.single ?? 0),
            mfj: Number(premium.ctc.phaseoutStart?.mfj ?? 0),
            hoh: Number(premium.ctc.phaseoutStart?.hoh ?? 0),
            mfs: Number(premium.ctc.phaseoutStart?.mfs ?? 0),
          },
          phaseoutStep: Number(premium.ctc.phaseoutStep ?? 1000),
          phaseoutAmountPerStep: Number(premium.ctc.phaseoutAmountPerStep ?? 50),
          maxRefundablePerChild: Number(premium.ctc.maxRefundablePerChild ?? 0),
        }
      : undefined;

  const eitc =
    premium.eitc
      ? {
          investmentIncomeLimit: Number(premium.eitc.investmentIncomeLimit ?? 0),
          table: (premium.eitc.table ?? {}) as any,
        }
      : undefined;

  return {
    ...out,
    ...(itemized ? { itemized } : {}),
    ...(qbi ? { qbi } : {}),
    ...(niit ? { niit } : {}),
    ...(ctc ? { ctc } : {}),
    ...(eitc ? { eitc } : {}),
  };
}

async function run() {
  const year = Number(process.argv[2]);
  if (!year) throw new Error("Usage: ts-node updateFederalBrackets.ts <taxYear>");

  console.log(`Fetching IRS Revenue Procedure for ${year}…`);
  const { html, rp } = await fetchRevenueProcedure(year);

  console.log("Parsing standard deduction…");
  const standardDeduction = extractStandardDeduction(html);

  console.log("Parsing brackets…");
  const brackets: FederalJson["brackets"] = {
    single: extractBrackets(html, "single"),
    mfj: extractBrackets(html, "mfj"),
    hoh: extractBrackets(html, "hoh"),
    mfs: extractBrackets(html, "mfs"),
  };

  const baseOut = {
    taxYear: year,
    source: `IRS Revenue Procedure ${rp.toUpperCase()}`,
    standardDeduction,
    brackets,
  };

  console.log("Loading premium template…");
  const premium = loadPremiumTemplate(year);

  const out = mergePremium(baseOut, premium);

  const outDir = path.join("src", "data", "federal");
  fs.mkdirSync(outDir, { recursive: true });

  const outPath = path.join(outDir, `${year}.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

  console.log(`✅ Federal tax data written to ${outPath}`);
}

run().catch((e) => {
  console.error("❌ Failed to update federal tax data");
  console.error(e);
  process.exit(1);
});
