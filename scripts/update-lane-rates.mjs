#!/usr/bin/env node
/**
 * Abby Transport Freight Calculator — weekly lane-rate updater
 *
 * What this does:
 * 1. Tries to read current public market-rate pages and/or an optional paid/API endpoint.
 * 2. Computes a revised all-in flatbed $/mile matrix using your existing regional model.
 * 3. Rewrites the constants inside index.html:
 *    - DEFAULT_COST_PER_MILE
 *    - REGION_RATES
 *    - the visible Cost Per Mile input default value
 * 4. Writes data/lane-rates.json and data/lane-rates-history.json for auditability.
 *
 * Important: public websites can change their HTML at any moment, because apparently
 * civilization was built on brittle markup and wishful thinking. If parsing fails, this
 * script keeps the current rates instead of corrupting the calculator.
 */

import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const INDEX_PATH = path.join(ROOT, "index.html");
const DATA_DIR = path.join(ROOT, "data");
const RATE_JSON_PATH = path.join(DATA_DIR, "lane-rates.json");
const HISTORY_JSON_PATH = path.join(DATA_DIR, "lane-rates-history.json");

const REGION_CODES = ["NOR", "SOU", "MID", "SPL", "TEX", "MTN", "SWE", "NWE"];
const BASE_NATIONAL_AVERAGE = 2.70;

const BASE_REGION_RATES = {
  NOR: { NOR: 2.75, SOU: 2.90, MID: 2.95, SPL: 3.05, TEX: 3.10, MTN: 3.15, SWE: 3.20, NWE: 3.25 },
  SOU: { NOR: 2.85, SOU: 2.70, MID: 2.80, SPL: 2.85, TEX: 2.75, MTN: 3.00, SWE: 3.05, NWE: 3.15 },
  MID: { NOR: 3.00, SOU: 2.90, MID: 2.80, SPL: 2.70, TEX: 2.85, MTN: 2.90, SWE: 3.00, NWE: 3.05 },
  SPL: { NOR: 3.00, SOU: 2.75, MID: 2.65, SPL: 2.55, TEX: 2.60, MTN: 2.70, SWE: 2.80, NWE: 2.90 },
  TEX: { NOR: 3.05, SOU: 2.65, MID: 2.70, SPL: 2.55, TEX: 2.45, MTN: 2.70, SWE: 2.65, NWE: 2.90 },
  MTN: { NOR: 3.10, SOU: 2.90, MID: 2.75, SPL: 2.65, TEX: 2.70, MTN: 2.45, SWE: 2.55, NWE: 2.55 },
  SWE: { NOR: 3.15, SOU: 3.00, MID: 2.85, SPL: 2.75, TEX: 2.65, MTN: 2.55, SWE: 2.40, NWE: 2.60 },
  NWE: { NOR: 3.25, SOU: 3.10, MID: 2.95, SPL: 2.90, TEX: 2.90, MTN: 2.60, SWE: 2.65, NWE: 2.50 },
};

const DEFAULT_PUBLIC_SOURCES = [
  {
    name: "DAT Trendlines",
    url: "https://www.dat.com/trendlines",
    weight: 3.0,
  },
  {
    name: "Scale Funding Current Freight Rates",
    url: "https://getscalefunding.com/resources/current-freight-rates/",
    weight: 2.5,
  },
];

function round2(value) {
  return Number(Number(value).toFixed(2));
}

function isUsableRate(value) {
  return Number.isFinite(value) && value >= 1.5 && value <= 8;
}

function htmlToText(html) {
  return String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#36;/g, "$" )
    .replace(/\s+/g, " ")
    .trim();
}

function firstRate(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const value = Number.parseFloat(String(match[1]).replace(/,/g, ""));
    if (isUsableRate(value)) return value;
  }
  return null;
}

