/**
 * The Executor's tool registry.
 *
 * Tools are plain functions returning fake-but-plausible data — this PoC is
 * about the agent/protocol mechanics, not real execution.
 *
 * Guardrail #3 (tool allowlist): TOOL_ALLOWLIST is the *only* source of truth
 * for what may run. The ReAct loop checks every tool_use name against this
 * Set before executing — a model hallucinating "delete_all_files" gets a tool
 * error fed back, never code execution.
 */
import { z } from "zod";
import type { ToolDefinition } from "../../shared/llm.js";

interface Tool {
  definition: ToolDefinition;
  argsSchema: z.ZodTypeAny;
  execute: (args: Record<string, unknown>) => string;
}

export const toolRegistry: Record<string, Tool> = {
  run_shell_command: {
    definition: {
      type: "function",
      function: {
        name: "run_shell_command",
        description:
          "Run a shell command on the host and return stdout. (Mocked: returns canned output, nothing is executed.)",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "The shell command to run, e.g. 'uname -a'" },
          },
          required: ["command"],
        },
      },
    },
    argsSchema: z.object({ command: z.string().min(1).max(500) }),
    execute: (args) => {
      const command = String(args.command);
      // Canned outputs for a few common commands so demos look sensible.
      if (/uname/.test(command)) return "Linux poc-host 6.8.0-mock #1 SMP x86_64 GNU/Linux";
      if (/df\b/.test(command)) return "Filesystem  Size  Used Avail Use%\n/dev/sda1   100G   42G   58G  42% /";
      if (/uptime/.test(command)) return "14:32:11 up 12 days,  3:04,  1 user,  load average: 0.15, 0.10, 0.05";
      if (/(^|\s)ls(\s|$)/.test(command)) return "app.ts  config.yaml  package.json  README.md  src/";
      return `(mock) command '${command}' exited 0 with no output`;
    },
  },

  read_file: {
    definition: {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file from disk and return its contents. (Mocked: returns canned file contents.)",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute or relative file path, e.g. 'config.yaml'" },
          },
          required: ["path"],
        },
      },
    },
    argsSchema: z.object({ path: z.string().min(1).max(300) }),
    execute: (args) => {
      const path = String(args.path);
      if (/config\.ya?ml$/.test(path)) {
        return "service:\n  name: demo-api\n  port: 8080\n  replicas: 3\nlogging:\n  level: info";
      }
      if (/package\.json$/.test(path)) {
        return '{ "name": "demo-api", "version": "2.1.0", "engines": { "node": ">=20" } }';
      }
      return `(mock) contents of ${path}:\nlorem ipsum configuration data\nkey=value`;
    },
  },

  web_lookup: {
    definition: {
      type: "function",
      function: {
        name: "web_lookup",
        description: "Look up a topic on the web and return a short summary. (Mocked: returns canned snippets.)",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query, e.g. 'latest Node.js LTS version'" },
          },
          required: ["query"],
        },
      },
    },
    argsSchema: z.object({ query: z.string().min(1).max(300) }),
    execute: (args) =>
      `(mock search results for "${String(args.query)}") ` +
      "Top result: an authoritative-looking page confirming the queried topic is real, current and well-documented. " +
      "Published 2026-01-15.",
  },
};

/** Guardrail: the executable tool names, as a Set, checked before every execution. */
export const TOOL_ALLOWLIST: ReadonlySet<string> = new Set(Object.keys(toolRegistry));

/** Tool definitions in the shape the LLM API expects. */
export const toolDefinitions: ToolDefinition[] = Object.values(toolRegistry).map((t) => t.definition);
