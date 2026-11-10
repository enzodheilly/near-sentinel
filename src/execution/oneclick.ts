/**
 * 1Click API client (NEAR Intents), the only module that talks to https://1click.chaindefuser.com.
 * Reference: .agents/skills/near-intents (api-tokens, api-quote, api-status) and the public API reference for
 * POST /v0/submit-intent.
 *
 * - Every response is parsed with Zod. Anything unexpected becomes a OneClickError with a kind and the start of
 *   the body: never an untyped value, never a silent fallback.
 * - Amounts stay strings of digits on the wire and become bigint in our Quote.
 * - The partner key goes in `X-API-Key` when present (without it, 1Click adds 0.25% to the fee).
 * - A User-Agent is always sent: Cloudflare in front of 1Click refuses some default client agents (error 1010).
 *
 * INTENTS mode (live, #47): quote (dry: false) → generate-intent with the quote's depositAddress → sign the
 * returned NEP-413 payload → submit-intent → poll status. Schemas from /docs/v0/openapi.yaml.
 */

import { z } from "zod";
import type { Quote } from "../types.ts";

export const ONECLICK_BASE = "https://1click.chaindefuser.com";
export const USER_AGENT = "near-sentinel/0.1 (+https://github.com/enzodheilly/near-sentinel)";

export type OneClickErrorKind = "network" | "timeout" | "auth" | "http" | "schema";

export class OneClickError extends Error {
  readonly kind: OneClickErrorKind;
  readonly status: number | undefined;
  readonly endpoint: string;
  constructor(kind: OneClickErrorKind, endpoint: string, message: string, status?: number) {
    super(`1Click ${endpoint}: ${message}`);
    this.kind = kind;
    this.endpoint = endpoint;
    this.status = status;
  }
}

// ---------------------------------------------------------------- schemas
const digits = z.string().regex(/^\d+$/, "an integer amount in base units");
const numeric = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?(e-?\d+)?$/i)]).transform(Number);

export const tokenSchema = z.object({
  assetId: z.string().min(1),
  decimals: z.number().int().min(0).max(36),
  blockchain: z.string(),
  symbol: z.string(),
  price: numeric,
  priceUpdatedAt: z.string(),
  contractAddress: z.string().nullish(),
});
export type OneClickToken = z.infer<typeof tokenSchema>;

export const quoteResponseSchema = z.object({
  correlationId: z.string().optional(),
  timestamp: z.string(),
  signature: z.string().optional(),
  quoteRequest: z.record(z.string(), z.unknown()),
  quote: z.object({
    depositAddress: z.string().optional(),
    depositMemo: z.string().nullish(),
    amountIn: digits,
    amountInFormatted: z.string(),
    amountInUsd: z.string().optional(),
    minAmountIn: digits.optional(),
    maxAmountIn: digits.optional(),
    amountOut: digits,
    amountOutFormatted: z.string(),
    amountOutUsd: z.string().optional(),
    minAmountOut: digits.optional(),
    deadline: z.string().optional(),
    timeWhenInactive: z.string().optional(),
    timeEstimate: z.number().optional(),
  }),
});
export type QuoteResponse = z.infer<typeof quoteResponseSchema>;

export const STATUSES = ["PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX", "PROCESSING", "SUCCESS", "INCOMPLETE_DEPOSIT", "REFUNDED", "FAILED"] as const;
export const TERMINAL: ReadonlySet<(typeof STATUSES)[number]> = new Set(["SUCCESS", "INCOMPLETE_DEPOSIT", "REFUNDED", "FAILED"]);
const txHash = z.object({ hash: z.string(), explorerUrl: z.string().optional() });

export const statusResponseSchema = z.object({
  correlationId: z.string().optional(),
  status: z.enum(STATUSES),
  updatedAt: z.string(),
  swapDetails: z
    .object({
      amountIn: digits.nullish(),
      amountInFormatted: z.string().nullish(),
      amountOut: digits.nullish(),
      amountOutFormatted: z.string().nullish(),
      slippage: z.number().nullish(),
      originChainTxHashes: z.array(txHash).default([]),
      destinationChainTxHashes: z.array(txHash).default([]),
      refundedAmount: z.string().nullish(),
      refundReason: z.string().nullish(),
      depositedAmount: z.string().nullish(),
    })
    .optional(),
});
export type StatusResponse = z.infer<typeof statusResponseSchema>;

/** The unsigned NEP-413 payload 1Click prepares for a swap_transfer (MultiPayloadNarrowed, nep413 variant). */
export const generateIntentResponseSchema = z.object({
  intent: z.object({
    standard: z.literal("nep413"),
    payload: z.object({ message: z.string().min(2), nonce: z.string().min(1), recipient: z.string().min(1), callbackUrl: z.string().nullish() }),
  }),
  correlationId: z.string(),
});
export type GenerateIntentResponse = z.infer<typeof generateIntentResponseSchema>;

