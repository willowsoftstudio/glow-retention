const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const appDir = path.join(__dirname, "..");

// 1. Resolve DATABASE_URL from environment or local .env file
let r = process.env.DATABASE_URL || process.env.POSTGRES_URL_NON_POOLING || process.env.PRISMA_DATABASE_URL || process.env.POSTGRES_PRISMA_URL || process.env.POSTGRES_URL;

// If the environment contains censored/masked credentials from the CLI test runner, treat it as empty to force local .env fallback
if (r === "[SENSITIVE]" || r === "SENSITIVE") {
  r = "";
}

// We check the local project directory .env strictly to avoid root-level leakage
const p = path.join(appDir, ".env");

if (!r && fs.existsSync(p)) {
  const envContent = fs.readFileSync(p, "utf8");
  const lines = envContent.split(String.fromCharCode(10));
  const dLine = lines.find(l => {
    const trimmed = l.trim();
    return trimmed.startsWith("DATABASE_URL") && !trimmed.startsWith("#") && !trimmed.startsWith("//");
  });
  if (dLine) {
    let val = dLine.split("=").slice(1).join("=").trim();
    if (val.startsWith(String.fromCharCode(34)) || val.startsWith(String.fromCharCode(39))) val = val.substring(1, val.length - 1);
    r = val.split(String.fromCharCode(13))[0].trim();
  }
}

// 2. Append the schema parameter if a valid URL is resolved
if (r) {
  try {
    const u = new URL(r);
    u.searchParams.set("schema", "beauty_subscription_optimizer");
    r = u.toString();
  } catch (e) {
    // If not a parseable URL, keep it as-is
  }
}

// 3. Set the resolved DATABASE_URL in the environment and run the postinstall steps inside the app directory
const env = { ...process.env };
if (r) {
  env.DATABASE_URL = r;
}

try {
  // Run Prisma Generate
  console.log("[Postinstall Script] Running prisma generate...");
  execSync("prisma generate", { stdio: "inherit", env, cwd: appDir });
} catch (err) {
  console.error("[Postinstall Script Error] Postinstall failed:", err.message);
  process.exit(1);
}
