const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const appDir = path.join(__dirname, "..");

// 1. Resolve environment variables from local .env
const env = { ...process.env };
const p = path.join(appDir, ".env");

if (fs.existsSync(p)) {
  const envContent = fs.readFileSync(p, "utf8");
  const lines = envContent.split(String.fromCharCode(10));
  lines.forEach(l => {
    const t = l.trim();
    if (t && !t.startsWith("#") && !t.startsWith("//") && t.includes("=")) {
      const parts = t.split("=");
      const key = parts[0].trim();
      let val = parts.slice(1).join("=").trim();
      if (val.startsWith('"') || val.startsWith("'")) val = val.substring(1, val.length - 1);
      env[key] = val;
    }
  });
}

// 2. Set database URL schema parameter if resolved
if (env.DATABASE_URL && (env.DATABASE_URL !== "[SENSITIVE]" && env.DATABASE_URL !== "SENSITIVE")) {
  try {
    const u = new URL(env.DATABASE_URL);
    u.searchParams.set("schema", "beauty_subscription_optimizer");
    env.DATABASE_URL = u.toString();
  } catch (e) {}
}

// 3. Smart Config Selector: Parse process.argv for --config flag (Defaults to Dev config)
let hasConfigFlag = process.argv.includes("--config") || process.argv.join(" ").includes("--config");
let configName = "shopify.app.dev.toml"; // Default to dev configuration

const configArgIdx = process.argv.indexOf("--config");
if (configArgIdx !== -1 && process.argv[configArgIdx + 1]) {
  const val = process.argv[configArgIdx + 1].trim();
  configName = (val === "prod" || val === "production") ? "shopify.app.toml" : `shopify.app.${val}.toml`;
} else {
  const rawArgString = process.argv.join(" ");
  const match = rawArgString.match(/--config\s+(\S+)/);
  if (match) {
    const val = match[1].trim();
    configName = (val === "prod" || val === "production") ? "shopify.app.toml" : `shopify.app.${val}.toml`;
  }
}

// 4. Resolve client_id from env or selected toml configuration
let clientID = env.SHOPIFY_API_KEY || "";
const tomlPath = path.join(appDir, configName);

if (!clientID && fs.existsSync(tomlPath)) {
  const tomlContent = fs.readFileSync(tomlPath, "utf8");
  const match = tomlContent.match(/client_id\s*=\s*["']([^"']*)["']/);
  if (match) clientID = match[1].trim();
}

// 5. Dynamic Auto-Sync: If selected TOML has empty client_id but we have SHOPIFY_API_KEY, auto-fill it!
if (clientID && fs.existsSync(tomlPath)) {
  let tomlContent = fs.readFileSync(tomlPath, "utf8");
  const match = tomlContent.match(/client_id\s*=\s*["']([^"']*)["']/);
  const currentId = match ? match[1].trim() : "";

  if (!currentId || currentId === "") {
    console.log(`[Deploy Script] Automatically synchronizing ${configName}'s client_id with SHOPIFY_API_KEY: ${clientID}`);
    if (tomlContent.includes("client_id =")) {
      tomlContent = tomlContent.replace(/client_id\s*=\s*["']([^"']*)["']/, `client_id = "${clientID}"`);
    } else {
      tomlContent = `client_id = "${clientID}"\n` + tomlContent;
    }
    fs.writeFileSync(tomlPath, tomlContent, "utf8");
  }
}

if (!clientID) {
  console.log("\n==========================================================================");
  console.log("⚠️  Shopify App Deployment Notice: Credentials Not Configured Yet ⚠️");
  console.log("==========================================================================");
  console.log("To deploy Paws & Effect live to Shopify Partners, please do the following:");
  console.log("1. Go to your Shopify Partner Dashboard (partners.shopify.com).");
  console.log("2. Click 'Apps' ➔ 'Create app' to register a new App.");
  console.log("3. Copy your 'Client ID' from your App Settings.");
  console.log("4. Paste your Client ID into your project file:");
  console.log(`   - Inside: /apps/${path.basename(appDir)}/${configName} as: client_id = "your-id"`);
  console.log(`   - OR inside your local .env file as: SHOPIFY_API_KEY="your-id"`);
  console.log("5. Re-run your deploy command!");
  console.log("==========================================================================\n");
  console.log(`[Deploy Script] Skipping deployment (No client_id configured in ${configName}). Exit 0.`);
  process.exit(0); // Graceful exit
}

try {
  // Extract and forward any additional CLI flags, defaulting explicitly to dev configuration if none passed
  let forwardedArgs = process.argv.slice(2).join(" ");
  if (!hasConfigFlag) {
    forwardedArgs = `${forwardedArgs} --config dev`.trim();
  }

  const runCommand = `shopify app deploy --allow-updates ${forwardedArgs}`;
  console.log(`[Deploy Script] Spawning: ${runCommand}`);
  execSync(runCommand, { stdio: "inherit", env, cwd: appDir });
} catch (err) {
  console.error("[Deploy Script Error] Deployment failed:", err.message);
  process.exit(1);
}
