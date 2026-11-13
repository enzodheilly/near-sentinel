/**
 * `pnpm dashboard`: a local, read-only web page that follows the running agent (http://127.0.0.1:4747).
 *
 * - Listens on 127.0.0.1 only; GET only (anything else is 405); no wallet, no keys used, no action.
 * - /api/state is rebuilt at most every 10 s (files + a few on-chain views); anchors are cached per hash.
 * - The page refreshes itself every 15 s.
 * - /api/proof re-checks the recorded LLM exchange (cached for the server's life: the bytes do not change);
 * - /api/record/<hash> serves a record's exact bytes, for the visitor's browser to hash itself;
 * - /api/candles?tf= serves the NEAR chart at the interval the viewer picks (Hyperliquid NEAR perp, cached 30 s);
 *   the page then follows the forming candle live over Hyperliquid's public WebSocket (the one outside address the
 *   CSP allows, for reading prices only).
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHART_INTERVALS, hyperliquidCandles, HYPERLIQUID_WS, type ChartCandle, type ChartInterval } from "../data/hyperliquid.ts";
import { defaultRiskConfig } from "../config/default.ts";
import { buildPortfolio, type PortfolioMode } from "./portfolio.ts";
import { buildProof } from "./proof.ts";
import { buildDashboardState, type ChainReader, type DashboardState, type DecisionView } from "./state.ts";

export function nearKitReader(): ChainReader {
  const clients = new Map<string, Promise<{ view: <T>(c: string, m: string, a: object) => Promise<T | undefined> }>>();
  const get = (network: "testnet" | "mainnet") => {
    if (!clients.has(network)) clients.set(network, import("near-kit").then(({ Near }) => new Near({ network }) as never));
    return clients.get(network)!;
  };
  // a blocked or offline network must not hang the page: give each view a few seconds, then report it as an error
  const within = <T,>(p: Promise<T>, ms: number) =>
    new Promise<T>((ok, ko) => {
      const t = setTimeout(() => ko(new Error("NEAR RPC did not answer in time")), ms);
      p.then((v) => (clearTimeout(t), ok(v)), (e: unknown) => (clearTimeout(t), ko(e)));
    });
  return { view: async (network, contract, method, args) => within((async () => (await get(network)).view(contract, method, args))(), 6000) };
}

const require_ = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const font = (pkg: string, file: string) => join(dirname(require_.resolve(`${pkg}/package.json`)), "files", file);

/** The only static files served: an exact map, no path from the request ever reaches the file system. */
export const STATIC: Readonly<Record<string, { readonly file: () => string; readonly type: string }>> = {
  "/vendor/three.module.js": { file: () => join(dirname(require_.resolve("three")), "three.module.js"), type: "text/javascript" },
  "/vendor/three.core.js": { file: () => join(dirname(require_.resolve("three")), "three.core.js"), type: "text/javascript" },
  "/vendor/RoomEnvironment.js": { file: () => join(dirname(require_.resolve("three")), "..", "examples", "jsm", "environments", "RoomEnvironment.js"), type: "text/javascript" },
  "/assets/near-logo.png": { file: () => join(here, "assets", "near-logo.png"), type: "image/png" },
  "/fonts/chakra-500.woff2": { file: () => font("@fontsource/chakra-petch", "chakra-petch-latin-500-normal.woff2"), type: "font/woff2" },
  "/fonts/chakra-600.woff2": { file: () => font("@fontsource/chakra-petch", "chakra-petch-latin-600-normal.woff2"), type: "font/woff2" },
  "/fonts/plex-400.woff2": { file: () => font("@fontsource/ibm-plex-sans", "ibm-plex-sans-latin-400-normal.woff2"), type: "font/woff2" },
  "/fonts/plex-500.woff2": { file: () => font("@fontsource/ibm-plex-sans", "ibm-plex-sans-latin-500-normal.woff2"), type: "font/woff2" },
};

export interface DashboardServerOptions {
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
  readonly port?: number;
  readonly chain?: ChainReader;
  readonly clock?: () => number;
  readonly cacheMs?: number;
  /** Records directory and time window, when not the defaults (see BuildOptions). */
  readonly records?: string;
  readonly windowMs?: number;
  /** Chart candles (Hyperliquid NEAR perp by default; tests inject a fake). */
  readonly candles?: (interval: ChartInterval) => Promise<ChartCandle[]>;
}

