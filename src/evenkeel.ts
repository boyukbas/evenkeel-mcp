/**
 * The domain layer: turns a loaded {@link Dataset} into the plain-object
 * "answers" the MCP tools hand back.
 *
 * Every number here comes from EvenKeel's *own* engine (imported through the
 * `@/*` alias) — `buildMonthlySeries`/`summarize` for the actual-vs-normalized
 * view, `subscriptionsFrom`/`savingOpportunities`/`buildInsights` for the rest.
 * This module's only job is to choose the month window, run those functions,
 * and resolve category ids to human names so the output reads cleanly.
 */
import type { Category, ID, MonthKey } from "@/types";
import { currentMonthKey, lastNMonths } from "@/lib/date";
import { buildMonthlySeries, summarize } from "@/lib/analytics";
import {
  buildInsights,
  savingOpportunities,
  subscriptionsFrom,
  totalPotentialSaving,
} from "@/lib/insights";
import { describeFrequency } from "@/lib/recurrence";
import type { Dataset } from "./types.ts";

export interface MonthOpts {
  /** Explicit "YYYY-MM" keys (wins if non-empty). */
  months?: MonthKey[];
  /** Otherwise, the last N months ending this calendar month. Default 6. */
  lastN?: number;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function resolveMonths(opts: MonthOpts): MonthKey[] {
  if (opts.months && opts.months.length) return opts.months;
  return lastNMonths(Math.max(1, opts.lastN ?? 6), currentMonthKey());
}

function nameIndex(categories: Category[]): Map<ID, string> {
  return new Map(categories.map((c) => [c.id, c.name]));
}

const SYMBOLS: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", TRY: "₺", JPY: "¥" };
function symbolFor(code: string): string {
  return SYMBOLS[code] ?? code + " ";
}

/** Actual vs normalized spend per month, with category names and a summary. */
export function monthlySpending(ds: Dataset, opts: MonthOpts = {}) {
  const months = resolveMonths(opts);
  const series = buildMonthlySeries({ expenses: ds.expenses, recurring: ds.recurring, months });
  const names = nameIndex(ds.categories);
  const named = (list: { categoryId: ID; amount: number }[]) =>
    list.map((c) => ({ category: names.get(c.categoryId) ?? "Uncategorized", amount: round2(c.amount) }));

  return {
    currency: ds.settings.baseCurrency,
    months,
    points: series.map((p) => ({
      month: p.month,
      actual: p.actual,
      normalized: p.normalized,
      /** actual − normalized: how lumpy this month was vs its smoothed baseline. */
      lumpiness: round2(p.actual - p.normalized),
      actualByCategory: named(p.actualByCategory),
      normalizedByCategory: named(p.normalizedByCategory),
    })),
    summary: summarize(series),
  };
}

/** Every active recurring charge, annualized and sorted by yearly cost. */
export function subscriptionAudit(ds: Dataset) {
  const names = nameIndex(ds.categories);
  const subscriptions = subscriptionsFrom(ds.recurring, ds.categories).map((s) => ({
    name: s.recurring.name,
    category: names.get(s.recurring.categoryId) ?? "Uncategorized",
    frequency: describeFrequency(s.recurring),
    monthlyEquivalent: s.monthlyEquivalent,
    annualCost: s.annualCost,
    essential: s.essential,
  }));
  return {
    currency: ds.settings.baseCurrency,
    subscriptions,
    totalMonthly: round2(subscriptions.reduce((a, s) => a + s.monthlyEquivalent, 0)),
    totalAnnual: round2(subscriptions.reduce((a, s) => a + s.annualCost, 0)),
  };
}

/** Concrete ways to free up money: cancellable subs + hot discretionary spend. */
export function savingsOpportunities(ds: Dataset, opts: MonthOpts = {}) {
  const months = resolveMonths(opts);
  const names = nameIndex(ds.categories);
  const ops = savingOpportunities({
    expenses: ds.expenses,
    recurring: ds.recurring,
    categories: ds.categories,
    months,
  });
  const totals = totalPotentialSaving(ops);
  return {
    currency: ds.settings.baseCurrency,
    opportunities: ops.map((o) => ({
      label: o.label,
      category: o.categoryId ? names.get(o.categoryId) ?? null : null,
      currentMonthly: o.currentMonthly,
      suggestedMonthly: o.suggestedMonthly,
      monthlySaving: o.monthlySaving,
      annualSaving: o.annualSaving,
      rationale: o.rationale,
    })),
    totalMonthly: totals.monthly,
    totalAnnual: totals.annual,
  };
}

/** Headline insight cards (budget breaches, spikes, opportunities, all-clear). */
export function financialInsights(ds: Dataset, opts: MonthOpts = {}) {
  const months = resolveMonths(opts);
  const insights = buildInsights({
    expenses: ds.expenses,
    recurring: ds.recurring,
    categories: ds.categories,
    months,
    monthlyBudget: ds.settings.monthlyBudget,
    currency: symbolFor(ds.settings.baseCurrency),
    locale: ds.settings.locale,
  });
  return {
    insights: insights.map((i) => ({
      severity: i.severity,
      title: i.title,
      detail: i.detail,
      monthlySaving: i.monthlySaving,
    })),
  };
}
