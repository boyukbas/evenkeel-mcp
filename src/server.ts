#!/usr/bin/env node
/**
 * EvenKeel MCP server.
 *
 * Exposes EvenKeel's expense data + normalization engine over the Model
 * Context Protocol so any MCP host (Claude Desktop, Claude Code, your own
 * orchestrator) can reason about real finances through a standard interface.
 *
 * It speaks MCP over **stdio**: the host launches this script as a subprocess
 * and exchanges JSON-RPC messages on stdin/stdout. The three MCP primitives are
 * all here:
 *   • tools     — model-controlled actions (query spend, audit subs, find savings)
 *   • resources — app-controlled data the host can read (dataset summary, expenses)
 *   • prompts   — user-controlled templates ("review my finances")
 *
 * GOTCHA demonstrated below: on stdio, stdout IS the protocol channel. All
 * human-facing logging must go to stderr (console.error), never console.log,
 * or it corrupts the JSON-RPC stream.
 */
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { toMonthKey } from "@/lib/date";
import { loadDataset } from "./dataset.ts";
import {
  financialInsights,
  monthlySpending,
  savingsOpportunities,
  subscriptionAudit,
} from "./evenkeel.ts";

/* ------------------------------ data + helpers --------------------------- */

// First non-flag CLI arg (or --backup <path>) overrides the data source.
const argv = process.argv.slice(2);
const flagIdx = argv.indexOf("--backup");
const backupArg = flagIdx >= 0 ? argv[flagIdx + 1] : argv.find((a) => !a.startsWith("-"));

const dataset = loadDataset(backupArg);

const SYMBOLS: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", TRY: "₺", JPY: "¥" };
const sym = SYMBOLS[dataset.settings.baseCurrency] ?? dataset.settings.baseCurrency + " ";
const money = (n: number) => `${sym}${n.toLocaleString(dataset.settings.locale ?? "en-US", { maximumFractionDigits: 2 })}`;

/** Wrap a result as an MCP tool response: markdown text for humans, structured for machines. */
function result(text: string, structured: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], structuredContent: structured };
}

/* --------------------------------- server -------------------------------- */

const server = new McpServer({ name: "evenkeel-mcp", version: "0.1.0" });

