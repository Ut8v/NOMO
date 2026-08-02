import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Mock SEC EDGAR host for tests. One server stands in for both data.sec.gov and
 * www.sec.gov (the paths do not overlap). It records every request path so
 * tests can assert cache-first behavior.
 */

export interface SecFixtures {
  /** company_tickers.json body: index -> { cik_str, ticker, title }. */
  tickers: Record<string, { cik_str: number; ticker: string; title: string }>;
  /** Keyed by zero-padded 10-digit CIK. */
  companyFacts: Record<string, unknown>;
  submissions: Record<string, unknown>;
  /** Keyed by exact archive path, value is the Form 4 XML. */
  form4: Record<string, string>;
}

export interface MockSec {
  url: string;
  requests: string[];
  close: () => Promise<void>;
}

export async function startMockSec(fixtures: SecFixtures): Promise<MockSec> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    const path = req.url ?? "";
    requests.push(path);

    const json = (body: unknown) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const notFound = () => {
      res.writeHead(404).end("not found");
    };

    if (path === "/files/company_tickers.json") return json(fixtures.tickers);

    const facts = path.match(/^\/api\/xbrl\/companyfacts\/CIK(\d{10})\.json$/);
    if (facts) {
      const body = fixtures.companyFacts[facts[1]!];
      return body ? json(body) : notFound();
    }

    const subs = path.match(/^\/submissions\/CIK(\d{10})\.json$/);
    if (subs) {
      const body = fixtures.submissions[subs[1]!];
      return body ? json(body) : notFound();
    }

    if (path.startsWith("/Archives/")) {
      const xml = fixtures.form4[path];
      if (!xml) return notFound();
      res.writeHead(200, { "Content-Type": "text/xml" });
      return res.end(xml);
    }

    return notFound();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
