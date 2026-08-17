import { defineConfig, devices } from "@playwright/test";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load local .env variables natively before E2E tests run
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, "utf8").split(String.fromCharCode(10));
  lines.forEach(l => {
    const t = l.trim();
    if (t && !t.startsWith("#") && !t.startsWith("//") && t.includes("=")) {
      const parts = t.split("=");
      const key = parts[0].trim();
      let val = parts.slice(1).join("=").trim();
      if (val.startsWith('"') || val.startsWith("'")) val = val.substring(1, val.length - 1);
      process.env[key] = val;
    }
  });
}

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./test-results", // Explicitly compile test trace/result results locally
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [["html", { outputFolder: "./playwright-report", open: "never" }]], // Explicitly write HTML reports locally
  use: {
    baseURL: "http://localhost:3002", // Distinct local port to avoid conflicts with other apps
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Automatically spin up the backend server before running E2E tests
  webServer: {
    command: "NODE_ENV=test PORT=3002 npm start",
    cwd: __dirname,
    port: 3002,
    reuseExistingServer: !process.env.CI,
  },
});
