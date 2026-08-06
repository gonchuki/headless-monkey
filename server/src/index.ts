import { createApp } from "./app";
import { loadAppEnv, validateAppEnv } from "./config/env";

const env = loadAppEnv();
validateAppEnv(env);

const app = createApp();

app.listen(env.port, () => {
  console.log(`server listening on http://localhost:${env.port}`);
});
