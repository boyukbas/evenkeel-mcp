/**
 * Behaviour tests for the EvenKeel MCP server's domain layer.
 *
 * The math comes from EvenKeel's own engine; these tests pin the *answers* our
 * MCP tools hand back — the flagship normalization, the subscription audit, the
 * savings finder — on small, deterministic datasets, plus the data loader on
 * the real bundled sample. Run with `npm test`.
 */
import { describe, it, expect } from "vitest";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadDataset, isEvenKeelBackup } from "../src/dataset.ts";
import {
  monthlySpending,
  subscriptionAudit,
  savingsOpportunities,
  financialInsights,
} from "../src/evenkeel.ts";
import type { Category, Dataset, Expense, RecurringExpense, Settings } from "../src/types.ts";

/* ----------------------------- tiny factories ---------------------------- */

const TS = "2026-01-01T00:00:00.000Z";

function cat(id: string, name: string, essential: boolean, over: Partial<Category> = {}): Category {
  return { id, name, color: "#000", essential, createdAt: TS, updatedAt: TS, ...over };
}
function rec(over: Partial<RecurringExpense> & Pick<RecurringExpense, "id" | "name" | "amount" | "categoryId" | "frequency" | "anchorDate">): RecurringExpense {
  return {
    currency: "USD", interval: 1, endDate: null, amortize: false, active: true,
    tags: [], createdAt: TS, updatedAt: TS, ...over,
  };
}
function exp(over: Partial<Expense> & Pick<Expense, "id" | "date" | "amount" | "categoryId" | "description">): Expense {
  return {
    currency: "USD", tags: [], amortizeMonths: null, recurringId: null,
    createdAt: TS, updatedAt: TS, ...over,
  };
}
function dataset(parts: Partial<Dataset> & Pick<Dataset, "categories">): Dataset {
  const settings: Settings = {
    id: "singleton", baseCurrency: "USD", locale: "en-US", theme: "system",
    monthlyBudget: null, createdAt: TS, updatedAt: TS,
  };
  return {
    settings, categories: parts.categories, expenses: parts.expenses ?? [],
    recurring: parts.recurring ?? [], goals: parts.goals ?? [], source: "test",
  };
}

const YEAR_2026 = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, "0")}`);

/* -------------------------------- loader --------------------------------- */

describe("dataset loader", () => {
  it("accepts a well-formed EvenKeel backup and rejects anything else", () => {
    expect(isEvenKeelBackup({ app: "evenkeel", categories: [], expenses: [] })).toBe(true);
    expect(isEvenKeelBackup({ app: "ynab", categories: [], expenses: [] })).toBe(false);
    expect(isEvenKeelBackup({ app: "evenkeel" })).toBe(false);
    expect(isEvenKeelBackup("nope")).toBe(false);
  });

  it("loads the bundled sample when no source is given", () => {
    const ds = loadDataset();
    expect(ds.categories.length).toBe(16);
    expect(ds.expenses.length).toBeGreaterThan(0);
    expect(ds.recurring.length).toBeGreaterThan(0);
    expect(ds.source).toMatch(/sample/i);
  });

  it("throws a clear error when pointed at a non-EvenKeel file", () => {
    const p = join(tmpdir(), `not-evenkeel-${process.pid}.json`);
    writeFileSync(p, JSON.stringify({ app: "something-else" }));
    try {
      expect(() => loadDataset(p)).toThrow(/evenkeel backup/i);
    } finally {
      rmSync(p, { force: true });
    }
  });
});

/* ----------------------- normalization (the flagship) -------------------- */

describe("monthlySpending — normalization", () => {
  it("spreads a $1,320 yearly charge into twelve equal $110 months", () => {
    const ds = dataset({
      categories: [cat("ins", "Insurance", true)],
      recurring: [rec({ id: "r1", name: "Family life insurance", amount: 1320, categoryId: "ins", frequency: "annual", anchorDate: "2026-01-14", amortize: true })],
    });

    const out = monthlySpending(ds, { months: YEAR_2026 });

    // Every month's normalized spend is the smoothed $110 — even the 11 months
    // with zero actual cash-out.
    for (const point of out.points) {
      expect(point.normalized).toBe(110);
    }
    // The real cash leaves the account once, in the anchor month.
    expect(out.points[0].actual).toBe(1320); // 2026-01
    expect(out.points[1].actual).toBe(0); // 2026-02
    // Category breakdown is resolved to the human name, not the id.
    expect(out.points[0].normalizedByCategory).toContainEqual({ category: "Insurance", amount: 110 });
  });

  it("spreads a $300 quarterly charge into $100/month", () => {
    const ds = dataset({
      categories: [cat("u", "Utilities", true)],
      recurring: [rec({ id: "r1", name: "Water", amount: 300, categoryId: "u", frequency: "quarterly", anchorDate: "2026-01-10", amortize: true })],
    });
    const out = monthlySpending(ds, { months: YEAR_2026 });
    for (const point of out.points) expect(point.normalized).toBe(100);
  });
});

/* --------------------------- subscription audit -------------------------- */

describe("subscriptionAudit", () => {
  it("annualizes active subscriptions and labels their frequency", () => {
    const ds = dataset({
      categories: [cat("subs", "Subscriptions", false)],
      recurring: [rec({ id: "n", name: "Netflix", amount: 15.49, categoryId: "subs", frequency: "monthly", anchorDate: "2026-01-11" })],
    });
    const out = subscriptionAudit(ds);
    const netflix = out.subscriptions.find((s) => s.name === "Netflix")!;
    expect(netflix.monthlyEquivalent).toBe(15.49);
    expect(netflix.annualCost).toBe(185.88);
    expect(netflix.frequency).toBe("Monthly");
    expect(netflix.essential).toBe(false);
    expect(out.totalAnnual).toBe(185.88);
  });
});

/* --------------------------- savings opportunities ----------------------- */

describe("savingsOpportunities", () => {
  it("flags a non-essential subscription as fully cancellable", () => {
    const ds = dataset({
      categories: [cat("subs", "Subscriptions", false)],
      recurring: [rec({ id: "n", name: "Netflix", amount: 15.49, categoryId: "subs", frequency: "monthly", anchorDate: "2026-01-11" })],
    });
    const out = savingsOpportunities(ds, { months: YEAR_2026 });
    const op = out.opportunities.find((o) => o.label === "Netflix")!;
    expect(op.monthlySaving).toBe(15.49);
    expect(op.annualSaving).toBe(185.88);
    expect(op.suggestedMonthly).toBe(0);
    expect(out.totalMonthly).toBe(15.49);
  });
});

/* ------------------------------- insights -------------------------------- */

describe("financialInsights", () => {
  it("warns when normalized spend is over the monthly budget", () => {
    const ds = dataset({
      categories: [cat("h", "Housing", true)],
      recurring: [rec({ id: "rent", name: "Rent", amount: 100, categoryId: "h", frequency: "monthly", anchorDate: "2026-01-01" })],
    });
    ds.settings.monthlyBudget = 50;
    const out = financialInsights(ds, { months: ["2026-01", "2026-02", "2026-03"] });
    expect(out.insights.some((i) => i.severity === "warning")).toBe(true);
  });
});
