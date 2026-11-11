/**
 * Shared domain types (ARCHITECTURE.md §5 and §10).
 *
 * Units, used everywhere:
 * - Time: milliseconds since the Unix epoch, UTC.
 * - Prices, indicators, quantities and USD values in the decision layer: `number`, in human units
 *   (1.5 means 1.5 NEAR, not 1.5e24 yoctoNEAR). They must always be finite.
 * - Amounts that touch the chain (quotes, balances, intents): `bigint`, in the asset's smallest unit.
 *   Only the execution layer converts between the two, using the asset's decimals.
 */

// ---------- assets and market data ----------

export const TRADABLE_ASSETS = ["BTC", "NEAR"] as const;
export type TradableAsset = (typeof TRADABLE_ASSETS)[number];

export const QUOTE_ASSET = "USDC" as const;
export type AssetSymbol = TradableAsset | typeof QUOTE_ASSET;

export const INTERVALS = ["1h", "4h"] as const;
export type Interval = (typeof INTERVALS)[number];

export const INTERVAL_MS: Readonly<Record<Interval, number>> = {
  "1h": 3_600_000,
  "4h": 14_400_000,
};

/** One closed candle. `openTime` identifies it; it closes at `openTime + INTERVAL_MS[interval]`. */
export interface Candle {
  readonly openTime: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

/** Points to a contiguous slice of candles without embedding it (used inside decision records). */
export interface CandleWindowRef {
  readonly symbol: string; // market symbol at the data source, e.g. "NEARUSDT"
  readonly interval: Interval;
  readonly firstOpenTime: number;
  readonly lastOpenTime: number;
  readonly count: number;
  readonly sha256: string; // hash of the canonical JSON of the candle array
}

// ---------- signals (RISK_ENGINE.md §3) ----------

export const SIGNAL_KINDS = ["BB_BREAKOUT", "RSI_MOMENTUM", "RSI_EXHAUSTION", "FVG_SUPPORT", "BTC_REGIME"] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

export interface Signal {
  readonly kind: SignalKind;
  readonly asset: TradableAsset;
  readonly barTime: number; // openTime of the evaluated 1h bar
  /** `veto` blocks entries regardless of the other signals. */
  readonly direction: "bullish" | "bearish" | "veto";
  /** Deterministic, in [0, 1]. */
  readonly strength: number;
  /** The raw numbers behind the signal, e.g. { rsi: 63.1 } or { fvgBottom: 3.02, fvgTop: 3.08 }. */
  readonly evidence: Readonly<Record<string, number>>;
}

// ---------- reject reasons (RISK_ENGINE.md §9, kept in sync by a test) ----------

export const REJECT_REASONS = [
  "INSUFFICIENT_CONFLUENCE",
  "VETO_RSI_EXHAUSTION",
  "VETO_BTC_REGIME",
  "POSITION_OPEN",
  "COOLDOWN",
  "STALE_DATA",
  "STOP_TOO_WIDE",
  "BELOW_MIN_NOTIONAL",
  "COST_TOO_HIGH",
  "DAILY_LOSS_LIMIT",
  "MAX_TRADES_PER_DAY",
  "KILL_SWITCH",
  "QUOTE_PRICE_DEVIATION",
  "SLIPPAGE_TOO_HIGH",
  "QUOTE_EXPIRED",
  "INSUFFICIENT_BALANCE",
  "DUPLICATE",
  "POLICY_DENIED",
  "LLM_VETO",
  "EXIT_PENDING",
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

// ---------- proposals ----------

export const EXIT_REASONS = ["STOP", "TAKE_PROFIT_1", "TAKE_PROFIT_2", "TIME_STOP", "KILL_SWITCH"] as const;
export type ExitReason = (typeof EXIT_REASONS)[number];

/** Buy `asset` with USDC. Every entry carries its stop and both targets. */
export interface EntryProposal {
  readonly kind: "ENTRY";
  readonly asset: TradableAsset;
  readonly barTime: number;
  readonly referencePrice: number; // close of the signal bar (P_ref)
  readonly notionalUsd: number;
  readonly quantity: number; // notionalUsd / referencePrice
  readonly stopPrice: number;
  readonly takeProfit: readonly [tp1: number, tp2: number];
  readonly riskUsd: number; // quantity × (referencePrice − stopPrice)
  readonly signals: readonly Signal[];
}

/** Sell (part of) a position back to USDC. Exits never depend on the LLM. */
export interface ExitProposal {
  readonly kind: "EXIT";
  readonly asset: TradableAsset;
  readonly barTime: number;
  readonly reason: ExitReason;
  readonly referencePrice: number;
  readonly quantity: number;
  readonly fraction: number; // share of the open position being sold, in (0, 1]
}

export type TradeProposal = EntryProposal | ExitProposal;

/** Identifies a proposal for idempotency: the same key is never executed twice. */
export function idempotencyKey(p: TradeProposal): string {
  return `${p.asset}:${p.barTime}:${p.kind === "ENTRY" ? "ENTRY" : p.reason}`;
}

// ---------- checks and verdicts ----------

export interface CheckResult {
  readonly name: string; // e.g. "price_sanity", "max_position"
  readonly ok: boolean;
  readonly value?: number; // the measured value, when there is one
  readonly limit?: number; // the threshold it was compared with
  readonly detail?: string;
}

export type RiskVerdict =
  | { readonly ok: true; readonly proposal: TradeProposal; readonly checks: readonly CheckResult[] }
  | { readonly ok: false; readonly reason: RejectReason; readonly checks: readonly CheckResult[] };

// ---------- portfolio ----------

export interface Position {
  readonly asset: TradableAsset;
  readonly quantity: number; // remaining quantity, in human units
  readonly entryPrice: number; // actual fill price (P_fill)
  readonly entryBarTime: number;
  readonly initialStop: number;
  readonly stopPrice: number; // current stop; only ever moves up
  readonly takeProfit: readonly [tp1: number, tp2: number];
  readonly tp1Hit: boolean;
  readonly highestCloseSinceEntry: number;
}

export interface PortfolioSnapshot {
  readonly at: number;
  readonly balances: Readonly<Record<AssetSymbol, number>>; // human units
  readonly positions: readonly Position[];
  readonly equityUsd: number;
  readonly peakEquityUsd: number;
  readonly dayStartEquityUsd: number; // equity at 00:00 UTC of the current day
  readonly entriesToday: number;
  /** Per asset: openTime of the first 1h bar on which a new entry is allowed again. */
  readonly cooldownUntil: Readonly<Partial<Record<TradableAsset, number>>>;
  readonly killSwitch: boolean; // set by the drawdown breaker; only the owner resets it
}

// ---------- execution ----------

export interface Quote {
  readonly originAsset: string; // 1Click asset id
  readonly destinationAsset: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly minAmountOut: bigint;
  readonly depositAddress?: string;
  readonly deadline: string; // ISO 8601
  readonly receivedAt: number; // local clock, for the freshness check
  readonly raw: unknown; // exact API payload, kept for the record
}

export type ExecutionMode = "replay" | "paper" | "live";

/** UNKNOWN: the swap may have been sent and its outcome is not known (no answer, timeout). Never retried blindly. */
export type ExecutionStatus = "SIMULATED" | "QUOTED" | "SUCCESS" | "REFUNDED" | "FAILED" | "UNKNOWN";

export interface ExecutionReport {
  readonly mode: ExecutionMode;
  readonly status: ExecutionStatus;
  readonly quote?: Quote;
  readonly intentHash?: string;
  readonly txRefs: readonly string[];
  /** Filled quantities in human units, when the trade went through (or was simulated). */
  readonly fill?: { readonly quantityIn: number; readonly quantityOut: number; readonly price: number };
  readonly error?: string;
}

export interface Executor {
  readonly mode: ExecutionMode;
  /** Quote for `p` with this slippage tolerance (bps): 50 for entries, 150 for exits, 250 on an exit retry. */
  quote(p: TradeProposal, slippageBps: number): Promise<Quote>;
  execute(p: TradeProposal, q: Quote): Promise<ExecutionReport>;
  balances(): Promise<Readonly<Record<AssetSymbol, bigint>>>;
}

// ---------- LLM veto (RISK_ENGINE.md §8) ----------

export type LlmVerdict = "approve" | "reduce" | "reject";

export const LLM_SIZE_MULTIPLIER: Readonly<Record<LlmVerdict, 1 | 0.5 | 0>> = {
  approve: 1,
  reduce: 0.5,
  reject: 0,
};

export interface LlmReview {
  readonly model: string;
  readonly verdict: LlmVerdict;
  readonly sizeMultiplier: 1 | 0.5 | 0;
  readonly rationale: string;
  /** Set when the verdict comes from the fallback rule (timeout, invalid JSON, API error). */
  readonly fallbackReason?: string;
  readonly chatId?: string;
  readonly requestSha256?: string;
  readonly responseSha256?: string;
  readonly signature?: string;
  readonly signingAddress?: string;
  readonly signatureKind?: "provider_tee" | "gateway";
  /** Outcome of the signature check at decision time (src/decision/llm/attestation.ts). */
  readonly attestation?: { readonly status: "verified" | "unverified" | "invalid"; readonly problems: readonly string[] };
}

// ---------- decision records (ARCHITECTURE.md §10) ----------

export type DecisionOutcome =
  | { readonly action: "TRADE"; readonly proposal: TradeProposal }
  | { readonly action: "REJECT"; readonly reason: RejectReason; readonly proposal?: TradeProposal }
  | { readonly action: "HOLD"; readonly reason: RejectReason | "NO_SIGNAL" };

/**
 * Everything a decision received from outside the engine, in call order, so that `verify` can replay the
 * decision exactly: quotes, the clock at each check, balances, whether a trade key was already executed,
 * and the LLM's raw answer (or its error). Replaying the same calls through the same code must give the
 * same record byte for byte.
 */
export type ExternalCall =
  | { readonly kind: "quote"; readonly slippageBps: number; readonly quote: Quote }
  | { readonly kind: "clock"; readonly now: number }
  | { readonly kind: "balances"; readonly balances: Readonly<Record<AssetSymbol, bigint>> }
  | { readonly kind: "executed"; readonly key: string; readonly value: boolean }
  | { readonly kind: "llm"; readonly review?: LlmReview; readonly error?: string };

export interface Externals {
  readonly authenticated: boolean; // partner JWT present
  readonly policy?: { readonly paused: boolean; readonly maxAmountInUsd: number }; // Tier 2
  readonly calls: readonly ExternalCall[];
}

/** A price observed by the watcher between ticks. */
export interface WatchTrigger {
  readonly kind: "watcher";
  readonly price: number;
  readonly at: number;
}

export interface DecisionRecord {
  readonly version: 1;
  readonly agentVersion: string; // git commit
  readonly configHash: string;
  readonly asset: TradableAsset;
  readonly barTime: number;
  readonly inputs: {
    readonly candles: readonly CandleWindowRef[];
    readonly portfolio: PortfolioSnapshot; // state the decision was taken on (for exits: before this bar's exits)
    readonly now: number; // tick time (clock at the start of the tick)
    readonly externals: Externals;
    /** Set when the price watcher, not a closed bar, triggered this exit (RISK_ENGINE.md §5.6). */
    readonly trigger?: WatchTrigger;
  };
  readonly signals: readonly Signal[];
  readonly checks: readonly CheckResult[];
  readonly llm?: LlmReview;
  readonly outcome: DecisionOutcome;
}
