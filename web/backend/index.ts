import express from "express";
import { PrismaClient } from "@prisma/client";
import crypto from "crypto";
import shopify from "./shopify.js";

const prisma = new PrismaClient();
const app = express();
const port = process.env.PORT || 3002;

app.use(express.json());

// Secure CORS Middleware for cross-origin storefront requests
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (origin.endsWith(".myshopify.com") || origin.includes("localhost") || origin.includes("vercel.app"))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-test-session-id, x-shop-domain");
  res.setHeader("Access-Control-Allow-Credentials", "true");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

const isTestMode = process.env.NODE_ENV === "test";

if (!isTestMode) {
  const REQUIRED_ENV_VARS = [
    "DATABASE_URL",
    "SHOPIFY_API_KEY",
    "SHOPIFY_API_SECRET"
  ];

  const missingVars = REQUIRED_ENV_VARS.filter(v => !process.env[v] || process.env[v].trim() === "");
  if (missingVars.length > 0) {
    console.error("\n==========================================================================");
    console.error("❌ FATAL STARTUP ERROR: Missing Critical Environment Variables! ❌");
    console.error("==========================================================================");
    missingVars.forEach(v => console.error(`  - ${v}`));
    console.error("==========================================================================\n");
    process.exit(1);
  }
}

// 1. Shopify OAuth Authentication Routes
app.get(shopify.config.auth.path, shopify.auth.begin());

app.get(
  shopify.config.auth.callbackPath,
  shopify.auth.callback(),
  shopify.redirectToShopifyOrAppRoot()
);

// 2. Webhooks registration and receiver (Orders & App Webhooks)
app.post(
  shopify.config.webhooks.path,
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const hmac = req.headers["x-shopify-hmac-sha256"] as string;
      const topic = req.headers["x-shopify-topic"] as string;
      const shop = req.headers["x-shopify-shop-domain"] as string;
      
      const verified = crypto
        .createHmac("sha256", process.env.SHOPIFY_API_SECRET || "")
        .update(req.body)
        .digest("base64");

      if (hmac !== verified && !isTestMode) {
        return res.status(401).send("Webhook signature verification failed");
      }

      console.log(`[Shopify Webhook] [Topic: ${topic}] Received webhook from ${shop}`);
      res.sendStatus(200);
    } catch (e: any) {
      res.status(500).send(e.message);
    }
  }
);

// 2.1 Shopify GDPR Compliance Webhooks: Handle customers/redact, customers/data_request, and shop/redact
app.post("/api/webhooks/compliance", express.json(), async (req, res) => {
  const topic = req.headers["x-shopify-topic"] as string;
  const shop = req.headers["x-shopify-shop-domain"] as string;
  const payload = req.body;

  console.log(`[GDPR Webhook] [Topic: ${topic}] Received compliance webhook for ${shop}`);

  try {
    if (topic === "customers/redact") {
      const customerId = payload.customer?.id;
      if (customerId) {
        const customerGid = `gid://shopify/Customer/${customerId}`;
        console.log(`[GDPR Webhook] Redacting customer data for Customer GID: ${customerGid}`);

        // Purge the CustomerProfile (cascade deletes related tables)
        await prisma.customerProfile.deleteMany({
          where: { customerId: customerGid, shop }
        });
      }
    } else if (topic === "shop/redact") {
      console.log(`[GDPR Webhook] Redacting shop data for domain: ${shop}`);

      // Purge all customer profiles and session tokens associated with this merchant
      await prisma.$transaction([
        prisma.customerProfile.deleteMany({ where: { shop } }),
        prisma.session.deleteMany({ where: { shop } })
      ]);
    } else if (topic === "customers/data_request") {
      const customerId = payload.customer?.id;
      console.log(`[GDPR Webhook] Customer data request on Customer: ${customerId}`);
    }

    res.status(200).json({ success: true, message: "Webhook acknowledged successfully." });
  } catch (err: any) {
    console.error(`❌ [GDPR Webhook Error] Failed to process ${topic} webhook:`, err.message);
    res.status(200).json({ success: false, error: err.message });
  }
});

// 3. Protected Dashboard APIs (requires authentication session)
const checkSession = () => {
  if (isTestMode) {
    return (req: any, res: any, next: any) => {
      // Create or locate matching test session in DB for reliable E2E tests
      res.locals.shopify = { session: { id: "beauty-portal-session", shop: "beauty-e2e-shop.myshopify.com", isPremium: true, plan: "STARTER" } };
      next();
    };
  }
  return shopify.validateAuthenticatedSession();
};

app.use("/api/admin/*", checkSession());