export async function startDashboard(o: DashboardServerOptions): Promise<{ server: Server; url: string }> {
  const page = await readFile(join(here, "dashboard.html"), "utf8");
  const clock = o.clock ?? Date.now;
  const anchorCache = new Map<string, DecisionView["anchor"]>();
  let cached: { at: number; body: string } | undefined;
  let building: Promise<string> | undefined;
  let proof: Promise<string> | undefined;

  const state = async (): Promise<string> => {
    const now = clock();
    if (cached && now - cached.at < (o.cacheMs ?? 10_000)) return cached.body;
    building ??= buildDashboardState({ root: o.root, env: o.env, ...(o.chain ? { chain: o.chain } : {}), now, anchorCache, ...(o.records ? { records: o.records } : {}), ...(o.windowMs !== undefined ? { windowMs: o.windowMs } : {}) })
      .then((s: DashboardState) => {
        const body = JSON.stringify(s, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
        cached = { at: now, body };
        return body;
      })
      .finally(() => (building = undefined));
    return building;
  };

  // chart candles per interval, cached 30 s (the page asks every 15 s)
  const candleSource = o.candles ?? ((iv: ChartInterval) => hyperliquidCandles("NEAR", iv, 90, Date.now()));
  const candleCache = new Map<string, { at: number; body: string }>();
  const candles = async (iv: ChartInterval): Promise<string> => {
    const now = clock(), hit = candleCache.get(iv);
    if (hit && now - hit.at < 30_000) return hit.body;
    const body = JSON.stringify({ interval: iv, candles: await candleSource(iv) });
    candleCache.set(iv, { at: now, body });
    return body;
  };

  // the portfolio tab, per agent, cached 30 s
  const pfCache = new Map<string, { at: number; body: string }>();
  const portfolio = async (m: PortfolioMode): Promise<string> => {
    const now = clock(), hit = pfCache.get(m);
    if (hit && now - hit.at < 30_000) return hit.body;
    const body = JSON.stringify(await buildPortfolio(o.root, m, defaultRiskConfig));
    pfCache.set(m, { at: now, body });
    return body;
  };

  const server = createServer((req, res) => {
    const headers = {
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' ${HYPERLIQUID_WS}; img-src 'self' data: blob:; font-src 'self'; base-uri 'none'; form-action 'none'`,
    };
    // DNS rebinding: a web page whose domain resolves to 127.0.0.1 would otherwise be same-origin with us
    const host = (req.headers.host ?? "").toLowerCase();
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
      res.writeHead(421, headers).end("unexpected Host header");
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { ...headers, allow: "GET" }).end("read-only");
      return;
    }
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (path === "/") {
      res.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(page);
    } else if (path === "/api/state") {
      state().then(
        (body) => res.writeHead(200, { ...headers, "content-type": "application/json", "cache-control": "no-store" }).end(body),
        (e) => res.writeHead(500, { ...headers, "content-type": "application/json" }).end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) })),
      );
    } else if (path === "/api/portfolio") {
      const m = new URLSearchParams((req.url ?? "").split("?")[1] ?? "").get("mode") ?? "paper";
      if (m !== "paper" && m !== "live" && m !== "demo") {
        res.writeHead(400, { ...headers, "content-type": "application/json" }).end(JSON.stringify({ error: "unknown mode" }));
        return;
      }
      portfolio(m).then(
        (body) => res.writeHead(200, { ...headers, "content-type": "application/json", "cache-control": "no-store" }).end(body),
        (e) => res.writeHead(500, { ...headers, "content-type": "application/json" }).end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) })),
      );
    } else if (path === "/api/proof") {
      proof ??= buildProof(o.root).then((p) => JSON.stringify(p));
      proof.then(
        (body) => res.writeHead(200, { ...headers, "content-type": "application/json", "cache-control": "no-store" }).end(body),
        (e) => res.writeHead(500, { ...headers, "content-type": "application/json" }).end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) })),
      );
    } else if (path.startsWith("/api/record/")) {
      const hash = path.slice("/api/record/".length);
      if (!/^[0-9a-f]{64}$/.test(hash)) {
        res.writeHead(400, headers).end("not a record hash");
        return;
      }
      // the exact bytes on disk, untouched: the point is that the browser hashes what the agent wrote
      readFile(join(o.records ?? join(o.root, "records"), `${hash}.json`)).then(
        (buf) => res.writeHead(200, { ...headers, "content-type": "application/json", "cache-control": "no-store" }).end(buf),
        () => res.writeHead(404, headers).end("no such record"),
      );
    } else if (path === "/api/candles") {
      const iv = new URLSearchParams((req.url ?? "").split("?")[1] ?? "").get("tf") ?? "1h";
      if (!(CHART_INTERVALS as readonly string[]).includes(iv)) {
        res.writeHead(400, { ...headers, "content-type": "application/json" }).end(JSON.stringify({ error: "unknown interval" }));
        return;
      }
      candles(iv as ChartInterval).then(
        (body) => res.writeHead(200, { ...headers, "content-type": "application/json", "cache-control": "no-store" }).end(body),
        (e) => res.writeHead(502, { ...headers, "content-type": "application/json" }).end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) })),
      );
    } else if (path && Object.hasOwn(STATIC, path)) {
      const f = STATIC[path]!;
      readFile(f.file()).then(
        (buf) => res.writeHead(200, { ...headers, "content-type": f.type, "cache-control": "max-age=3600" }).end(buf),
        () => res.writeHead(404, headers).end("not found"),
      );
    } else {
      res.writeHead(404, headers).end("not found");
    }
  });
  const port = o.port ?? 4747;
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const addr = server.address();
  const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : port}`;
  return { server, url };
}
