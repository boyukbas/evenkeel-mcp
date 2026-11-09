/**
 * One-time, dev-only generator for the bundled sample dataset.
 *
 * It runs EvenKeel's *real* seed (the same `generateDemoData` the app uses on
 * first open) and writes the result as an EvenKeel backup file. This is the
 * only place that touches EvenKeel's Dexie module — it is build-time, never
 * imported by the server — so the server process stays browser-free.
 *
 *   npm run gen:sample
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildDefaultCategories, buildDefaultSettings } from "@/db/database";
import { generateDemoData } from "@/db/seed";
import type { BackupFile } from "../src/types.ts";

const settings = buildDefaultSettings();
const categories = buildDefaultCategories();
const { expenses, recurring, goals } = generateDemoData(categories, settings.baseCurrency);

const backup: BackupFile = {
  app: "evenkeel",
  version: 1,
  exportedAt: new Date().toISOString(),
  settings: { ...settings, hasSeededDemo: true },
  categories,
  expenses,
  recurring,
  goals,
};

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "data");
const outFile = join(outDir, "sample-backup.json");
mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, JSON.stringify(backup, null, 2) + "\n", "utf8");

console.log(
  `Wrote ${outFile}\n  ${categories.length} categories, ${expenses.length} expenses, ` +
    `${recurring.length} recurring, ${goals.length} goals`,
);
