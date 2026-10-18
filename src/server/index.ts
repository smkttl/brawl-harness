import { buildApp } from "./app.js";
import { resolveRuntime } from "./config.js";

const runtime = resolveRuntime();
const logger = process.env.NODE_ENV !== "test";
const { app, context } = await buildApp(runtime, { logger });

const close = async () => {
  await app.close();
  context.store.close();
};

process.once("SIGINT", () => void close().finally(() => process.exit(0)));
process.once("SIGTERM", () => void close().finally(() => process.exit(0)));

try {
  await app.listen({ host: runtime.host, port: runtime.port });
  console.log(`Brawl backend listening on http://${runtime.host}:${runtime.port}`);
  console.log(`Data: ${runtime.dataDir}`);
  console.log(`Workspace: ${runtime.workspace}`);
  if (runtime.authDisabled) console.warn("Authentication is disabled.");
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
