/// <reference types="@cloudflare/vitest-plugin/types" />
import { applyD1Migrations, env } from "cloudflare:test";

interface MigrationsEnv {
  DB: D1Database;
  TEST_MIGRATIONS: { name: string; queries: string[] }[];
}

const testEnv = env as unknown as MigrationsEnv;
await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
