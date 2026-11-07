/**
 * NEAR AI Cloud client (ARCHITECTURE.md §11), the only module that talks to https://cloud-api.near.ai/v1.
 * Reference: .agents/skills/near-ai-cloud (references/chat-verification.md).
 *
 * The point of this client is the evidence, not the chat:
 * - The request body is serialised ONCE; those exact bytes are sent and hashed. Nothing re-serialises a parsed
 *   object to compute a hash (a key order or whitespace change would break the signed text).
 * - The response is read as raw bytes BEFORE parsing; the hash is computed on those bytes.
 * - `x-no-aliasing: true` keeps the canonical model id (an alias would change what the model TEE signs) and
 *   `Accept-Encoding: identity` keeps the body uncompressed, so the bytes we hash are the bytes that were signed.
 * - Non-streaming only: a streamed body would have to be hashed including its trailing blank lines.
 *
 * Errors are typed (NearAiError, with a kind), never an untyped value: the veto (#34) maps every one of them to
 * the safe fallback.
 */

import { createHash } from "node:crypto";
import { z } from "zod";

export const NEARAI_BASE = "https://cloud-api.near.ai/v1";
export const NEARAI_USER_AGENT = "near-sentinel/0.1 (+https://github.com/enzodheilly/near-sentinel)";

export type NearAiErrorKind = "network" | "timeout" | "auth" | "http" | "schema";

export class NearAiError extends Error {
  readonly kind: NearAiErrorKind;
  readonly status: number | undefined;
  readonly endpoint: string;
  constructor(kind: NearAiErrorKind, endpoint: string, message: string, status?: number) {
    super(`NEAR AI ${endpoint}: ${message}`);
    this.kind = kind;
    this.endpoint = endpoint;
    this.status = status;
  }
}

export const sha256Hex = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

// ---------------------------------------------------------------- schemas
export const completionSchema = z.object({
  id: z.string().min(1),
  model: z.string().optional(),
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullish() }), finish_reason: z.string().nullish() }))
    .min(1),
});
export type Completion = z.infer<typeof completionSchema>;

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface ChatRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly temperature?: number;
  readonly max_tokens?: number;
  readonly response_format?: { readonly type: "json_object" };
  /** Qwen chat templates: thinking off keeps the answer short and parseable. */
  readonly chat_template_kwargs?: { readonly enable_thinking: boolean };
}

/** One completion with the evidence needed to verify it later. */
export interface ChatExchange {
  readonly chatId: string;
  readonly model: string; // the model we asked for (canonical id, never an alias)
  readonly content: string; // assistant message text ("" when the model returned none)
  readonly requestBytes: Uint8Array;
  readonly responseBytes: Uint8Array;
  readonly requestSha256: string;
  readonly responseSha256: string;
  readonly receivedAt: number;
}

// ---------------------------------------------------------------- client
export interface NearAiOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly clock?: () => number;
}

export class NearAiClient {
  private readonly base: string;
  private readonly key: string;
  private readonly f: typeof fetch;
  private readonly timeoutMs: number;
  private readonly clock: () => number;

  constructor(o: NearAiOptions) {
    if (!o.apiKey) throw new NearAiError("auth", "client", "NEARAI_API_KEY is missing");
    this.base = (o.baseUrl ?? NEARAI_BASE).replace(/\/$/, "");
    this.key = o.apiKey;
    this.f = o.fetch ?? fetch;
    this.timeoutMs = o.timeoutMs ?? 10_000;
    this.clock = o.clock ?? Date.now;
  }

  /** POST /chat/completions. The body is serialised here, once; the returned bytes are what was sent. */
  async chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatExchange> {
    const endpoint = "POST /chat/completions";
    const requestBytes = new TextEncoder().encode(JSON.stringify(req));
    const { status, bytes } = await this.raw(endpoint, "/chat/completions", { method: "POST", body: requestBytes, signal });
    const json = parseJson(endpoint, bytes, status);
    const parsed = completionSchema.safeParse(json);
    if (!parsed.success) throw schemaError(endpoint, parsed.error, status);
    return {
      chatId: parsed.data.id,
      model: req.model,
      content: parsed.data.choices[0]!.message.content ?? "",
      requestBytes,
      responseBytes: bytes,
      requestSha256: sha256Hex(requestBytes),
      responseSha256: sha256Hex(bytes),
      receivedAt: this.clock(),
    };
  }

  /** GET returning parsed JSON validated by `schema` (attestation report, signature: #33). */
  async getJson<T>(endpoint: string, path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    const { status, bytes } = await this.raw(endpoint, path, { method: "GET", signal });
    const parsed = schema.safeParse(parseJson(endpoint, bytes, status));
    if (!parsed.success) throw schemaError(endpoint, parsed.error, status);
    return parsed.data;
  }

  private async raw(endpoint: string, path: string, o: { method: "GET" | "POST"; body?: Uint8Array; signal?: AbortSignal | undefined }): Promise<{ status: number; bytes: Uint8Array }> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.f(`${this.base}${path}`, {
        method: o.method,
        headers: {
          authorization: `Bearer ${this.key}`,
          accept: "application/json",
          "user-agent": NEARAI_USER_AGENT,
          "x-no-aliasing": "true",
          "accept-encoding": "identity",
          ...(o.body ? { "content-type": "application/json" } : {}),
        },
        ...(o.body ? { body: o.body } : {}),
        signal,
      });
    } catch (e) {
      const isTimeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      throw new NearAiError(isTimeout ? "timeout" : "network", endpoint, isTimeout ? `no answer within ${this.timeoutMs} ms` : e instanceof Error ? e.message : String(e));
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await res.arrayBuffer()); // raw bytes, before any parsing
    } catch (e) {
      const isTimeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      throw new NearAiError(isTimeout ? "timeout" : "network", endpoint, `body not received: ${e instanceof Error ? e.message : String(e)}`, res.status);
    }
    if (res.status === 401 || res.status === 403) throw new NearAiError("auth", endpoint, `HTTP ${res.status}: ${excerpt(bytes)}`, res.status);
    if (!res.ok) throw new NearAiError("http", endpoint, `HTTP ${res.status}: ${excerpt(bytes)}`, res.status);
    return { status: res.status, bytes };
  }
}

function parseJson(endpoint: string, bytes: Uint8Array, status: number): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new NearAiError("schema", endpoint, `answer is not JSON: ${excerpt(bytes)}`, status);
  }
}

function schemaError(endpoint: string, err: z.ZodError, status: number): NearAiError {
  const issue = err.issues[0];
  return new NearAiError("schema", endpoint, `unexpected answer at ${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "invalid"}`, status);
}

const excerpt = (b: Uint8Array): string => {
  const s = new TextDecoder().decode(b.subarray(0, 200));
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
};
