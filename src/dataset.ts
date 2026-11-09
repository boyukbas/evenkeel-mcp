/**
 * Loads the dataset the server answers questions about.
 *
 * Resolution order:
 *   1. an explicit path (CLI arg / function arg)
 *   2. the EVENKEEL_BACKUP environment variable
 *   3. the bundled sample (so the server runs with zero setup)
 *
 * The file must be an EvenKeel backup — the exact JSON the app writes from
 * Settings → "Export backup (.json)". Drop your real export in and the server
 * answers questions about *your* money instead of the demo.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { BackupFile, Dataset } from "./types.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const SAMPLE_PATH = resolve(here, "..", "data", "sample-backup.json");

/** Structural check, mirroring EvenKeel's own `isBackupFile`. */
export function isEvenKeelBackup(data: unknown): data is BackupFile {
  if (!data || typeof data !== "object") return false;
  const d = data as Partial<BackupFile>;
  return d.app === "evenkeel" && Array.isArray(d.categories) && Array.isArray(d.expenses);
}

export function datasetFromBackup(backup: BackupFile, source: string): Dataset {
  return {
    settings: backup.settings,
    categories: backup.categories,
    expenses: backup.expenses,
    recurring: backup.recurring ?? [],
    goals: backup.goals ?? [],
    source,
  };
}

export function loadDataset(source?: string): Dataset {
  const path = source ?? process.env.EVENKEEL_BACKUP ?? SAMPLE_PATH;
  const isSample = path === SAMPLE_PATH;

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`Could not read EvenKeel backup at "${path}": ${(e as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`"${path}" is not valid JSON.`);
  }

  if (!isEvenKeelBackup(parsed)) {
    throw new Error(
      `"${path}" is not an EvenKeel backup. Expected an object like ` +
        `{ app: "evenkeel", categories: [...], expenses: [...] }.`,
    );
  }

  const source_ = isSample
    ? "bundled sample dataset (EvenKeel demo seed)"
    : `EvenKeel backup at ${path}`;
  return datasetFromBackup(parsed, source_);
}
