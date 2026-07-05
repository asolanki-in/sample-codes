/**
 * Shared JSON-RPC 2.0 endpoint plumbing for the POST / route of every agent.
 *
 * Validates the envelope with Zod, dispatches on `method`, and converts
 * failures into standard JSON-RPC error objects. Stack traces never leave the
 * process — errors are logged locally and only `{ code, message }` goes out.
 */
import type { Request, Response } from "express";
import { audit, summarize } from "./audit.js";
import { jsonRpcRequestSchema } from "./guardrails.js";
import { JsonRpcErrorCodes, type JsonRpcFailure, type JsonRpcSuccess } from "./types.js";

export type RpcHandler = (params: unknown) => Promise<unknown>;

/** Thrown by handlers to send a specific JSON-RPC error code to the caller. */
export class JsonRpcHandlerError extends Error {
  constructor(public readonly code: number, message: string) {
    super(message);
    this.name = "JsonRpcHandlerError";
  }
}

export function jsonRpcEndpoint(agentName: string, handlers: Record<string, RpcHandler>) {
  return async (req: Request, res: Response) => {
    // Guardrail #1: Zod on the raw body before anything else happens.
    const envelope = jsonRpcRequestSchema.safeParse(req.body);
    if (!envelope.success) {
      const failure: JsonRpcFailure = {
        jsonrpc: "2.0",
        id: (req.body as { id?: string | number })?.id ?? null,
        error: { code: JsonRpcErrorCodes.INVALID_REQUEST, message: "Invalid JSON-RPC 2.0 request" },
      };
      audit(agentName, {
        event: "guardrail",
        from: req.ip ?? "unknown",
        to: agentName,
        detail: { guardrail: "input-validation", where: "jsonrpc-envelope" },
      });
      res.status(400).json(failure);
      return;
    }

    const { id, method, params } = envelope.data;
    const started = Date.now();

    const handler = handlers[method];
    if (!handler) {
      const failure: JsonRpcFailure = {
        jsonrpc: "2.0",
        id,
        error: { code: JsonRpcErrorCodes.METHOD_NOT_FOUND, message: `Method not found: ${method}` },
      };
      res.status(200).json(failure);
      return;
    }

    try {
      const result = await handler(params);
      const success: JsonRpcSuccess = { jsonrpc: "2.0", id, result };
      audit(agentName, {
        event: "a2a-serve",
        from: req.ip ?? "unknown",
        to: agentName,
        latencyMs: Date.now() - started,
        inputSummary: summarize(JSON.stringify(params ?? {})),
        outputSummary: summarize(JSON.stringify(result)),
        detail: { method },
      });
      res.json(success);
    } catch (err) {
      // Expected protocol errors get a one-line log; unexpected errors keep the
      // full stack — but locally only, nothing internal ever goes on the wire.
      if (err instanceof JsonRpcHandlerError) {
        console.warn(`[${agentName}] ${method} -> JSON-RPC error ${err.code}: ${err.message}`);
      } else {
        console.error(`[${agentName}] handler error for ${method}:`, err);
      }
      const code = err instanceof JsonRpcHandlerError ? err.code : JsonRpcErrorCodes.INTERNAL_ERROR;
      const message = err instanceof JsonRpcHandlerError ? err.message : "Internal error";
      const failure: JsonRpcFailure = { jsonrpc: "2.0", id, error: { code, message } };
      audit(agentName, {
        event: "a2a-serve",
        from: req.ip ?? "unknown",
        to: agentName,
        latencyMs: Date.now() - started,
        outputSummary: `ERROR ${code}: ${message}`,
        detail: { method },
      });
      res.status(200).json(failure); // JSON-RPC errors are valid responses -> HTTP 200
    }
  };
}