// GET /api/admin/customer-profiles
app.get("/api/admin/customer-profiles", async (req, res) => {
  try {
    const session = res.locals.shopify.session;
    const shop = session.shop;

    // Load active session plan dynamically from database
    const dbSession = await prisma.session.findFirst({ where: { shop } });
    const currentPlan = dbSession?.plan || "STARTER";

    const profiles = await prisma.customerProfile.findMany({
      where: { shop },
      include: {
        subscription: true,
        churnRisk: true,
        retentionWorkflows: true
      }
    });

    res.json({ profiles, plan: currentPlan });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/admin/billing (Merchant upgrades/downgrades tier)
app.patch("/api/admin/billing", async (req, res) => {
  try {
    const session = res.locals.shopify.session;
    const { plan } = req.body;

    if (!["STARTER", "PRO", "ENTERPRISE"].includes(plan)) {
      return res.status(400).json({ error: "Invalid plan subscription tier" });
    }

    const updated = await prisma.session.updateMany({
      where: { shop: session.shop },
      data: { plan }
    });

    console.log(`[Billing Upgrade] Shop ${session.shop} transitioned to plan: ${plan}`);
    res.json({ success: true, plan });
  } catch (err: any) {
    res.status(500).json({ error: "Billing transition failed", details: err.message });
  }
});

// POST /api/admin/customer-profiles (Saves quiz responses / preference profiling + checks plan limits)
app.post("/api/admin/customer-profiles", async (req, res) => {
  try {
    const session = res.locals.shopify.session;
    const shop = session.shop;
    const { customerId, name, email, skinType, concerns, fragrancePreference, priceSensitivity } = req.body;

    if (!customerId) {
      return res.status(400).json({ error: "Missing customerId GID" });
    }

    // Load active session plan dynamically from DB
    const dbSession = await prisma.session.findFirst({ where: { shop } });
    const currentPlan = dbSession?.plan || "STARTER";

    // Gating check: enforce profile caps per billing tier
    const count = await prisma.customerProfile.count({ where: { shop } });
    const limit = currentPlan === "STARTER" ? 2000 : (currentPlan === "PRO" ? 20000 : Infinity);

    if (count >= limit && !req.body.id) {
      return res.status(403).json({
        error: "LIMIT_REACHED",
        message: `Plan limit reached (${limit} customer profiles under ${currentPlan} plan). Please upgrade your active tier to unlock further profiles.`,
        plan: currentPlan
      });
    }

    const profile = await prisma.customerProfile.upsert({
      where: { id: req.body.id || "new-profile-uuid" },
      update: {
        name,
        email,
        skinType,
        concerns,
        fragrancePreference,
        priceSensitivity
      },
      create: {
        customerId,
        shop,
        name,
        email,
        skinType,
        concerns,
        fragrancePreference,
        priceSensitivity
      }
    });

    res.json(profile);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/churn-prediction (Dashboard metrics)
app.get("/api/admin/churn-prediction", async (req, res) => {
  try {
    const session = res.locals.shopify.session;
    const shop = session.shop;

    // Load plan dynamically
    const dbSession = await prisma.session.findFirst({ where: { shop } });
    const currentPlan = dbSession?.plan || "STARTER";

    const risks = await prisma.churnRisk.findMany({
      where: { customerProfile: { shop } }
    });

    const summary = {
      atRisk: risks.filter(r => r.status === "AT_RISK").length,
      loyal: risks.filter(r => r.status === "LOYAL").length,
      dormant: risks.filter(r => r.status === "DORMANT").length,
      highValue: risks.filter(r => r.status === "HIGH_VALUE").length,
      totalCount: risks.length
    };

    res.json({ summary, risks, plan: currentPlan });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/curations (Curation recommendations - GATED BEHIND PRO/ENTERPRISE)
app.get("/api/admin/curations", async (req, res) => {
  try {
    const session = res.locals.shopify.session;
    const shop = session.shop;

    const dbSession = await prisma.session.findFirst({ where: { shop } });
    const currentPlan = dbSession?.plan || "STARTER";

    if (currentPlan === "STARTER") {
      return res.status(403).json({
        error: "UPGRADE_REQUIRED",
        message: "AI Curation is locked under the STARTER plan. Please upgrade to PRO or ENTERPRISE to access."
      });
    }

    const curations = await prisma.boxCuration.findMany({
      orderBy: { boxMonth: "desc" }
    });
    res.json(curations);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/curations/:id/accept (Accept recommendations)
app.post("/api/admin/curations/:id/accept", async (req, res) => {
  try {
    const { id } = req.params;
    const { acceptedItems } = req.body;

    const curation = await prisma.boxCuration.update({
      where: { id },
      data: {
        acceptedItems,
        status: "ACCEPTED"
      }
    });

    res.json(curation);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/inventory (Inventory Hero vs Villain metrics - GATED BEHIND PRO/ENTERPRISE)
app.get("/api/admin/inventory", async (req, res) => {
  try {
    const session = res.locals.shopify.session;
    const shop = session.shop;

    const dbSession = await prisma.session.findFirst({ where: { shop } });
    const currentPlan = dbSession?.plan || "STARTER";

    if (currentPlan === "STARTER") {
      return res.status(403).json({
        error: "UPGRADE_REQUIRED",
        message: "Inventory Retention Analytics are locked under the STARTER plan. Please upgrade to PRO or ENTERPRISE to access."
      });
    }

    const analytics = await prisma.inventoryAnalytics.findMany({
      orderBy: { retentionValue: "desc" }
    });
    res.json(analytics);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/curations/create-sample-data (Initial populator for sandbox testing)
app.post("/api/admin/curations/create-sample-data", async (req, res) => {
  try {
    const session = res.locals.shopify.session;
    const shop = session.shop;

    // Purge existing data to avoid primary key constraints
    await prisma.customerProfile.deleteMany({ where: { shop } });
    await prisma.boxCuration.deleteMany({});
    await prisma.inventoryAnalytics.deleteMany({});

    // 1. Create Sample Profiles & Risks
    await prisma.customerProfile.create({
      data: {
        customerId: "gid://shopify/Customer/1001",
        shop,
        name: "Jessica Alchemist",
        email: "jessica@alchemistbeauty.com",
        skinType: "dry",
        concerns: ["aging", "dryness"],
        fragrancePreference: "floral",
        priceSensitivity: "low",
        subscription: {
          create: {
            status: "ACTIVE",
            tier: "ENTERPRISE",
            skipCount: 2
          }
        },
        churnRisk: {
          create: {
            riskScore: 82.5,
            status: "AT_RISK",
            flaggedReasons: ["skipped last 2 boxes", "unopened emails"]
          }
        }
      }
    });

    await prisma.customerProfile.create({
      data: {
        customerId: "gid://shopify/Customer/1002",
        shop,
        name: "Rohit Clay",
        email: "rohit@claycosmetics.com",
        skinType: "oily",
        concerns: ["acne", "redness"],
        fragrancePreference: "none",
        priceSensitivity: "medium",
        subscription: {
          create: {
            status: "ACTIVE",
            tier: "PRO",
            skipCount: 0
          }
        },
        churnRisk: {
          create: {
            riskScore: 12.0,
            status: "LOYAL",
            flaggedReasons: []
          }
        }
      }
    });

    // 2. Create Box Curation recommendations
    await prisma.boxCuration.create({
      data: {
        subscriptionTier: "PRO",
        boxMonth: "2026-09",
        status: "SUGGESTED",
        margin: 55.4,
        suggestedItems: [
          { variantId: "gid://shopify/ProductVariant/5001", score: 95, reason: "Matches dry skin concern + High repeat purchase" },
          { variantId: "gid://shopify/ProductVariant/5002", score: 88, reason: "Sourced locally, maintains 55% target margins" }
        ]
      }
    });

    // 3. Create Inventory Analytics
    await prisma.inventoryAnalytics.createMany({
      data: [
        {
          productId: "Vitamin C Serum (9001)",
          retentionValue: 84.6,
          returnRate: 2.1,
          satisfaction: 4.8,
          margin: 62.0,
          stockLevel: 1200,
          stockRisk: "LOW"
        },
        {
          productId: "Charcoal Face Mask (9002)",
          retentionValue: 14.2,
          returnRate: 35.8,
          satisfaction: 2.3,
          margin: 38.0,
          stockLevel: 2500,
          stockRisk: "HIGH"
        }
      ]
    });

    res.json({ success: true, message: "Sample beauty data populated!" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Serve the beautiful embedded App UI Dashboard
app.get("/", (req, res) => {
  const shop = req.query.shop as string;
  const apiKey = process.env.SHOPIFY_API_KEY || "";

  if (shop && shop.endsWith(".myshopify.com")) {
    const sanitizedShop = encodeURIComponent(shop);
    res.setHeader(
      "Content-Security-Policy",
      `frame-ancestors https://${sanitizedShop} https://admin.shopify.com;`
    );
  } else {
    res.setHeader(
      "Content-Security-Policy",
      "frame-ancestors https://admin.shopify.com https://*.myshopify.com;"
    );
  }
  res.removeHeader("X-Frame-Options");

  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Beauty Subscription Optimizer — Merchant Hub</title>
  <meta name="shopify-api-key" content="${apiKey}" />
  <script>
    // Self-healing App Bridge Handshake snippet
    (function() {
      const urlParams = new URLSearchParams(window.location.search);
      const shop = urlParams.get("shop");
      const host = urlParams.get("host");

      if (window.top === window.self && shop) {
        const shopName = shop.split(".")[0];
        console.warn("[Glow Retention] App accessed outside iframe. Redirecting to Shopify Admin...");
        window.location.href = "https://admin.shopify.com/store/" + shopName + "/apps/${apiKey}";
        return;
      }

      if (window.top !== window.self && !host && shop) {
        const shopName = shop.split(".")[0];
        console.warn("[Glow Retention] Missing critical 'host' parameter inside iframe. Forcing self-healing redirect to Shopify Admin...");
        window.parent.location.href = "https://admin.shopify.com/store/" + shopName + "/apps/${apiKey}";
      }
    })();
  </script>
  <!-- Load Shopify Polaris CSS for official merchant look & feel -->
  <link rel="stylesheet" href="https://unpkg.com/@shopify/polaris@12.0.0/build/esm/styles.css">
  <style>
    body {
      background-color: #f6f6f7;
      margin: 0;
      padding: 20px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    .badge {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: bold;
    }
    .badge-atrisk { background-color: #ffebe9; color: #ff0000; border: 1px solid #ffd0cc; }
    .badge-loyal { background-color: #e3fcef; color: #00875a; border: 1px solid #abf5d1; }
    .card {
      background-color: #ffffff;
      border-radius: 8px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
      padding: 16px;
      margin-bottom: 16px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
      margin-bottom: 20px;
    }
    .metric {
      font-size: 28px;
      font-weight: bold;
      color: #202223;
      margin-top: 8px;
    }
    .tab-header {
      display: flex;
      border-bottom: 1px solid #e1e3e5;
      margin-bottom: 20px;
    }
    .tab {
      padding: 12px 16px;
      cursor: pointer;
      font-weight: 500;
      color: #6d7175;
    }
    .tab.active {
      border-bottom: 2px solid #008060;
      color: #008060;
    }
    .button-primary {
      background-color: #008060;
      color: #ffffff;
      border: none;
      padding: 8px 16px;
      border-radius: 4px;
      cursor: pointer;
      font-weight: 500;
    }
    .button-primary:hover {
      background-color: #006e50;
    }
    .button-secondary {
      background-color: #ffffff;
      color: #202223;
      border: 1px solid #8c9196;
      padding: 8px 16px;
      border-radius: 4px;
      cursor: pointer;
      font-weight: 500;
    }
    .button-secondary:hover {
      background-color: #f6f6f7;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 12px;
    }
    th, td {
      text-align: left;
      padding: 12px;
      border-bottom: 1px solid #e1e3e5;
    }
    th {
      color: #202223;
      font-weight: 600;
    }
    .paywall-locked {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 60px 20px;
      text-align: center;
    }
    .paywall-title {
      font-size: 20px;
      font-weight: bold;
      color: #202223;
      margin-top: 16px;
      margin-bottom: 8px;
    }
    .paywall-desc {
      font-size: 14px;
      color: #6d7175;
      max-width: 480px;
      margin-bottom: 24px;
    }
  </style>
</head>
<body>
  <div id="app"></div>

  <!-- Load App Bridge, React, and ReactDOM -->
  <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
  <script src="https://unpkg.com/react@18/umd/react.development.js"></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>

  <script>
    const e = React.createElement;

    function App() {
      const [appBridgeReady, setAppBridgeReady] = React.useState(false);

      React.useEffect(() => {
        if (window.shopify && window.shopify.ready) {
          window.shopify.ready.then(() => {
            setAppBridgeReady(true);
          });
        } else {
          setAppBridgeReady(true);
        }
      }, []);

      const [activeTab, setActiveTab] = React.useState("churn");
      const [plan, setPlan] = React.useState("STARTER");
      const [metrics, setMetrics] = React.useState({ atRisk: 1, loyal: 1, dormant: 0, highValue: 0, totalCount: 2 });
      const [profiles, setProfiles] = React.useState([
        {
          id: "p1",
          name: "Jessica Alchemist",
          email: "jessica@alchemistbeauty.com",
          skinType: "dry",
          concerns: ["aging", "dryness"],
          churnRisk: { riskScore: 82.5, status: "AT_RISK", flaggedReasons: ["skipped last 2 boxes", "unopened emails"] },
          subscription: { tier: "ENTERPRISE", status: "ACTIVE" }
        },
        {
          id: "p2",
          name: "Rohit Clay",
          email: "rohit@claycosmetics.com",
          skinType: "oily",
          concerns: ["acne", "redness"],
          churnRisk: { riskScore: 12.0, status: "LOYAL", flaggedReasons: [] },
          subscription: { tier: "PRO", status: "ACTIVE" }
        }
      ]);

      const [curations, setCurations] = React.useState([
        {
          id: "c1",
          subscriptionTier: "PRO",
          boxMonth: "2026-09",
          status: "SUGGESTED",
          margin: 55.4,
          suggestedItems: [
            { variantId: "gid://shopify/ProductVariant/5001", score: 95, reason: "Matches dry skin concern + High repeat purchase" },
            { variantId: "gid://shopify/ProductVariant/5002", score: 88, reason: "Sourced locally, maintains 55% target margins" }
          ]
        }
      ]);

      const [inventory, setInventory] = React.useState([
        { productId: "Vitamin C Serum (9001)", retentionValue: 84.6, returnRate: 2.1, satisfaction: 4.8, margin: 62.0, stockLevel: 1200, stockRisk: "LOW" },
        { productId: "Charcoal Face Mask (9002)", retentionValue: 14.2, returnRate: 35.8, satisfaction: 2.3, margin: 38.0, stockLevel: 2500, stockRisk: "HIGH" }
      ]);

      const [quizSkinType, setQuizSkinType] = React.useState("dry");
      const [quizConcerns, setQuizConcerns] = React.useState(["aging"]);
      const [quizFragrance, setQuizFragrance] = React.useState("floral");
      const [quizPrice, setQuizPrice] = React.useState("low");

      const [notification, setNotification] = React.useState(null);

      const triggerSampleSeeding = () => {
        fetch("/api/admin/curations/create-sample-data", {
          method: "POST"
        })
        .then(res => res.json())
        .then(data => {
          setNotification("Sample Beauty subscription data loaded successfully!");
          refreshAllData();
        })
        .catch(err => console.error("Error seeding data:", err));
      };

      const handleCurationAccept = (id) => {
        fetch("/api/admin/curations/" + id + "/accept", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ acceptedItems: [{ variantId: "gid://shopify/ProductVariant/5001" }] })
        })
        .then(res => res.json())
        .then(() => {
          setNotification("AI Curation recommendations accepted successfully!");
          setCurations(curations.map(c => c.id === id ? { ...c, status: "ACCEPTED" } : c));
        });
      };

      const handleSaveQuizProfile = () => {
        fetch("/api/admin/customer-profiles", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            customerId: "gid://shopify/Customer/1003",
            name: "Self Tested Beauty",
            email: "tested@beauty.com",
            skinType: quizSkinType,
            concerns: quizConcerns,
            fragrancePreference: quizFragrance,
            priceSensitivity: quizPrice
          })
        })
        .then(res => {
          if (res.status === 403) {
            return res.json().then(err => { throw new Error(err.message); });
          }
          return res.json();
        })
        .then(profile => {
          setNotification("Preference quiz profile saved successfully to database!");
          refreshAllData();
        })
        .catch(err => {
          setNotification("⚠️ Error saving profile: " + err.message);
        });
      };

      const handleUpgradeBilling = (targetPlan) => {
        fetch("/api/admin/billing", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ plan: targetPlan })
        })
        .then(res => res.json())
        .then(data => {
          if (data.success) {
            setPlan(data.plan);
            setNotification("Plan upgraded successfully to " + data.plan + "!");
            refreshAllData();
          }
        })
        .catch(err => console.error("Billing upgrade failed:", err));
      };

      const refreshAllData = () => {
        fetch("/api/admin/customer-profiles")
          .then(res => res.json())
          .then(data => {
            if (data && data.profiles) setProfiles(data.profiles);
            if (data && data.plan) setPlan(data.plan);
          })
          .catch(() => {});
        fetch("/api/admin/churn-prediction")
          .then(res => res.json())
          .then(data => {
            if (data && data.summary) setMetrics(data.summary);
            if (data && data.plan) setPlan(data.plan);
          })
          .catch(() => {});
        fetch("/api/admin/curations")
          .then(res => {
            if (res.status === 403) return [];
            return res.json();
          })
          .then(data => { if (data && data.length > 0) setCurations(data); })
          .catch(() => {});
        fetch("/api/admin/inventory")
          .then(res => {
            if (res.status === 403) return [];
            return res.json();
          })
          .then(data => { if (data && data.length > 0) setInventory(data); })
          .catch(() => {});
      };

      React.useEffect(() => {
        if (appBridgeReady) {
          refreshAllData();
        }
      }, [appBridgeReady]);

      const renderHeader = () => {
        return e("div", null,
          e("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" } },
            e("div", null,
              e("h1", { style: { fontSize: "24px", fontWeight: "600", margin: 0 } }, "Beauty Subscription Optimizer"),
              e("p", { style: { color: "#6d7175", margin: "4px 0 0 0" } }, "Predict churn, optimize curation, and maximize subscriber LTV with AI.")
            ),
            e("div", { style: { display: "flex", gap: "8px" } },
              e("button", { className: "button-secondary", onClick: triggerSampleSeeding }, "Seed Demo Data")
            )
          ),
          // Billing paywall notification banner
          e("div", { className: "card", style: { backgroundColor: "#f0f4ff", border: "1px solid #1c3d5a", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px" } },
            e("div", null,
              e("span", { style: { fontWeight: "bold" } }, "Merchant Subscription Plan: "),
              e("span", { className: "badge", style: { backgroundColor: plan === "STARTER" ? "#e2e8f0" : (plan === "PRO" ? "#feebc8" : "#e0f2fe"), color: plan === "STARTER" ? "#4a5568" : (plan === "PRO" ? "#c05621" : "#2b6cb0") } }, plan),
              e("span", { style: { marginLeft: "12px", fontSize: "13px", color: "#6d7175" } },
                plan === "STARTER" ? "Unique Customers capped at 2,000. AI Curation and Inventory Locked." :
                (plan === "PRO" ? "Unique Customers capped at 20,000. All standard optimization modules active." : "Enterprise Tier: Unlimited scale, high-performance models active.")
              )
            ),
            e("div", { style: { display: "flex", gap: "8px" } },
              plan === "STARTER" && e("button", { className: "button-primary", onClick: () => handleUpgradeBilling("PRO") }, "Upgrade to Pro ($800/mo)"),
              plan === "PRO" && e("button", { className: "button-primary", onClick: () => handleUpgradeBilling("ENTERPRISE") }, "Go Enterprise ($2k/mo)"),
              plan !== "STARTER" && e("button", { className: "button-secondary", onClick: () => handleUpgradeBilling("STARTER") }, "Downgrade to Starter")
            )
          )
        );
      };

      const renderTabs = () => {
        return e("div", { className: "tab-header" },
          e("div", { className: "tab " + (activeTab === "churn" ? "active" : ""), onClick: () => setActiveTab("churn") }, "🔮 Churn Prediction Dashboard"),
          e("div", { className: "tab " + (activeTab === "curation" ? "active" : ""), onClick: () => setActiveTab("curation") }, "🎨 AI Box Curation"),
          e("div", { className: "tab " + (activeTab === "inventory" ? "active" : ""), onClick: () => setActiveTab("inventory") }, "📊 Inventory Analytics"),
          e("div", { className: "tab " + (activeTab === "quiz" ? "active" : ""), onClick: () => setActiveTab("quiz") }, "📋 Subscription Preference Quiz")
        );
      };

      const renderChurnTab = () => {
        return e("div", null,
          e("div", { className: "grid" },
            e("div", { className: "card" },
              e("div", { style: { color: "#6d7175", fontSize: "14px" } }, "At-Risk Subscribers"),
              e("div", { className: "metric", style: { color: "#ff0000" } }, metrics.atRisk)
            ),
            e("div", { className: "card" },
              e("div", { style: { color: "#6d7175", fontSize: "14px" } }, "Loyal Subscribers"),
              e("div", { className: "metric", style: { color: "#00875a" } }, metrics.loyal)
            ),
            e("div", { className: "card" },
              e("div", { style: { color: "#6d7175", fontSize: "14px" } }, "Dormant / Paused"),
              e("div", { className: "metric" }, metrics.dormant)
            ),
            e("div", { className: "card" },
              e("div", { style: { color: "#6d7175", fontSize: "14px" } }, "High-Value Segments"),
              e("div", { className: "metric", style: { color: "#2b6cb0" } }, metrics.highValue)
            )
          ),
          e("div", { className: "card" },
            e("h3", { style: { fontSize: "16px", fontWeight: "600", marginBottom: "12px" } }, "Subscribers Under Risk Auditing"),
            e("table", null,
              e("thead", null,
                e("tr", null,
                  e("th", null, "Subscriber"),
                  e("th", null, "Tier"),
                  e("th", null, "Churn Probability"),
                  e("th", null, "Primary Flagged Reasons"),
                  e("th", null, "Status")
                )
              ),
              e("tbody", null,
                profiles.map(p => {
                  const score = p.churnRisk ? p.churnRisk.riskScore : 0;
                  const scoreColor = score > 50 ? "#ff0000" : "#00875a";
                  const reasons = p.churnRisk ? p.churnRisk.flaggedReasons.join(", ") || "None" : "None";
                  const status = p.churnRisk ? p.churnRisk.status : "LOYAL";
                  return e("tr", { key: p.id },
                    e("td", null,
                      e("div", { style: { fontWeight: "500" } }, p.name),
                      e("div", { style: { fontSize: "12px", color: "#6d7175" } }, p.email)
                    ),
                    e("td", null, p.subscription ? p.subscription.tier : "STARTER"),
                    e("td", { style: { color: scoreColor, fontWeight: "bold" } }, score + "%"),
                    e("td", { style: { color: "#6d7175", fontSize: "13px" } }, reasons),
                    e("td", null,
                      e("span", { className: "badge badge-" + status.toLowerCase().replace("_", "") }, status)
                    )
                  );
                })
              )
            )
          )
        );
      };

      const renderCurationTab = () => {
        if (plan === "STARTER") {
          return e("div", { className: "card paywall-locked" },
            e("div", { style: { fontSize: "40px" } }, "🔒"),
            e("div", { className: "paywall-title" }, "AI Curation Suggestions Locked"),
            e("div", { className: "paywall-desc" }, "The Predictive Curation Engine is a Premium module that automatically matches subscribers skin profiles, ratings, and repeat margins. Upgrade to the Pro or Enterprise plan to unlock instant curations!"),
            e("button", { className: "button-primary", onClick: () => handleUpgradeBilling("PRO") }, "Upgrade to PRO Plan")
          );
        }

        return e("div", null,
          e("div", { className: "card" },
            e("h3", { style: { fontSize: "16px", fontWeight: "600", marginBottom: "12px" } }, "AI-Curated Box Suggestions (Next Cycle)"),
            curations.map(c => {
              return e("div", { key: c.id, style: { borderBottom: "1px solid #e1e3e5", paddingBottom: "16px", marginBottom: "16px" } },
                e("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
                  e("div", null,
                    e("span", { style: { fontWeight: "bold", fontSize: "15px" } }, "Month: " + c.boxMonth + " — Tier: " + c.subscriptionTier),
                    e("span", { style: { marginLeft: "12px", color: "#00875a", fontSize: "13px" } }, "Predicted Margin: " + c.margin + "%")
                  ),
                  e("div", null,
                    c.status === "SUGGESTED"
                      ? e("div", { style: { display: "flex", gap: "8px" } },
                          e("button", { className: "button-primary", onClick: () => handleCurationAccept(c.id) }, "Accept Suggestions"),
                          e("button", { className: "button-secondary" }, "Regenerate")
                        )
                      : e("span", { className: "badge badge-loyal" }, "APPROVED & LOCKED")
                  )
                ),
                e("table", null,
                  e("thead", null,
                    e("tr", null,
                      e("th", null, "Variant GID"),
                      e("th", null, "AI Confidence Score"),
                      e("th", null, "Recommendation Logic")
                    )
                  ),
                  e("tbody", null,
                    (typeof c.suggestedItems === "string" ? JSON.parse(c.suggestedItems) : c.suggestedItems).map((item, idx) => {
                      return e("tr", { key: idx },
                        e("td", { style: { fontFamily: "monospace", fontSize: "13px" } }, item.variantId),
                        e("td", { style: { fontWeight: "600" } }, item.score + "%"),
                        e("td", { style: { color: "#6d7175" } }, item.reason)
                      );
                    })
                  )
                )
              );
            })
          )
        );
      };

      const renderInventoryTab = () => {
        if (plan === "STARTER") {
          return e("div", { className: "card paywall-locked" },
            e("div", { style: { fontSize: "40px" } }, "🔒"),
            e("div", { className: "paywall-title" }, "Inventory Retention Analytics Locked"),
            e("div", { className: "paywall-desc" }, "Identify product retention metrics and discover stock risks instantly. Upgrade your merchant account plan to PRO or ENTERPRISE to access real-time inventory performance insights!"),
            e("button", { className: "button-primary", onClick: () => handleUpgradeBilling("PRO") }, "Upgrade to PRO Plan")
          );
        }

        return e("div", null,
          e("div", { className: "card" },
            e("h3", { style: { fontSize: "16px", fontWeight: "600", marginBottom: "12px" } }, "Product Retention vs Villain Analysis"),
            e("table", null,
              e("thead", null,
                e("tr", null,
                  e("th", null, "Product ID / Name"),
                  e("th", null, "Retention Value"),
                  e("th", null, "Return Rate"),
                  e("th", null, "Avg Rating"),
                  e("th", null, "Profit Margin"),
                  e("th", null, "Stock Level"),
                  e("th", null, "Stock Risk")
                )
              ),
              e("tbody", null,
                inventory.map((inv, idx) => {
                  const riskColor = inv.stockRisk === "HIGH" ? "#ff0000" : "#00875a";
                  return e("tr", { key: idx },
                    e("td", { style: { fontWeight: "500" } }, inv.productId),
                    e("td", { style: { color: "#00875a", fontWeight: "600" } }, inv.retentionValue + "%"),
                    e("td", { style: { color: inv.returnRate > 20 ? "#ff0000" : "inherit" } }, inv.returnRate + "%"),
                    e("td", null, inv.satisfaction + " / 5"),
                    e("td", null, inv.margin + "%"),
                    e("td", null, inv.stockLevel),
                    e("td", { style: { color: riskColor, fontWeight: "bold" } }, inv.stockRisk)
                  );
                })
              )
            )
          )
        );
      };

      const renderQuizTab = () => {
        return e("div", null,
          e("div", { className: "card" },
            e("h3", { style: { fontSize: "16px", fontWeight: "600", marginBottom: "12px" } }, "Simulated Storefront Preference Quiz (Phase 3)"),
            e("p", { style: { color: "#6d7175", marginBottom: "20px" } }, "This preference profile is embedded at signup or sent via surveys to build customer metadata."),
            e("div", { style: { marginBottom: "16px" } },
              e("label", { style: { display: "block", fontWeight: "bold", marginBottom: "6px" } }, "Skin Type"),
              e("select", { value: quizSkinType, onChange: (e) => setQuizSkinType(e.target.value), style: { width: "100%", padding: "8px", borderRadius: "4px", border: "1px solid #8c9196" } },
                e("option", { value: "dry" }, "Dry / Dehydrated"),
                e("option", { value: "oily" }, "Oily / Acne-Prone"),
                e("option", { value: "sensitive" }, "Sensitive / Redness-Prone"),
                e("option", { value: "combination" }, "Combination")
              )
            ),
            e("div", { style: { marginBottom: "16px" } },
              e("label", { style: { display: "block", fontWeight: "bold", marginBottom: "6px" } }, "Fragrance Preference"),
              e("select", { value: quizFragrance, onChange: (e) => setQuizFragrance(e.target.value), style: { width: "100%", padding: "8px", borderRadius: "4px", border: "1px solid #8c9196" } },
                e("option", { value: "floral" }, "Floral / Sweet"),
                e("option", { value: "citrus" }, "Citrus / Fresh"),
                e("option", { value: "none" }, "Unscented / No Fragrance")
              )
            ),
            e("div", { style: { marginBottom: "16px" } },
              e("label", { style: { display: "block", fontWeight: "bold", marginBottom: "6px" } }, "Price Sensitivity"),
              e("select", { value: quizPrice, onChange: (e) => setQuizPrice(e.target.value), style: { width: "100%", padding: "8px", borderRadius: "4px", border: "1px solid #8c9196" } },
                e("option", { value: "low" }, "Value-Driven (Low)"),
                e("option", { value: "medium" }, "Balanced (Medium)"),
                e("option", { value: "high" }, "Luxury / Premium (High)")
              )
            ),
            e("button", { className: "button-primary", onClick: handleSaveQuizProfile }, "Save Quiz Profile to DB")
          )
        );
      };

      return e("div", null,
        renderHeader(),
        notification && e("div", { className: "card", style: { marginTop: "16px", backgroundColor: "#e2f1e8", color: "#1e5128", border: "1px solid #b8dfc4", display: "flex", justifyContent: "space-between" } },
          e("span", null, notification),
          e("span", { style: { cursor: "pointer", fontWeight: "bold" }, onClick: () => setNotification(null) }, "✕")
        ),
        e("div", { style: { marginTop: "20px" } },
          renderTabs(),
          activeTab === "churn" && renderChurnTab(),
          activeTab === "curation" && renderCurationTab(),
          activeTab === "inventory" && renderInventoryTab(),
          activeTab === "quiz" && renderQuizTab()
        )
      );
    }

    const root = ReactDOM.createRoot(document.getElementById("app"));
    root.render(e(App));
  </script>
</body>
</html>
  `);
});

app.listen(port, () => {
  console.log(`[Beauty Subscription Optimizer App] Booted successfully on port ${port}!`);
});

export default app;
