import path from "node:path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Filtered pnpm scripts run with the package dir as cwd, so the root `.env`
// sits one level up. The proxy target must match the PORT the server listens
// on, so it is read from the same root `.env`.
export default defineConfig(({ mode }) => {
  const envDir = path.resolve(process.cwd(), "..");
  const env = loadEnv(mode, envDir, "");
  const port = Number(env.PORT ?? 4000);

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "./src"),
      },
    },
    server: {
      proxy: {
        "/api": `http://localhost:${port}`,
      },
    },
  };
});