function parsePublicFreightRates(html, sourceName, url, weight = 1) {
  const text = htmlToText(html);

  const national = firstRate(text, [
    /national\s+average\s+flatbed\s+rates?\s+(?:are|is|at|averaged?)\s+\$\s*([0-9]+(?:\.[0-9]+)?)/i,
    /flatbed\s+freight\s+rates?[^$]{0,180}national\s+average[^$]{0,80}\$\s*([0-9]+(?:\.[0-9]+)?)/i,
    /flatbed\s*[:\-]\s*\$\s*([0-9]+(?:\.[0-9]+)?)\s*(?:per\s+mile|\/mi|a\s+mile)/i,
    /national\s+flatbed\s+(?:spot\s+)?(?:rate|rates|average)[^$]{0,100}\$\s*([0-9]+(?:\.[0-9]+)?)/i,
    /flatbed\s+spot\s+rates?[^.]{0,160}(?:national\s+averages?\s+)?(?:exceeding|above|around|at)\s+\$\s*([0-9]+(?:\.[0-9]+)?)/i,
  ]);

  const midwest = firstRate(text, [
    /Midwest[^$]{0,120}\$\s*([0-9]+(?:\.[0-9]+)?)/i,
  ]);

  const west = firstRate(text, [
    /lowest\s+rates?\s+are\s+in\s+the\s+West[^$]{0,120}\$\s*([0-9]+(?:\.[0-9]+)?)/i,
    /West\s+flatbed[^$]{0,120}\$\s*([0-9]+(?:\.[0-9]+)?)/i,
    /West[^$]{0,80}\$\s*([0-9]+(?:\.[0-9]+)?)/i,
  ]);

  const found = { national, midwest, west };
  const hasAny = Object.values(found).some(v => isUsableRate(v));
  if (!hasAny) return null;

  return {
    source: sourceName,
    url,
    weight,
    foundAt: new Date().toISOString(),
    rates: found,
  };
}

async function fetchText(url, headers = {}) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "AbbyTransportRateUpdater/1.0 (+https://www.abbytransport.com)",
      "accept": "text/html,application/json;q=0.9,*/*;q=0.8",
      ...headers,
    },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.text();
}

function normalizeApiResponse(json, sourceName = "DAT/API") {
  const body = json?.flatbed ?? json?.rates?.flatbed ?? json?.rates ?? json;
  const directMatrix = json?.regionRates ?? body?.regionRates;
  const national = Number.parseFloat(
    body?.nationalAverage ?? body?.national ?? body?.spotRate ?? body?.allInRate ?? body?.rate ?? body?.flatbed ?? body?.defaultCostPerMile
  );

  const midwest = Number.parseFloat(body?.midwest ?? body?.MID ?? body?.regions?.midwest ?? body?.regions?.MID);
  const west = Number.parseFloat(body?.west ?? body?.WEST ?? body?.regions?.west ?? body?.regions?.WEST);

  if (directMatrix && isUsableRate(national)) {
    return {
      source: sourceName,
      url: process.env.DAT_API_URL || "configured API",
      weight: 10,
      foundAt: new Date().toISOString(),
      rates: { national, midwest: isUsableRate(midwest) ? midwest : null, west: isUsableRate(west) ? west : null },
      directMatrix,
    };
  }

  if (!isUsableRate(national) && !isUsableRate(midwest) && !isUsableRate(west)) return null;

  return {
    source: sourceName,
    url: process.env.DAT_API_URL || "configured API",
    weight: 10,
    foundAt: new Date().toISOString(),
    rates: {
      national: isUsableRate(national) ? national : null,
      midwest: isUsableRate(midwest) ? midwest : null,
      west: isUsableRate(west) ? west : null,
    },
  };
}

async function tryPaidApiSource() {
  const apiUrl = process.env.DAT_API_URL;
  const apiKey = process.env.DAT_API_KEY;
  if (!apiUrl || !apiKey) return null;

  const response = await fetch(apiUrl, {
    headers: {
      "accept": "application/json",
      "authorization": `Bearer ${apiKey}`,
      "x-api-key": apiKey,
    },
  });

  if (!response.ok) throw new Error(`DAT/API failed: ${response.status} ${response.statusText}`);
  const json = await response.json();
  return normalizeApiResponse(json, "DAT/API");
}