export const submitIntentResponseSchema = z.object({ intentHash: z.string().min(1), correlationId: z.string() });
export type SubmitIntentResponse = z.infer<typeof submitIntentResponseSchema>;

/** A NEP-413 signed payload, as accepted by POST /v0/submit-intent. */
export interface Nep413Signed {
  readonly standard: "nep413";
  readonly payload: { readonly message: string; readonly nonce: string; readonly recipient: string; readonly callbackUrl?: string | null };
  readonly public_key: `ed25519:${string}`;
  readonly signature: `ed25519:${string}`;
}

export interface QuoteRequest {
  readonly dry: boolean;
  readonly swapType: "EXACT_INPUT";
  readonly slippageTolerance: number; // bps
  readonly originAsset: string;
  readonly destinationAsset: string;
  readonly amount: string; // base units
  readonly depositType: "INTENTS";
  readonly recipient: string;
  readonly recipientType: "INTENTS";
  readonly refundTo: string;
  readonly refundType: "INTENTS";
  readonly deadline: string; // ISO
  readonly quoteWaitingTimeMs?: number;
  readonly referral?: string;
}

// ---------------------------------------------------------------- client
export interface OneClickOptions {
  readonly baseUrl?: string;
  /** Partner key (ONECLICK_JWT). */
  readonly jwt?: string | undefined;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly clock?: () => number;
}

export class OneClickClient {
  private readonly base: string;
  private readonly jwt: string | undefined;
  private readonly f: typeof fetch;
  private readonly timeoutMs: number;
  private readonly clock: () => number;

  constructor(o: OneClickOptions = {}) {
    this.base = (o.baseUrl ?? ONECLICK_BASE).replace(/\/$/, "");
    this.jwt = o.jwt || undefined;
    this.f = o.fetch ?? fetch;
    this.timeoutMs = o.timeoutMs ?? 10_000;
    this.clock = o.clock ?? Date.now;
  }

  get authenticated(): boolean {
    return this.jwt !== undefined;
  }

  tokens(): Promise<OneClickToken[]> {
    return this.call("GET /v0/tokens", "/v0/tokens", undefined, z.array(tokenSchema));
  }

  quote(req: QuoteRequest): Promise<QuoteResponse> {
    return this.call("POST /v0/quote", "/v0/quote", req, quoteResponseSchema);
  }

  status(depositAddress: string, depositMemo?: string): Promise<StatusResponse> {
    const q = new URLSearchParams({ depositAddress, ...(depositMemo ? { depositMemo } : {}) });
    return this.call("GET /v0/status", `/v0/status?${q}`, undefined, statusResponseSchema);
  }

  /** Prepares the intent that moves the quoted input to the quote's depositAddress (INTENTS mode). */
  generateIntent(depositAddress: string, signerId: string): Promise<GenerateIntentResponse> {
    return this.call("POST /v0/generate-intent", "/v0/generate-intent", { type: "swap_transfer", standard: "nep413", signerId, depositAddress }, generateIntentResponseSchema);
  }

  submitIntent(signedData: Nep413Signed): Promise<SubmitIntentResponse> {
    return this.call("POST /v0/submit-intent", "/v0/submit-intent", { type: "swap_transfer", signedData }, submitIntentResponseSchema);
  }

  /** Our Quote, from a validated response: bigint amounts, the exact payload kept for the record. */
  toQuote(r: QuoteResponse, req: QuoteRequest, receivedAt = this.clock()): Quote {
    return {
      originAsset: req.originAsset,
      destinationAsset: req.destinationAsset,
      amountIn: BigInt(r.quote.amountIn),
      amountOut: BigInt(r.quote.amountOut),
      minAmountOut: BigInt(r.quote.minAmountOut ?? r.quote.amountOut),
      ...(r.quote.depositAddress ? { depositAddress: r.quote.depositAddress } : {}),
      deadline: r.quote.deadline ?? req.deadline,
      receivedAt,
      raw: r,
    };
  }

  private async call<T>(endpoint: string, path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    let res: Response;
    try {
      res = await this.f(`${this.base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          accept: "application/json",
          "user-agent": USER_AGENT,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(this.jwt ? { "x-api-key": this.jwt } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      throw new OneClickError(timeout ? "timeout" : "network", endpoint, timeout ? `no answer within ${this.timeoutMs} ms` : e instanceof Error ? e.message : String(e));
    }
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      const cf = /error code: 10\d\d/.test(text) ? " (Cloudflare refused the client)" : "";
      throw new OneClickError("auth", endpoint, `HTTP ${res.status}${cf}: ${excerpt(text)}`, res.status);
    }
    if (!res.ok) throw new OneClickError("http", endpoint, `HTTP ${res.status}: ${excerpt(text)}`, res.status);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new OneClickError("schema", endpoint, `answer is not JSON: ${excerpt(text)}`, res.status);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new OneClickError("schema", endpoint, `unexpected answer at ${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "invalid"}`, res.status);
    }
    return parsed.data;
  }
}

const excerpt = (s: string) => (s.length > 160 ? `${s.slice(0, 160)}…` : s);