/* ----- Tool 1: monthly spending (the flagship actual-vs-normalized view) -- */
server.registerTool(
  "get_monthly_spending",
  {
    title: "Get monthly spending (actual vs. normalized)",
    description:
      "Returns spending per month in two views: 'actual' (real cash that left the account, lumpy) " +
      "and 'normalized' (periodic charges spread evenly into a true monthly figure). The flagship " +
      "EvenKeel number. Use this to answer 'what do I really spend per month?'.",
    inputSchema: {
      lastN: z.number().int().min(1).max(36).optional().describe("How many months back to include (default 6)."),
      months: z.array(z.string().regex(/^\d{4}-\d{2}$/)).optional().describe("Explicit 'YYYY-MM' months instead of lastN."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ lastN, months }) => {
    const data = monthlySpending(dataset, { lastN, months });
    const rows = data.points
      .map((p) => `| ${p.month} | ${money(p.actual)} | ${money(p.normalized)} | ${money(p.lumpiness)} |`)
      .join("\n");
    const text =
      `Spending across ${data.points.length} months (${data.currency}):\n\n` +
      `| Month | Actual | Normalized | Lumpiness |\n|---|---|---|---|\n${rows}\n\n` +
      `Average normalized (your true monthly baseline): ${money(data.summary.avgNormalized)}/mo. ` +
      `Average actual: ${money(data.summary.avgActual)}/mo. ` +
      `Peak actual month: ${data.summary.peakActualMonth ?? "—"} at ${money(data.summary.peakActual)}.`;
    return result(text, data);
  },
);

/* ----- Tool 2: subscription audit ---------------------------------------- */
server.registerTool(
  "audit_subscriptions",
  {
    title: "Audit subscriptions & recurring charges",
    description:
      "Lists every active recurring charge with its smoothed monthly equivalent and annualized cost, " +
      "sorted by yearly spend, flagging which are essential. Answers 'where is my recurring money going?'.",
    inputSchema: {},
    // Demonstrates a typed OUTPUT schema: the SDK validates structuredContent against this.
    outputSchema: {
      currency: z.string(),
      subscriptions: z.array(
        z.object({
          name: z.string(),
          category: z.string(),
          frequency: z.string(),
          monthlyEquivalent: z.number(),
          annualCost: z.number(),
          essential: z.boolean(),
        }),
      ),
      totalMonthly: z.number(),
      totalAnnual: z.number(),
    },
    annotations: { readOnlyHint: true },
  },
  async () => {
    const data = subscriptionAudit(dataset);
    const lines = data.subscriptions
      .map((s) => `- ${s.name} (${s.category}${s.essential ? "" : ", non-essential"}) — ${money(s.monthlyEquivalent)}/mo · ${money(s.annualCost)}/yr · ${s.frequency}`)
      .join("\n");
    const text =
      `${data.subscriptions.length} active recurring charges (${data.currency}):\n\n${lines}\n\n` +
      `Total: ${money(data.totalMonthly)}/mo · ${money(data.totalAnnual)}/yr.`;
    return result(text, data);
  },
);

/* ----- Tool 3: find savings ---------------------------------------------- */
server.registerTool(
  "find_savings",
  {
    title: "Find savings opportunities",
    description:
      "Surfaces concrete ways to free up money: non-essential subscriptions that could be cancelled, " +
      "and discretionary categories running hot that could be trimmed. Each comes with a monthly/annual figure.",
    inputSchema: {
      lastN: z.number().int().min(1).max(36).optional().describe("Trailing months to base discretionary averages on (default 6)."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ lastN }) => {
    const data = savingsOpportunities(dataset, { lastN });
    const lines = data.opportunities
      .map((o) => `- ${o.label}${o.category ? ` (${o.category})` : ""}: save ${money(o.monthlySaving)}/mo (${money(o.annualSaving)}/yr) — ${o.rationale}`)
      .join("\n");
    const text =
      `${data.opportunities.length} savings opportunities (${data.currency}):\n\n${lines}\n\n` +
      `Total potential: ${money(data.totalMonthly)}/mo · ${money(data.totalAnnual)}/yr.`;
    return result(text, data);
  },
);

/* ----- Tool 4: insights -------------------------------------------------- */
server.registerTool(
  "get_insights",
  {
    title: "Get financial insight cards",
    description:
      "Headline insights over the recent window: budget breaches, spending spikes, lumpy-month explanations, " +
      "category anomalies, and the top savings opportunity. Mirrors EvenKeel's dashboard insights.",
    inputSchema: {
      lastN: z.number().int().min(1).max(36).optional().describe("Trailing months to analyze (default 6)."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ lastN }) => {
    const data = financialInsights(dataset, { lastN });
    const lines = data.insights.length
      ? data.insights.map((i) => `- [${i.severity}] ${i.title}: ${i.detail}`).join("\n")
      : "- No insights for this window.";
    return result(`${data.insights.length} insights:\n\n${lines}`, data);
  },
);

/* ------------------------------- resources ------------------------------- */

/* A static resource: a one-screen overview of the loaded dataset. */
server.registerResource(
  "dataset-summary",
  "evenkeel://dataset/summary",
  {
    title: "Dataset summary",
    description: "Counts, currency, date range, and source of the loaded EvenKeel dataset.",
    mimeType: "application/json",
  },
  async (uri) => {
    const dates = dataset.expenses.map((e) => e.date).sort();
    const summary = {
      source: dataset.source,
      currency: dataset.settings.baseCurrency,
      monthlyBudget: dataset.settings.monthlyBudget ?? null,
      counts: {
        categories: dataset.categories.length,
        expenses: dataset.expenses.length,
        recurring: dataset.recurring.length,
        goals: dataset.goals.length,
      },
      expenseDateRange: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null,
    };
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(summary, null, 2) }] };
  },
);

