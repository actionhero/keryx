import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/**/*.test.ts"],
    setupFiles: ["./__tests__/setup.ts"],
    globals: false,
    pool: "forks",
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 60_000,
    // zod (and other CJS deps consumed via named imports) need to be transformed
    // by Vite so the named-export interop works under the Bun runtime. Without
    // this, `import { z } from "zod"` yields `z === undefined`.
    server: { deps: { inline: ["zod"] } },
  },
});
