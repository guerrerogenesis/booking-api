import { execSync } from "node:child_process";
import { testEnv } from "./env.js";

// Creates the test database if needed and applies all migrations.
export default function setup() {
  execSync("npx prisma migrate deploy", { env: { ...process.env, ...testEnv }, stdio: "ignore" });
}
