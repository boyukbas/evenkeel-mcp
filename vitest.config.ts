import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// Map EvenKeel's `@/*` alias to its source so the server's tests exercise the
// app's real engine. (tsx reads this from tsconfig at runtime; vitest/vite does
// not, so we mirror it here.) A regex keeps it from swallowing `@scope/pkg`.
export default defineConfig({
  resolve: {
    alias: [{ find: /^@\/(.*)$/, replacement: resolve(here, "../evenkeel/src") + "/$1" }],
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
