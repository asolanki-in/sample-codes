/**
 * Flow loading.
 *
 * Supports three authoring formats so flows are easy to write:
 *   - YAML  (.yaml/.yml): full structured flow (name, platform, app, steps)
 *   - JSON  (.json):      same structure as YAML
 *   - Text  (.txt or any): one natural-language step per line (# = comment)
 *
 * Inline steps (from the CLI --step option) are also normalised here.
 */

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Flow, FlowStep } from "../types.js";

const SelectorSchema = z.union([
  z.string(),
  z.object({
    text: z.string().optional(),
    id: z.string().optional(),
    accessibilityId: z.string().optional(),
  }),
]);

const ExpectationSchema = z.object({
  visible: z.union([SelectorSchema, z.array(SelectorSchema)]).optional(),
  notVisible: z.union([SelectorSchema, z.array(SelectorSchema)]).optional(),
});

const RawStepSchema = z.union([
  z.string(),
  z.object({
    id: z.string().optional(),
    text: z.string().min(1, "step text cannot be empty"),
    optional: z.boolean().optional(),
    retries: z.number().int().min(0).optional(),
    expect: ExpectationSchema.optional(),
  }),
]);

const RawFlowSchema = z.object({
  name: z.string().optional(),
  platform: z.enum(["android", "ios"]).optional(),
  device: z.string().optional(),
  app: z
    .object({
      appPackage: z.string().optional(),
      appActivity: z.string().optional(),
      bundleId: z.string().optional(),
      appPath: z.string().optional(),
    })
    .optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  steps: z.array(RawStepSchema).min(1, "a flow needs at least one step"),
});

function normaliseSteps(raw: z.infer<typeof RawStepSchema>[]): FlowStep[] {
  return raw.map((s, i) => {
    const id = `step-${i + 1}`;
    if (typeof s === "string") {
      return { id, text: s.trim(), optional: false, retries: 0 };
    }
    return {
      id: s.id ?? id,
      text: s.text.trim(),
      optional: s.optional ?? false,
      retries: s.retries ?? 0,
      ...(s.expect ? { expect: s.expect } : {}),
    };
  });
}

/** Parse a plain-text flow: one step per line, `#` comments and blanks ignored. */
function parseTextFlow(content: string, name: string): Flow {
  const steps = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .map((text, i): FlowStep => ({ id: `step-${i + 1}`, text, optional: false, retries: 0 }));

  if (steps.length === 0) {
    throw new Error(`Flow "${name}" contains no steps.`);
  }
  return { name, steps };
}

function parseStructured(data: unknown, fallbackName: string): Flow {
  const parsed = RawFlowSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid flow definition:\n${issues}`);
  }
  const f = parsed.data;
  return {
    name: f.name ?? fallbackName,
    platform: f.platform,
    device: f.device,
    app: f.app,
    capabilities: f.capabilities,
    steps: normaliseSteps(f.steps),
  };
}

/** Load a flow from a file, picking the parser by extension/content. */
export async function loadFlowFromFile(path: string): Promise<Flow> {
  const content = await readFile(path, "utf8");
  const ext = extname(path).toLowerCase();
  const name = basename(path).replace(/\.[^.]+$/, "");

  if (ext === ".json") {
    return parseStructured(JSON.parse(content), name);
  }
  if (ext === ".yaml" || ext === ".yml") {
    return parseStructured(parseYaml(content), name);
  }

  // Heuristic: if a non-.txt file actually contains structured YAML/JSON with a
  // `steps:` key, parse it as structured; otherwise treat it as plain text.
  if (ext !== ".txt") {
    const trimmed = content.trimStart();
    if (trimmed.startsWith("{") || /^steps\s*:/m.test(content)) {
      const data = trimmed.startsWith("{") ? JSON.parse(content) : parseYaml(content);
      return parseStructured(data, name);
    }
  }
  return parseTextFlow(content, name);
}

/** Build a flow from steps supplied directly on the CLI. */
export function flowFromInlineSteps(steps: string[], name = "inline-flow"): Flow {
  const cleaned = steps.map((s) => s.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    throw new Error("No steps provided.");
  }
  return {
    name,
    steps: cleaned.map((text, i) => ({
      id: `step-${i + 1}`,
      text,
      optional: false,
      retries: 0,
    })),
  };
}