/* A static resource: the category list (the vocabulary everything else uses). */
server.registerResource(
  "categories",
  "evenkeel://categories",
  {
    title: "Categories",
    description: "All spending categories, with essential/non-essential and any per-category budget.",
    mimeType: "application/json",
  },
  async (uri) => {
    const cats = dataset.categories.map((c) => ({
      name: c.name,
      essential: c.essential,
      monthlyBudget: c.monthlyBudget ?? null,
    }));
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(cats, null, 2) }] };
  },
);

/* A templated resource: expenses for a given month, e.g. evenkeel://expenses/2026-05.
   The `list` callback enumerates the months that actually have data so hosts can
   browse them; reading one returns that month's line items. */
const monthsWithData = [...new Set(dataset.expenses.map((e) => toMonthKey(e.date)))].sort();
server.registerResource(
  "expenses-by-month",
  new ResourceTemplate("evenkeel://expenses/{month}", {
    list: async () => ({
      resources: monthsWithData.map((m) => ({
        uri: `evenkeel://expenses/${m}`,
        name: `Expenses for ${m}`,
        mimeType: "application/json",
      })),
    }),
    complete: {
      month: (value) => monthsWithData.filter((m) => m.startsWith(value)),
    },
  }),
  {
    title: "Expenses by month",
    description: "Line-item expenses for a single 'YYYY-MM' month.",
    mimeType: "application/json",
  },
  async (uri, { month }) => {
    const key = String(month);
    const names = new Map(dataset.categories.map((c) => [c.id, c.name]));
    const items = dataset.expenses
      .filter((e) => toMonthKey(e.date) === key)
      .map((e) => ({ date: e.date, amount: e.amount, category: names.get(e.categoryId) ?? "Uncategorized", description: e.description }))
      .sort((a, b) => a.date.localeCompare(b.date));
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ month: key, count: items.length, items }, null, 2) }] };
  },
);

/* -------------------------------- prompts -------------------------------- */

server.registerPrompt(
  "review_my_finances",
  {
    title: "Review my finances",
    description: "A ready-made task that walks the assistant through a full review using this server's tools.",
    argsSchema: { lastN: z.string().regex(/^\d+$/).optional().describe("How many months to review (default 6).") },
  },
  ({ lastN }) => {
    const n = lastN ?? "6";
    return {
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text:
              `Review my spending over the last ${n} months using the EvenKeel tools.\n\n` +
              `1. Call get_monthly_spending (lastN=${n}) and explain the gap between my actual and normalized spend.\n` +
              `2. Call audit_subscriptions and call out the biggest recurring costs.\n` +
              `3. Call find_savings and get_insights, then give me a short prioritized plan to lower my true monthly baseline.\n\n` +
              `Use the normalized figures as my real budget; explain any lumpy months plainly.`,
          },
        },
      ],
    };
  },
);

server.registerPrompt(
  "whats_my_true_monthly_budget",
  {
    title: "What's my true monthly budget?",
    description: "Asks the assistant to derive a single defensible monthly baseline from the normalized data.",
  },
  () => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text:
            "Using get_monthly_spending (normalized view) and audit_subscriptions, tell me the single monthly number " +
            "I should budget to, and explain why it differs from what actually left my account last month.",
        },
      },
    ],
  }),
);

/* --------------------------------- start --------------------------------- */

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is the JSON-RPC channel.
  console.error(`[evenkeel-mcp] ready · source: ${dataset.source} · ${dataset.expenses.length} expenses, ${dataset.recurring.length} recurring`);
}

main().catch((err) => {
  console.error("[evenkeel-mcp] fatal:", err);
  process.exit(1);
});
