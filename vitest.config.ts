import { defineConfig } from "vitest/config";

// Logging is on by default: keep test runs out of the real debug log.
export default defineConfig({ test: { env: { HERDR_AGENTS_LOG: "0" } } });
