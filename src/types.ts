/**
 * Shared types for the EvenKeel MCP server.
 *
 * The domain entities (Expense, RecurringExpense, …) are EvenKeel's own — we
 * import them through the `@/*` alias so this server and the app speak exactly
 * the same language. `BackupFile` mirrors the shape EvenKeel writes from
 * Settings → "Export backup (.json)" (see evenkeel/src/db/repo.ts); we keep a
 * local copy of the interface because repo.ts transitively imports Dexie, which
 * we deliberately keep out of the server process.
 */
import type {
  Category,
  Expense,
  RecurringExpense,
  SavingsGoal,
  Settings,
} from "@/types";

export type { Category, Expense, RecurringExpense, SavingsGoal, Settings };

/** The on-disk format produced by EvenKeel's backup export. */
export interface BackupFile {
  app: "evenkeel";
  version: number;
  exportedAt: string;
  settings: Settings;
  categories: Category[];
  expenses: Expense[];
  recurring: RecurringExpense[];
  goals: SavingsGoal[];
  attachments?: unknown[];
}

/** A loaded, validated dataset plus a note on where it came from. */
export interface Dataset {
  settings: Settings;
  categories: Category[];
  expenses: Expense[];
  recurring: RecurringExpense[];
  goals: SavingsGoal[];
  /** Human-readable description of the data source, surfaced to the model. */
  source: string;
}
