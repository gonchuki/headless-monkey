import path from "node:path";
import { config as loadEnv } from "dotenv";

// Filtered pnpm scripts run with the package dir as cwd, so the root `.env`
// must be resolved relative to this file, not the cwd. `src/config` and the
// compiled `dist/config` are the same depth, so ../../../ works for both tsx
// and node runs.
const REPO_ROOT = path.resolve(__dirname, "../../../");
loadEnv({ path: path.resolve(REPO_ROOT, ".env") });

export interface AppEnv {
  adminPassword: string;
  jwtSecret: string;
  port: number;
  databasePath: string;
}

// Filtered pnpm scripts run with the package dir as cwd, so relative paths
// like `./data/headless-monkey.db` must be anchored at the repo root, not the
// cwd. Absolute paths are returned untouched.
function resolveDatabasePath(dbPath: string): string {
  if (path.isAbsolute(dbPath)) {
    return dbPath;
  }
  return path.resolve(REPO_ROOT, dbPath);
}

export function loadAppEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    adminPassword: overrides.adminPassword ?? process.env.ADMIN_PASSWORD ?? "",
    jwtSecret: overrides.jwtSecret ?? process.env.JWT_SECRET ?? "",
    port: overrides.port ?? Number(process.env.PORT ?? 4000),
    databasePath: resolveDatabasePath(
      overrides.databasePath ??
        process.env.DATABASE_PATH ??
        "./data/headless-monkey.db"
    ),
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
