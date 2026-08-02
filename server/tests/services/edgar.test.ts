import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMockSec } from "../mocks/mockSec.js";
import type { MockSec } from "../mocks/mockSec.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nomo-edgar-test-"));
process.env.NOMO_DATA_DIR = tempDir;

const CIK = "0000000001";

function annual(fy: number, val: number) {
  return { fy, fp: "FY", form: "10-K", filed: `${fy + 1}-02-01`, val };
}

const FORM4_BUY = `<?xml version="1.0"?>
<ownershipDocument>
  <issuer><issuerTradingSymbol>TEST</issuerTradingSymbol></issuer>
  <reportingOwner>
    <reportingOwnerId><rptOwnerName>Jane Director</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship><isDirector>1</isDirector><isOfficer>1</isOfficer><officerTitle>CEO</officerTitle></reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>2026-07-04</value></transactionDate>
      <transactionCoding><transactionCode>P</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>1000</value></transactionShares>
        <transactionPricePerShare><value>150.25</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>`;

const FORM4_SELL = `<?xml version="1.0"?>
<ownershipDocument>
  <issuer><issuerTradingSymbol>TEST</issuerTradingSymbol></issuer>
  <reportingOwner>
    <reportingOwnerId><rptOwnerName>John Officer</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship><isOfficer>1</isOfficer><officerTitle>CFO</officerTitle></reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>2026-06-29</value></transactionDate>
      <transactionCoding><transactionCode>S</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>500</value></transactionShares>
        <transactionPricePerShare><value>160.00</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>`;

const FIXTURES = {
  tickers: { "0": { cik_str: 1, ticker: "TEST", title: "Test Corp Inc." } },
  companyFacts: {
    [CIK]: {
      entityName: "Test Corp Inc.",
      facts: {
        "us-gaap": {
          Revenues: { units: { USD: [annual(2022, 100), annual(2023, 150)] } },
          NetIncomeLoss: { units: { USD: [annual(2022, 10), annual(2023, 30)] } },
          GrossProfit: { units: { USD: [annual(2023, 90)] } },
          Assets: { units: { USD: [annual(2023, 200)] } },
          Liabilities: { units: { USD: [annual(2023, 80)] } },
          StockholdersEquity: { units: { USD: [annual(2023, 120)] } },
        },
      },
    },
  },
  submissions: {
    [CIK]: {
      name: "Test Corp Inc.",
      filings: {
        recent: {
          accessionNumber: ["0000000001-26-000010", "0000000001-26-000011", "0000000001-26-000001", "0000000001-26-000002"],
          filingDate: ["2026-07-20", "2026-07-10", "2026-07-05", "2026-06-30"],
          reportDate: ["2026-07-19", "2026-06-30", "2026-07-04", "2026-06-29"],
          form: ["8-K", "10-Q", "4", "4"],
          items: ["2.02,9.01", "", "", ""],
          primaryDocument: ["a8k.htm", "aform10q.htm", "form4.xml", "form4.xml"],
        },
      },
    },
  },
  form4: {
    "/Archives/edgar/data/1/000000000126000001/form4.xml": FORM4_BUY,
    "/Archives/edgar/data/1/000000000126000002/form4.xml": FORM4_SELL,
  },
};

let mock: MockSec;
let cikMap: typeof import("../../src/services/edgar/cikMap.js");
let companyFacts: typeof import("../../src/services/edgar/companyFacts.js");
let filings: typeof import("../../src/services/edgar/filings.js");
let insiders: typeof import("../../src/services/edgar/insiders.js");

before(async () => {
  mock = await startMockSec(FIXTURES);
  process.env.SEC_DATA_BASE_URL = mock.url;
  process.env.SEC_WWW_BASE_URL = mock.url;
  const db = await import("../../src/db/index.js");
  db.initDatabase();
  cikMap = await import("../../src/services/edgar/cikMap.js");
  companyFacts = await import("../../src/services/edgar/companyFacts.js");
  filings = await import("../../src/services/edgar/filings.js");
  insiders = await import("../../src/services/edgar/insiders.js");
});

after(async () => {
  await mock.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("resolves a ticker to its zero-padded CIK", async () => {
  const id = await cikMap.resolveCik("test");
  assert.equal(id.cik, "0000000001");
  assert.equal(id.ticker, "TEST");
});

test("computes deterministic ratios and trends from company facts", async () => {
  const f = await companyFacts.getCompanyFacts("TEST");
  assert.deepEqual(f.fiscalYears, [2022, 2023]);
  assert.deepEqual(f.series.revenue, [100, 150]);
  assert.deepEqual(f.series.assets, [null, 200]);
  assert.equal(f.metrics.revenueGrowthYoYPct, 50);
  assert.equal(f.metrics.netMarginPct, 20);
  assert.equal(f.metrics.grossMarginPct, 60);
  assert.equal(f.metrics.debtToEquity, 0.67);
  assert.equal(f.metrics.liabilitiesToAssets, 0.4);
  assert.deepEqual(f.metrics.netMarginTrendPct, [10, 20]);
});

test("company facts are served from cache on the second call", async () => {
  const factsPath = `/api/xbrl/companyfacts/CIK${CIK}.json`;
  await companyFacts.getCompanyFacts("TEST");
  const hitsBefore = mock.requests.filter((r) => r === factsPath).length;
  await companyFacts.getCompanyFacts("TEST");
  const hitsAfter = mock.requests.filter((r) => r === factsPath).length;
  assert.equal(hitsAfter, hitsBefore, "no new network request within the TTL");
});

test("recent filings flag 8-K material events and filter by form", async () => {
  const all = await filings.getRecentFilings("TEST", { days: 100000 });
  const eightK = all.filings.find((f) => f.form === "8-K");
  assert.ok(eightK);
  assert.equal(eightK?.material, true);
  assert.deepEqual(
    eightK?.items?.map((i) => i.code),
    ["2.02", "9.01"],
  );
  assert.match(eightK?.items?.[0]?.label ?? "", /earnings/i);

  const only8k = await filings.getRecentFilings("TEST", { forms: ["8-K"], days: 100000 });
  assert.ok(only8k.filings.every((f) => f.form === "8-K"));
});

test("insider trades parse Form 4 into buys and sells, newest first", async () => {
  const result = await insiders.getInsiderTrades("TEST", { days: 100000 });
  assert.equal(result.trades.length, 2);
  const [buy, sell] = result.trades;
  assert.equal(buy?.side, "buy");
  assert.equal(buy?.insider, "Jane Director");
  assert.match(buy?.role ?? "", /Director/);
  assert.match(buy?.role ?? "", /CEO/);
  assert.equal(buy?.shares, 1000);
  assert.equal(buy?.price, 150.25);
  assert.equal(sell?.side, "sell");
  assert.equal(sell?.shares, 500);
});

test("parseForm4 pulls the owner, role, and transaction", () => {
  const parsed = insiders.parseForm4(FORM4_BUY);
  assert.equal(parsed?.insider, "Jane Director");
  assert.equal(parsed?.transactions[0]?.transactionCode, "P");
  assert.equal(parsed?.transactions[0]?.side, "buy");
});
