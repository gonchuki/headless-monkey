import fs from "node:fs";
import path from "node:path";
import { createApp } from "./app";
import { loadAppEnv, validateAppEnv } from "./config/env";
import { openDatabase } from "./db/database";

const env = loadAppEnv();
validateAppEnv(env);

fs.mkdirSync(path.dirname(env.databasePath), { recursive: true });

const db = openDatabase(env.databasePath);
const app = createApp(db);

app.listen(env.port, () => {
  console.log(`server listening on http://localhost:${env.port}`);
});
