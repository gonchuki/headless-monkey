import path from "node:path";
import { config as loadEnv } from "dotenv";

// Filtered pnpm scripts run with the package dir as cwd, so the root `.env`
// must be resolved relative to this file, not the cwd. `src/config` and the
// compiled `dist/config` are the same depth, so ../../../ works for both tsx
// and node runs.
loadEnv({ path: path.resolve(__dirname, "../../../.env") });

export interface AppEnv {
  adminPassword: string;
  jwtSecret: string;
  port: number;
  databasePath: string;
}

export function loadAppEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    adminPassword: overrides.adminPassword ?? process.env.ADMIN_PASSWORD ?? "",
    jwtSecret: overrides.jwtSecret ?? process.env.JWT_SECRET ?? "",
    port: overrides.port ?? Number(process.env.PORT ?? 4000),
    databasePath:
      overrides.databasePath ??
      process.env.DATABASE_PATH ??
      "./data/headless-monkey.db",
  };
}

/**
 * Hard startup check for non-test runs. Tests never import this path: they
 * exercise `createApp()` directly and inject env values when they need them.
 */
export function validateAppEnv(env: AppEnv): void {
  if (!env.adminPassword) {
    throw new Error("ADMIN_PASSWORD must be set in the root .env file");
  }
  if (!env.jwtSecret) {
    throw new Error("JWT_SECRET must be set in the root .env file");
  }
}