async function collectSources() {
  const sources = [];
  const failures = [];

  try {
    const api = await tryPaidApiSource();
    if (api) sources.push(api);
  } catch (error) {
    failures.push({ source: "DAT/API", error: error.message });
  }

  const extraUrls = (process.env.EXTRA_RATE_SOURCE_URLS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .map((url, i) => ({ name: `Extra public source ${i + 1}`, url, weight: 1.0 }));

  for (const source of [...DEFAULT_PUBLIC_SOURCES, ...extraUrls]) {
    try {
      const html = await fetchText(source.url);
      const parsed = parsePublicFreightRates(html, source.name, source.url, source.weight);
      if (parsed) sources.push(parsed);
      else failures.push({ source: source.name, error: "No parseable flatbed rates found" });
    } catch (error) {
      failures.push({ source: source.name, error: error.message });
    }
  }

  return { sources, failures };
}

function weightedAverage(items, key) {
  let numerator = 0;
  let denominator = 0;

  for (const item of items) {
    const value = item.rates?.[key];
    const weight = item.weight || 1;
    if (!isUsableRate(value)) continue;
    numerator += value * weight;
    denominator += weight;
  }

  return denominator ? round2(numerator / denominator) : null;
}

async function readExistingData() {
  try {
    const raw = await fs.readFile(RATE_JSON_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function buildRegionFactors(rates) {
  const national = rates.national;
  const factors = Object.fromEntries(REGION_CODES.map(code => [code, 1]));

  if (isUsableRate(rates.midwest) && isUsableRate(national)) {
    const midwestFactor = rates.midwest / national;
    factors.MID = midwestFactor;
    factors.SPL = 1 + (midwestFactor - 1) * 0.45;
  }

  if (isUsableRate(rates.west) && isUsableRate(national)) {
    const westFactor = rates.west / national;
    factors.SWE = westFactor;
    factors.NWE = westFactor;
    factors.MTN = 1 + (westFactor - 1) * 0.40;
  }

  return factors;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function generateRegionRates(rates) {
  if (rates.directMatrix) return rates.directMatrix;

  const national = rates.national;
  const nationalScale = national / BASE_NATIONAL_AVERAGE;
  const regionFactors = buildRegionFactors(rates);
  const anchorStrength = 0.35;

  const output = {};
  for (const origin of REGION_CODES) {
    output[origin] = {};
    for (const destination of REGION_CODES) {
      const baseRate = BASE_REGION_RATES[origin][destination];
      const rawRegionFactor = Math.sqrt(regionFactors[origin] * regionFactors[destination]);
      const blendedFactor = 1 + (rawRegionFactor - 1) * anchorStrength;
      const adjusted = baseRate * nationalScale * blendedFactor;

      // Broad sanity bounds so one bad public-source parse does not create cartoon economics.
      output[origin][destination] = round2(clamp(adjusted, national * 0.72, national * 1.42));
    }
  }

  return output;
}

function formatRegionRatesForIndex(regionRates) {
  const lines = ["{", "    // NOR SOU MID SPL TEX MTN SWE NWE"];
  for (const origin of REGION_CODES) {
    const pairs = REGION_CODES
      .map(destination => `${destination}:${Number(regionRates[origin][destination]).toFixed(2)}`)
      .join(", ");
    lines.push(`    ${origin}: { ${pairs} },`);
  }
  lines.push("  }");
  return lines.join("\n");
}

function findMatchingBrace(source, openIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = openIndex; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];

    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "/" && next === "/") {
      lineComment = true;
      i++;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      i++;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth++;
    if (char === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }

  throw new Error("Could not find matching brace for REGION_RATES object.");
}

function replaceObjectLiteral(source, propertyName, replacementObjectLiteral) {
  const propertyIndex = source.indexOf(`${propertyName}:`);
  if (propertyIndex < 0) throw new Error(`Could not find ${propertyName}: in index.html`);

  const openIndex = source.indexOf("{", propertyIndex);
  if (openIndex < 0) throw new Error(`Could not find opening brace for ${propertyName}.`);

  const closeIndex = findMatchingBrace(source, openIndex);
  return source.slice(0, propertyIndex) + `${propertyName}: ${replacementObjectLiteral}` + source.slice(closeIndex + 1);
}

function patchIndexHtml(original, defaultCostPerMile, regionRates, metadata) {
  let html = original;

  html = html.replace(
    /(\*\s*Calibration:\s*)[^\n\r]*/,
    `$1Auto-updated weekly via GitHub Actions`
  );

  html = html.replace(
    /(\*\s*Source:\s*)[^\n\r]*/,
    `$1${metadata.sourceSummary}`
  );

  html = html.replace(
    /DEFAULT_COST_PER_MILE:\s*[0-9]+(?:\.[0-9]+)?\s*,[^\n\r]*/,
    `DEFAULT_COST_PER_MILE: ${defaultCostPerMile.toFixed(2)}, // auto-updated weekly; see data/lane-rates.json`
  );

  html = html.replace(
    /(<input\b[\s\S]{0,300}?id=["']costPerMile["'][\s\S]{0,300}?value=["'])[0-9]+(?:\.[0-9]+)?(["'])/,
    `$1${defaultCostPerMile.toFixed(2)}$2`
  );

  html = replaceObjectLiteral(html, "REGION_RATES", formatRegionRatesForIndex(regionRates));

  return html;
}

function summarizeSources(sources) {
  if (!sources.length) return "Previous lane-rate data retained; no public/API source parsed successfully";
  return sources.map(s => s.source).join(" + ");
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

async function main() {
  const now = new Date().toISOString();
  const existing = await readExistingData();
  const { sources, failures } = await collectSources();

  let national = weightedAverage(sources, "national");
  let midwest = weightedAverage(sources, "midwest");
  let west = weightedAverage(sources, "west");

  // If public pages are not parseable this week, keep the previous known values.
  if (!isUsableRate(national) && existing?.defaultCostPerMile) {
    national = Number(existing.defaultCostPerMile);
  }
  if (!isUsableRate(midwest) && existing?.regionalAnchors?.midwest) {
    midwest = Number(existing.regionalAnchors.midwest);
  }
  if (!isUsableRate(west) && existing?.regionalAnchors?.west) {
    west = Number(existing.regionalAnchors.west);
  }

  if (!isUsableRate(national)) {
    national = BASE_NATIONAL_AVERAGE;
  }

  const directMatrixSource = sources.find(s => s.directMatrix);
  const rates = {
    national: round2(national),
    midwest: isUsableRate(midwest) ? round2(midwest) : null,
    west: isUsableRate(west) ? round2(west) : null,
    directMatrix: directMatrixSource?.directMatrix || null,
  };

  const regionRates = generateRegionRates(rates);
  const indexOriginal = await fs.readFile(INDEX_PATH, "utf8");
  const metadata = { sourceSummary: summarizeSources(sources) };
  const indexUpdated = patchIndexHtml(indexOriginal, rates.national, regionRates, metadata);

  await fs.writeFile(INDEX_PATH, indexUpdated, "utf8");

  const data = {
    updatedAt: now,
    equipment: "flatbed",
    rateType: "estimated all-in spot rate per mile",
    defaultCostPerMile: rates.national,
    regionalAnchors: {
      midwest: rates.midwest,
      west: rates.west,
    },
    regionCodes: {
      NOR: "Northeast",
      SOU: "Southeast",
      MID: "Midwest",
      SPL: "South Plains",
      TEX: "Texas",
      MTN: "Mountain",
      SWE: "Southwest / West",
      NWE: "Northwest / West",
    },
    regionRates,
    methodology: {
      baseNationalAverage: BASE_NATIONAL_AVERAGE,
      note: "The updater scales the existing Abby Transport regional matrix using the newest parseable national flatbed rate. Midwest and West anchors are blended gently when available. This is an estimating model, not a substitute for DAT RateView or another paid lane-level API.",
    },
    sources: sources.map(s => ({
      source: s.source,
      url: s.url,
      weight: s.weight,
      foundAt: s.foundAt,
      rates: s.rates,
    })),
    failures,
  };

  await writeJson(RATE_JSON_PATH, data);

  let history = [];
  try {
    history = JSON.parse(await fs.readFile(HISTORY_JSON_PATH, "utf8"));
    if (!Array.isArray(history)) history = [];
  } catch {
    history = [];
  }

  history.push({
    updatedAt: now,
    defaultCostPerMile: rates.national,
    regionalAnchors: data.regionalAnchors,
    sourceSummary: metadata.sourceSummary,
  });

  history = history.slice(-104); // roughly two years of weekly updates
  await writeJson(HISTORY_JSON_PATH, history);

  console.log(`Updated default flatbed rate: $${rates.national.toFixed(2)}/mi`);
  console.log(`Sources: ${metadata.sourceSummary}`);
  if (failures.length) console.log(`Source failures: ${JSON.stringify(failures)}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
