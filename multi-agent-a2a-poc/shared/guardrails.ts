/**
 * Guardrails implemented as real code (middleware / wrapper functions),
 * not prompt text:
 *
 *   1. validateBody()        — Zod schema on every incoming HTTP body (400 on mismatch)
 *   2. scanForInjection()    — prompt-injection pattern scan (log + flag, never silently strip)
 *   3. TokenBucket           — in-memory per-agent rate limiter (10 req/min)
 *   4. (see executor)        — tool allowlist + max-iteration + max-token guards
 *   5. (see verifier)        — output schema enforcement with one retry
 *   6. (see a2a-client)      — 15s timeout + single retry on inter-agent calls
 *   7. (see audit.ts)        — structured jsonl audit log
 */
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { audit, summarize } from "./audit.js";

// ---------------------------------------------------------------------------
// 1. Input validation middleware (Zod before anything touches the LLM)
// ---------------------------------------------------------------------------

export function validateBody(schema: z.ZodTypeAny, agentName: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      audit(agentName, {
        event: "guardrail",
        from: req.ip ?? "unknown",
        to: agentName,
        detail: { guardrail: "input-validation", issues: parsed.error.issues.slice(0, 5) },
      });
      res.status(400).json({
        error: "Invalid request body",
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
      return;
    }
    req.body = parsed.data; // hand the *parsed* (typed, stripped) value onwards
    next();
  };
}

// ---------------------------------------------------------------------------
// 2. Prompt-injection scan
// ---------------------------------------------------------------------------

/**
 * Naive-by-design pattern list. A production system would use a classifier;
 * the point here is *where* the check sits: on the raw inbound text, before
 * any LLM call, with the result logged and attached as a flag — the text is
 * NOT modified (silent stripping hides attacks from downstream auditing).
 */
const INJECTION_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "ignore-previous-instructions", re: /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|prompts?)/i },
  { name: "disregard-instructions", re: /disregard\s+(all\s+)?(previous|prior|your)\s+(instructions|rules)/i },
  { name: "role-override", re: /you\s+are\s+(now|no\s+longer)\s+/i },
  { name: "system-prompt-probe", re: /(reveal|show|print|repeat)\s+(your\s+)?(system\s+prompt|instructions)/i },
  { name: "new-instructions-marker", re: /(\[|<)\s*(system|admin|root)\s*(\]|>)\s*:/i },
  { name: "jailbreak-marker", re: /\b(DAN\s+mode|developer\s+mode\s+enabled|jailbreak)\b/i },
];

export interface InjectionScanResult {
  flagged: boolean;
  matches: string[];
}

export function scanForInjection(agentName: string, text: string, taskId?: string): InjectionScanResult {
  const matches = INJECTION_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.name);
  if (matches.length > 0) {
    audit(agentName, {
      event: "guardrail",
      from: "inbound",
      to: agentName,
      taskId,
      inputSummary: summarize(text),
      detail: { guardrail: "prompt-injection-scan", flagged: true, matches },
    });
  }
  return { flagged: matches.length > 0, matches };
}

// ---------------------------------------------------------------------------
// 3. Rate limiting — simple in-memory token bucket
// ---------------------------------------------------------------------------

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,      // max burst, e.g. 10
    private readonly refillPerMs: number,   // tokens added per millisecond
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  /** Try to take one token; returns false when the bucket is empty (=> reject the request). */
  tryRemove(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.lastRefill) * this.refillPerMs);
    this.lastRefill = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

/** Express middleware: 10 requests/minute per agent process (bucket refills continuously). */
export function rateLimit(agentName: string, requestsPerMinute = 10) {
  const bucket = new TokenBucket(requestsPerMinute, requestsPerMinute / 60_000);
  return (req: Request, res: Response, next: NextFunction) => {
    if (bucket.tryRemove()) return next();
    audit(agentName, {
      event: "guardrail",
      from: req.ip ?? "unknown",
      to: agentName,
      detail: { guardrail: "rate-limit", limit: `${requestsPerMinute}/min` },
    });
    res.status(429).json({ error: `Rate limit exceeded (${requestsPerMinute} req/min)` });
  };
}

// ---------------------------------------------------------------------------
// Shared Zod schemas for the JSON-RPC + A2A wire format
// ---------------------------------------------------------------------------

export const textPartSchema = z.object({
  kind: z.literal("text"),
  text: z.string().min(1).max(20_000),
});

export const a2aMessageSchema = z.object({
  kind: z.literal("message"),
  role: z.enum(["user", "agent"]),
  parts: z.array(textPartSchema).min(1).max(10),
  messageId: z.string().min(1),
  taskId: z.string().optional(),
  contextId: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const jsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

export const messageSendParamsSchema = z.object({
  message: a2aMessageSchema,
});

export const tasksGetParamsSchema = z.object({
  id: z.string().min(1),
});
