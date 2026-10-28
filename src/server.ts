import { buildApp } from "./app.js";

const app = buildApp();
const port = Number(process.env.PORT ?? 3000);

app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

// As PID 1 in a container, node has no default SIGTERM handler, so close explicitly:
// in-flight requests finish before the platform replaces the instance.
process.on("SIGTERM", () => {
  app.close().then(() => process.exit(0));
});
