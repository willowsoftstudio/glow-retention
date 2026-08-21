import express from "express";
import { PrismaClient } from "./prisma-client/index.js";
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

    let shopifyCustomers = [];
    try {
      const client = new shopify.api.clients.Graphql({ session });
      const response = await client.request(
        `query {
          customers(first: 50) {
            edges {
              node {
                id
                displayName
                email
              }
            }
          }
        }`
      );
      const edges = (response as any).data?.customers?.edges || [];
      shopifyCustomers = edges.map((edge: any) => ({
        id: edge.node.id,
        name: edge.node.displayName || "Anonymous Customer",
        email: edge.node.email || ""
      }));
    } catch (gqlErr: any) {
      console.warn("[GraphQL Warning] Failed to fetch customers from Shopify:", gqlErr.message);
      shopifyCustomers = [
        { id: "gid://shopify/Customer/1001", name: "Jessica Alchemist", email: "jessica@alchemistbeauty.com" },
        { id: "gid://shopify/Customer/1002", name: "Rohit Clay", email: "rohit@claycosmetics.com" }
      ];
    }

    res.json({ profiles, shopifyCustomers, plan: currentPlan });
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

  // Storefront Session Loader (For Customer Storefront-facing Routes - No Admin Auth required!)
  async function validateStorefrontSession(req: express.Request, res: express.Response, next: express.NextFunction) {
    if (isTestMode) {
      const sessionId = req.headers["x-test-session-id"] as string || "beauty-portal-session";
      const shop = req.headers["x-shop-domain"] as string || "beauty-e2e-shop.myshopify.com";
      try {
        let session = await prisma.session.findUnique({ where: { id: sessionId } });
        if (!session) {
          session = await prisma.session.create({
            data: {
              id: sessionId,
              shop,
              state: "active_mock",
              accessToken: "mock_token",
              plan: "STARTER"
            }
          });
        }
        req.body.session = session;
        return next();
      } catch (err: any) {
        return res.status(500).json({ error: "Test session storage error", details: err.message });
      }
    }

    const shop = req.headers["x-shop-domain"] as string || req.query.shop as string || "test-shop.myshopify.com";
    try {
      let session = await prisma.session.findFirst({ where: { shop } });
      if (!session) {
        session = await prisma.session.create({
          data: {
            id: `storefront_${shop}`,
            shop,
            state: "storefront_active",
            accessToken: "mock_token",
            plan: "STARTER"
          }
        });
      }
      req.body.session = session;
      next();
    } catch (err: any) {
      res.status(500).json({ error: "Storefront validation failed", details: err.message });
    }
  }

  // POST /api/storefront/customer-profiles (Saves quiz responses directly from customer storefront - no admin auth)
  app.post("/api/storefront/customer-profiles", validateStorefrontSession, async (req, res) => {
    try {
      const session = req.body.session;
      const shop = session.shop;
      const {
        customerId,
        name,
        email,
        skinType,
        concerns,
        fragrancePreference,
        priceSensitivity,
        preferredCategories,
        ethicalPreferences,
        hairType,
        localClimate,
        zipCode,
        allergens
      } = req.body;

      if (!customerId) {
        return res.status(400).json({ error: "Missing customerId GID" });
      }

      const count = await prisma.customerProfile.count({ where: { shop } });
      const limit = session.plan === "STARTER" ? 2000 : (session.plan === "PRO" ? 20000 : Infinity);

      if (count >= limit && !req.body.id) {
        return res.status(403).json({
          error: "LIMIT_REACHED",
          message: `Plan limit reached (${limit} customer profiles under ${session.plan} plan). Please contact the store owner to upgrade.`
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
          priceSensitivity,
          preferredCategories,
          ethicalPreferences,
          hairType,
          localClimate,
          zipCode,
          allergens
        },
        create: {
          customerId,
          shop,
          name,
          email,
          skinType,
          concerns,
          fragrancePreference,
          priceSensitivity,
          preferredCategories,
          ethicalPreferences,
          hairType,
          localClimate,
          zipCode,
          allergens
        }
      });

      res.json({ success: true, profile });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

// POST /api/admin/customer-profiles (Saves quiz responses / preference profiling + checks plan limits)
// POST /api/admin/customer-profiles (Saves quiz responses / preference profiling + checks plan limits)
app.post("/api/admin/customer-profiles", async (req, res) => {
  try {
    const session = res.locals.shopify.session;
    const shop = session.shop;
    const {
      customerId,
      name,
      email,
      skinType,
      concerns,
      fragrancePreference,
      priceSensitivity,
      preferredCategories,
      ethicalPreferences,
      hairType,
      localClimate,
      zipCode,
      allergens
    } = req.body;

    let resolvedCustomerId = customerId;

    // Resolve or create GID via Shopify Admin GraphQL API if missing (new manual additions)
    if (!req.body.id) {
      try {
        const client = new shopify.api.clients.Graphql({ session });
        const nameParts = (name || "Storefront Customer").trim().split(/\s+/);
        const firstName = nameParts[0] || "Storefront";
        const lastName = nameParts.slice(1).join(" ") || "Customer";

        const gqlResponse = await client.request(
          `mutation customerCreate($input: CustomerInput!) {
            customerCreate(input: $input) {
              customer {
                id
              }
              userErrors {
                field
                message
              }
            }
          }`,
          {
            variables: {
              input: {
                firstName,
                lastName,
                email,
                sendEmailInvite: false
              }
            }
          }
        );

        const result = (gqlResponse as any).data?.customerCreate;
        if (result?.userErrors && result.userErrors.length > 0) {
          const emailErr = result.userErrors.find((e: any) => e.message.includes("taken") || e.message.includes("exists"));
          if (emailErr) {
            const queryResponse = await client.request(
              `query {
                customers(first: 1, query: "email:${email}") {
                  edges {
                    node {
                      id
                    }
                  }
                }
              }`
            );
            const existingId = (queryResponse as any).data?.customers?.edges?.[0]?.node?.id;
            if (existingId) {
              resolvedCustomerId = existingId;
            } else {
              return res.status(400).json({ error: emailErr.message });
            }
          } else {
            return res.status(400).json({ error: result.userErrors[0].message });
          }
        } else if (result?.customer?.id) {
          resolvedCustomerId = result.customer.id;
        }
      } catch (gqlErr) {
        console.warn("[GraphQL Warning] Failed to create customer in Shopify, using fallback:", (gqlErr as any).message);
        if (!resolvedCustomerId || resolvedCustomerId === "new" || resolvedCustomerId.startsWith("guest") || resolvedCustomerId.trim() === "") {
          resolvedCustomerId = "gid://shopify/Customer/" + Math.floor(1000000000000 + Math.random() * 9000000000000);
        }
      }
    }

    if (!resolvedCustomerId || resolvedCustomerId === "new" || resolvedCustomerId.trim() === "") {
      return res.status(400).json({ error: "Missing customer GID reference" });
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
        priceSensitivity,
        preferredCategories,
        ethicalPreferences,
        hairType,
        localClimate,
        zipCode,
        allergens
      },
      create: {
        customerId: resolvedCustomerId,
        shop,
        name,
        email,
        skinType,
        concerns,
        fragrancePreference,
        priceSensitivity,
        preferredCategories,
        ethicalPreferences,
        hairType,
        localClimate,
        zipCode,
        allergens
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

// POST /api/admin/curations/:id/update (Save customized box contents)
app.post("/api/admin/curations/:id/update", async (req, res) => {
  try {
    const { id } = req.params;
    const { suggestedItems, totalPrice, margin } = req.body;

    const curation = await prisma.boxCuration.update({
      where: { id },
      data: {
        suggestedItems,
        totalPrice: parseFloat(totalPrice),
        margin: parseFloat(margin)
      }
    });

    res.json(curation);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/settings (Get dynamic pricing/margin settings)
app.get("/api/admin/settings", async (req, res) => {
  try {
    const session = res.locals.shopify.session;
    const shop = session.shop;

    const dbSession = await prisma.session.findFirst({ where: { shop } });
    if (!dbSession) {
      return res.status(404).json({ error: "Session not found" });
    }

    res.json({
      boxPriceLow: dbSession.boxPriceLow,
      boxPriceMedium: dbSession.boxPriceMedium,
      boxPriceHigh: dbSession.boxPriceHigh,
      targetMargin: dbSession.targetMargin
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/admin/settings (Update pricing/margin settings)
app.patch("/api/admin/settings", async (req, res) => {
  try {
    const session = res.locals.shopify.session;
    const shop = session.shop;
    const { boxPriceLow, boxPriceMedium, boxPriceHigh, targetMargin } = req.body;

    await prisma.session.updateMany({
      where: { shop },
      data: {
        boxPriceLow: parseFloat(boxPriceLow),
        boxPriceMedium: parseFloat(boxPriceMedium),
        boxPriceHigh: parseFloat(boxPriceHigh),
        targetMargin: parseFloat(targetMargin)
      }
    });

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/curations/generate (Dynamic AI curation generator based on target price sensitivity and profit margins!)
app.post("/api/admin/curations/generate", async (req, res) => {
  try {
    const session = res.locals.shopify.session;
    const shop = session.shop;

    const dbSession = await prisma.session.findFirst({ where: { shop } });
    const currentPlan = dbSession?.plan || "STARTER";
    if (currentPlan === "STARTER") {
      return res.status(403).json({ error: "Upgrade required to run AI curation." });
    }

    const priceLow = dbSession?.boxPriceLow || 30.0;
    const priceMedium = dbSession?.boxPriceMedium || 60.0;
    const priceHigh = dbSession?.boxPriceHigh || 120.0;
    const targetMargin = dbSession?.targetMargin || 55.0;

    // Purge existing suggestions to perform a fresh optimization sweep
    await prisma.boxCuration.deleteMany({ where: { status: "SUGGESTED" } });

    // Fetch all customer profiles and products
    const profiles = await prisma.customerProfile.findMany({
      where: { shop },
      include: { subscription: true }
    });
    const products = await prisma.inventoryAnalytics.findMany();

    if (profiles.length === 0 || products.length === 0) {
      return res.json({ success: true, count: 0, message: "No profiles or catalog items found. Seed data first." });
    }

    // --- Query Real Products from Shopify & Map Tags (Option A) ---
    let realProducts: any[] = [];
    try {
      const client = new shopify.api.clients.Graphql({ session });
      const gqlResponse: any = await client.request(
        `query {
          products(first: 50) {
            edges {
              node {
                id
                title
                tags
                variants(first: 10) {
                  edges {
                    node {
                      id
                      title
                      price
                    }
                  }
                }
              }
            }
          }
        }`
      );
      
      const shopifyProds = gqlResponse?.data?.products?.edges || [];
      for (const edge of shopifyProds) {
        const node = edge.node;
        const tags = node.tags || [];
        
        // Option A prefixes: skin_type:dry, concern:acne, ingredient:peanut, ethical:vegan
        const skinTypes = tags
          .filter((t: string) => t.toLowerCase().startsWith("skin_type:"))
          .map((t: string) => t.split(":")[1].trim().toLowerCase());
        const concerns = tags
          .filter((t: string) => t.toLowerCase().startsWith("concern:"))
          .map((t: string) => t.split(":")[1].trim().toLowerCase());
        const ingredients = tags
          .filter((t: string) => t.toLowerCase().startsWith("ingredient:"))
          .map((t: string) => t.split(":")[1].trim().toLowerCase());
        const ethical = tags
          .filter((t: string) => t.toLowerCase().startsWith("ethical:"))
          .map((t: string) => t.split(":")[1].trim().toLowerCase());

        const firstVariantEdge = node.variants?.edges?.[0];
        const variantId = firstVariantEdge?.node?.id || node.id;
        const variantPrice = parseFloat(firstVariantEdge?.node?.price || "20.0");
        
        const localMeta = await prisma.inventoryAnalytics.findFirst({
          where: {
            OR: [
              { productId: node.title },
              { productId: variantId }
            ]
          }
        });

        realProducts.push({
          id: variantId,
          title: node.title,
          skinTypes: skinTypes.length > 0 ? skinTypes : ["dry", "combination", "oily", "sensitive"],
          concerns: concerns,
          ingredients: ingredients.length > 0 ? ingredients : ["water", "glycerin"],
          margin: localMeta?.margin || 50.0,
          price: variantPrice,
          cost: localMeta?.cost || (variantPrice * 0.5),
          retentionValue: localMeta?.retentionValue || 65.0,
          satisfaction: localMeta?.satisfaction || 4.2,
          stockLevel: localMeta?.stockLevel || 500,
          stockRisk: localMeta?.stockRisk || "LOW",
          expiryDays: 180
        });
      }
    } catch (graphqlErr) {
      console.warn("Could not fetch real products from Shopify GraphQL. Falling back to DB mock catalog.", graphqlErr);
    }

    // Fallback: Populate mock product properties to allow sandbox run of the advanced rules engine
    if (realProducts.length === 0) {
      for (const prod of products) {
        let skinTypes = ["dry", "combination", "oily", "sensitive"];
        let concerns: string[] = [];
        let ingredients: string[] = [];
        
        if (prod.productId.includes("Vitamin C")) {
          skinTypes = ["dry", "combination", "oily"];
          concerns = ["dullness", "aging"];
          ingredients = ["vitamin c", "hyaluronic acid", "glycerin"];
        } else if (prod.productId.includes("Charcoal")) {
          skinTypes = ["oily", "combination"];
          concerns = ["acne", "oiliness"];
          ingredients = ["charcoal", "salicylic acid"];
        } else {
          skinTypes = ["dry", "combination", "oily", "sensitive"];
          concerns = ["dryness"];
          ingredients = ["water", "aloe"];
        }
        
        realProducts.push({
          id: prod.productId,
          title: prod.productId,
          skinTypes,
          concerns,
          ingredients,
          margin: prod.margin,
          price: prod.price,
          cost: prod.cost,
          retentionValue: prod.retentionValue,
          satisfaction: prod.satisfaction,
          stockLevel: prod.stockLevel,
          stockRisk: prod.stockRisk,
          expiryDays: 120
        });
      }
    }

    let createdCount = 0;

    for (const profile of profiles) {
      let targetPrice = priceMedium;
      if (profile.priceSensitivity === "low") targetPrice = priceLow;
      if (profile.priceSensitivity === "high") targetPrice = priceHigh;

      const profileConcerns = (profile.concerns || []).map(c => c.toLowerCase());
      const profileSkinType = (profile.skinType || "dry").toLowerCase();
      const profileAllergens = (profile.allergens || []).map(a => a.toLowerCase().trim());
      const deliveredProductIds = profile.subscription?.deliveredProductIds || [];

      // Run advanced predictive scoring matches
      const candidates = realProducts.map(product => {
        const matchesSkinType = product.skinTypes.map((s: string) => s.toLowerCase()).includes(profileSkinType);
        if (!matchesSkinType) {
          return { ...product, score: 0, reason: "Incompatible skin type" };
        }

        // Allergen gating
        const matchingAllergens = product.ingredients.filter((ing: string) => 
          profileAllergens.some(allerg => ing.toLowerCase().includes(allerg))
        );
        if (matchingAllergens.length > 0) {
          return { ...product, score: 0, reason: `Allergen conflict: contains ${matchingAllergens.join(", ")}` };
        }

        let score = 50;
        const matchingConcerns = product.concerns.filter((concern: string) => 
          profileConcerns.includes(concern.toLowerCase())
        );

        score += matchingConcerns.length * 20;

        if (product.margin >= 60.0) {
          score += 10;
        }

        let reason = "Standard compatibility match";
        if (matchingConcerns.length > 0) {
          reason = `Perfect concern match for: ${matchingConcerns.join(", ")}`;
        }

        // Climate Adaptation
        if (profile.zipCode && profile.zipCode.startsWith("90")) {
          if (product.title.toLowerCase().includes("vitamin c") || product.title.toLowerCase().includes("ceramide")) {
            score += 25;
            reason += " | Weather/Climate Boost (Zip 90XXX)";
          }
        }

        // Inventory Bandit Boost
        if (product.stockLevel > 1000 || product.expiryDays < 60) {
          score += 30;
          reason += ` | Inventory Bandit Boost (Stock: ${product.stockLevel})`;
        }

        // Saturation Decay
        if (deliveredProductIds.includes(product.id)) {
          score = Math.round(score * 0.2);
          reason += " | Saturation Penalty (received historical box)";
        }

        return { ...product, score, reason };
      });

      const activeCandidates = candidates
        .filter(c => c.score > 0)
        .sort((a, b) => b.score - a.score);

      let chosenItems = [];
      let currentPriceSum = 0;
      let currentCostSum = 0;

      for (const cand of activeCandidates) {
        const nextPrice = currentPriceSum + cand.price;
        const nextCost = currentCostSum + cand.cost;
        const nextMargin = nextPrice > 0 ? ((nextPrice - nextCost) / nextPrice) * 100 : 0;

        // Strict Hard Price Ceiling Enforced: Never exceed the customer's tier target price
        if (nextPrice <= targetPrice && nextMargin >= targetMargin - 15) {
          chosenItems.push({
            variantId: cand.id,
            productName: cand.title,
            score: cand.score,
            reason: cand.reason
          });
          currentPriceSum = nextPrice;
          currentCostSum = nextCost;
        }

        if (chosenItems.length >= 3) break;
      }

      if (chosenItems.length === 0) {
        chosenItems = realProducts.slice(0, 2).map(p => ({
          variantId: p.id,
          productName: p.title,
          score: 85,
          reason: "Default box curation fallback"
        }));
        currentPriceSum = realProducts.slice(0, 2).reduce((sum, p) => sum + p.price, 0);
        currentCostSum = realProducts.slice(0, 2).reduce((sum, p) => sum + p.cost, 0);
      }

      const computedMargin = currentPriceSum > 0 ? ((currentPriceSum - currentCostSum) / currentPriceSum) * 100 : 0;

      await prisma.boxCuration.create({
        data: {
          subscriptionTier: profile.subscription?.tier || "PRO",
          boxMonth: "2026-09",
          status: "SUGGESTED",
          margin: parseFloat(computedMargin.toFixed(1)),
          customerId: profile.customerId,
          customerName: profile.name,
          totalPrice: parseFloat(currentPriceSum.toFixed(2)),
          targetPrice: parseFloat(targetPrice.toFixed(2)),
          suggestedItems: chosenItems
        }
      });
      createdCount++;
    }

    res.json({ success: true, count: createdCount });
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

    let realProductMap: Record<string, string> = {};
    try {
      const client = new shopify.api.clients.Graphql({ session });
      const gqlResponse: any = await client.request(
        `query {
          products(first: 50) {
            edges {
              node {
                title
                variants(first: 10) {
                  edges {
                    node {
                      id
                      title
                    }
                  }
                }
              }
            }
          }
        }`
      );
      const productEdges = gqlResponse.data?.products?.edges || [];
      for (const pEdge of productEdges) {
        const pNode = pEdge.node;
        const vEdges = pNode.variants?.edges || [];
        for (const vEdge of vEdges) {
          const vNode = vEdge.node;
          const vTitle = vNode.title && vNode.title !== "Default Title" ? ` - ${vNode.title}` : "";
          realProductMap[vNode.id] = `${pNode.title}${vTitle}`;
        }
      }
    } catch (gqlErr) {
      console.warn("[GraphQL Warning] Failed to fetch product titles for inventory list:", gqlErr);
    }

    const decoratedAnalytics = analytics.map((item: any) => {
      let name = realProductMap[item.productId];
      if (!name) {
        if (item.productId === "gid://shopify/ProductVariant/5001" || item.productId === "Vitamin C Serum (9001)") {
          name = "Vitamin C Serum";
        } else if (item.productId === "gid://shopify/ProductVariant/5002" || item.productId === "Charcoal Face Mask (9002)") {
          name = "Charcoal Face Mask";
        } else {
          name = item.productId;
        }
      }
      return {
        ...item,
        productName: name,
        title: name
      };
    });

    res.json(decoratedAnalytics);
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
        preferredCategories: ["skincare"],
        ethicalPreferences: ["cruelty-free"],
        hairType: "wavy",
        localClimate: "dry",
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
        preferredCategories: ["skincare", "makeup"],
        ethicalPreferences: ["vegan"],
        hairType: "straight",
        localClimate: "humid",
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
          { variantId: "Vitamin C Serum (9001)", score: 95, reason: "Matches dry skin concern + High repeat purchase" },
          { variantId: "Charcoal Face Mask (9002)", score: 88, reason: "Sourced locally, maintains 55% target margins" }
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
          price: 30.0,
          cost: 11.4,
          stockLevel: 1200,
          stockRisk: "LOW"
        },
        {
          productId: "Charcoal Face Mask (9002)",
          retentionValue: 14.2,
          returnRate: 35.8,
          satisfaction: 2.3,
          margin: 38.0,
          price: 25.0,
          cost: 15.5,
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
        const isEmbedded = window.top !== window.self || !!window.shopify;
        if (!isEmbedded) {
          console.warn("[Glow Retention] App is running outside Shopify Admin. Deferring API fetches.");
          return;
        }

        let attempts = 0;
        const interval = setInterval(() => {
          attempts++;
          if (window.shopify) {
            clearInterval(interval);
            if (window.shopify.ready) {
              window.shopify.ready.then(() => {
                setAppBridgeReady(true);
              });
            } else {
              setAppBridgeReady(true);
            }
          } else if (attempts > 100) {
            clearInterval(interval);
            console.error("[Glow Retention] Shopify App Bridge failed to load.");
          }
        }, 50);

        return () => clearInterval(interval);
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

      const [shopifyCustomers, setShopifyCustomers] = React.useState([
        { id: "gid://shopify/Customer/1001", name: "Jessica Alchemist", email: "jessica@alchemistbeauty.com" },
        { id: "gid://shopify/Customer/1002", name: "Rohit Clay", email: "rohit@claycosmetics.com" }
      ]);

      const [settings, setSettings] = React.useState({
        boxPriceLow: 30.0,
        boxPriceMedium: 60.0,
        boxPriceHigh: 120.0,
        targetMargin: 55.0
      });

      const [settingsLow, setSettingsLow] = React.useState("30.0");
      const [settingsMedium, setSettingsMedium] = React.useState("60.0");
      const [settingsHigh, setSettingsHigh] = React.useState("120.0");
      const [settingsMargin, setSettingsMargin] = React.useState("55.0");

      const [curations, setCurations] = React.useState([
        {
          id: "c1",
          subscriptionTier: "PRO",
          boxMonth: "2026-09",
          status: "SUGGESTED",
          margin: 55.4,
          suggestedItems: [
            { variantId: "gid://shopify/ProductVariant/5001", productName: "Vitamin C Serum (5001)", score: 95, reason: "Matches dry skin concern + High repeat purchase" },
            { variantId: "gid://shopify/ProductVariant/5002", productName: "Charcoal Face Mask (5002)", score: 88, reason: "Sourced locally, maintains 55% target margins" }
          ]
        }
      ]);

      const [inventory, setInventory] = React.useState([
        { productId: "gid://shopify/ProductVariant/5001", productName: "Vitamin C Serum (5001)", retentionValue: 84.6, returnRate: 2.1, satisfaction: 4.8, margin: 62.0, price: 30.0, cost: 11.4, stockLevel: 1200, stockRisk: "LOW" },
        { productId: "gid://shopify/ProductVariant/5002", productName: "Charcoal Face Mask (5002)", retentionValue: 14.2, returnRate: 35.8, satisfaction: 2.3, margin: 38.0, price: 25.0, cost: 15.5, stockLevel: 2500, stockRisk: "HIGH" }
      ]);

      const [quizSkinType, setQuizSkinType] = React.useState("dry");
      const [quizConcerns, setQuizConcerns] = React.useState(["aging"]);
      const [quizFragrance, setQuizFragrance] = React.useState("floral");
      const [quizPrice, setQuizPrice] = React.useState("low");
      const [quizCategories, setQuizCategories] = React.useState(["skincare"]);
      const [quizEthical, setQuizEthical] = React.useState(["cruelty-free"]);
      const [quizHair, setQuizHair] = React.useState("wavy");
      const [quizClimate, setQuizClimate] = React.useState("temperate");
      const [quizZipCode, setQuizZipCode] = React.useState("");
      const [quizAllergens, setQuizAllergens] = React.useState([]);

      const [selectedQuizCustomerId, setSelectedQuizCustomerId] = React.useState("gid://shopify/Customer/1001");
      const [manualQuizName, setManualQuizName] = React.useState("New Subscriber");
      const [manualQuizEmail, setManualQuizEmail] = React.useState("new@subscriber.com");
      const [manualQuizGid, setManualQuizGid] = React.useState("gid://shopify/Customer/1003");

      // Helper to format/strip variant GIDs in UI
      const formatProductName = (idOrName) => {
        if (!idOrName) return "Unknown Product";

        const matched = inventory.find(inv => inv.productId === idOrName);
        if (matched && matched.productName && matched.productName !== idOrName) {
          return matched.productName;
        }
        if (matched && matched.title && matched.title !== idOrName) {
          return matched.title;
        }

        if (idOrName.startsWith("gid://")) {
          const friendlyNames = {
            "gid://shopify/ProductVariant/5001": "Vitamin C Serum",
            "gid://shopify/ProductVariant/5002": "Charcoal Face Mask"
          };
          if (friendlyNames[idOrName]) {
            return friendlyNames[idOrName];
          }

          const parts = idOrName.split("/");
          const lastPart = parts[parts.length - 1];
          return "Product Variant #" + lastPart;
        }
        return idOrName;
      };

      React.useEffect(() => {
        const selectedProfile = profiles.find(p => p.customerId === selectedQuizCustomerId);
        if (selectedProfile) {
          setQuizSkinType(selectedProfile.skinType || "dry");
          setQuizConcerns(selectedProfile.concerns || []);
          setQuizFragrance(selectedProfile.fragrancePreference || "floral");
          setQuizPrice(selectedProfile.priceSensitivity || "low");
          setQuizCategories(selectedProfile.preferredCategories || ["skincare"]);
          setQuizEthical(selectedProfile.ethicalPreferences || ["cruelty-free"]);
          setQuizHair(selectedProfile.hairType || "wavy");
          setQuizClimate(selectedProfile.localClimate || "temperate");
          setQuizZipCode(selectedProfile.zipCode || "");
          setQuizAllergens(selectedProfile.allergens || []);
        } else {
          setQuizSkinType("dry");
          setQuizConcerns([]);
          setQuizFragrance("floral");
          setQuizPrice("low");
          setQuizCategories(["skincare"]);
          setQuizEthical(["cruelty-free"]);
          setQuizHair("wavy");
          setQuizClimate("temperate");
          setQuizZipCode("");
          setQuizAllergens([]);
        }
      }, [selectedQuizCustomerId, profiles]);

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
        const curObj = curations.find(c => c.id === id);
        if (!curObj) return;
        const items = typeof curObj.suggestedItems === "string" ? JSON.parse(curObj.suggestedItems) : curObj.suggestedItems;

        fetch("/api/admin/curations/" + id + "/accept", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ acceptedItems: items })
        })
        .then(res => res.json())
        .then(() => {
          setNotification("AI Curation recommendations accepted successfully!");
          setCurations(curations.map(c => c.id === id ? { ...c, status: "ACCEPTED" } : c));
        });
      };

      const handleSwapProduct = (curationId, itemIdx, newProdId) => {
        const chosenProduct = inventory.find(inv => inv.productId === newProdId);
        if (!chosenProduct) return;

        const updatedCurations = curations.map(c => {
          if (c.id !== curationId) return c;

          const items = typeof c.suggestedItems === "string" ? JSON.parse(c.suggestedItems) : [...c.suggestedItems];

          items[itemIdx] = {
            variantId: chosenProduct.productId,
            productName: chosenProduct.productName || chosenProduct.title || chosenProduct.productId,
            score: Math.round(chosenProduct.satisfaction * 20) || 85,
            reason: "Manually customized by merchant"
          };
          
          const priceSum = items.reduce((sum, it) => {
            const matched = inventory.find(inv => inv.productId === it.variantId || inv.productId === it.productName);
            return sum + (matched ? matched.price : 25.0);
          }, 0);
          
          const costSum = items.reduce((sum, it) => {
            const matched = inventory.find(inv => inv.productId === it.variantId || inv.productId === it.productName);
            return sum + (matched ? (matched.cost || matched.price * 0.5) : 12.0);
          }, 0);
          
          const calculatedMargin = priceSum > 0 ? ((priceSum - costSum) / priceSum) * 100 : 0;
          
          return {
            ...c,
            suggestedItems: items,
            totalPrice: parseFloat(priceSum.toFixed(2)),
            margin: parseFloat(calculatedMargin.toFixed(1)),
            isEdited: true
          };
        });
        
        setCurations(updatedCurations);
      };

      const handleSaveCustomBox = (curationId) => {
        const curObj = curations.find(c => c.id === curationId);
        if (!curObj) return;
        const items = typeof curObj.suggestedItems === "string" ? JSON.parse(curObj.suggestedItems) : curObj.suggestedItems;
        
        fetch("/api/admin/curations/" + curationId + "/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            suggestedItems: items,
            totalPrice: curObj.totalPrice,
            margin: curObj.margin
          })
        })
        .then(res => res.json())
        .then(() => {
          setNotification("Custom box curation saved successfully!");
          setCurations(curations.map(c => c.id === curationId ? { ...c, isEdited: false } : c));
        })
        .catch(err => console.error("Error saving custom box:", err));
      };

      const handleSaveQuizProfile = () => {
        fetch("/api/admin/customer-profiles", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: selectedQuizCustomerId === "new" ? undefined : (profiles.find(p => p.customerId === selectedQuizCustomerId)?.id),
            customerId: selectedQuizCustomerId === "new" ? manualQuizGid : selectedQuizCustomerId,
            name: selectedQuizCustomerId === "new" ? manualQuizName : (profiles.find(p => p.customerId === selectedQuizCustomerId)?.name || shopifyCustomers.find(c => c.id === selectedQuizCustomerId)?.name),
            email: selectedQuizCustomerId === "new" ? manualQuizEmail : (profiles.find(p => p.customerId === selectedQuizCustomerId)?.email || shopifyCustomers.find(c => c.id === selectedQuizCustomerId)?.email),
            skinType: quizSkinType,
            concerns: quizConcerns,
            fragrancePreference: quizFragrance,
            priceSensitivity: quizPrice,
            preferredCategories: quizCategories,
            ethicalPreferences: quizEthical,
            hairType: quizHair,
            localClimate: quizClimate,
            zipCode: quizZipCode,
            allergens: quizAllergens
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

      const handleSaveSettings = (low, med, high, margin) => {
        fetch("/api/admin/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            boxPriceLow: low,
            boxPriceMedium: med,
            boxPriceHigh: high,
            targetMargin: margin
          })
        })
        .then(res => res.json())
        .then(() => {
          setNotification("💾 Curation price & margin settings saved successfully!");
          setSettings({ boxPriceLow: parseFloat(low), boxPriceMedium: parseFloat(med), boxPriceHigh: parseFloat(high), targetMargin: parseFloat(margin) });
        })
        .catch(err => console.error("Failed to save settings:", err));
      };

      const handleGenerateCurations = () => {
        setNotification("⚡ Running AI Curation Optimizer Engine...");
        fetch("/api/admin/curations/generate", {
          method: "POST"
        })
        .then(res => res.json())
        .then(data => {
          setNotification(\`🎉 AI Curation complete! Optimized box suggestions for \${data.count} customer profiles.\`);
          refreshAllData();
        })
        .catch(err => console.error("Error generating curations:", err));
      };

      const refreshAllData = () => {
        fetch("/api/admin/customer-profiles")
          .then(res => res.json())
          .then(data => {
            if (data && data.profiles) setProfiles(data.profiles);
            if (data && data.shopifyCustomers) setShopifyCustomers(data.shopifyCustomers);
            if (data && data.plan) setPlan(data.plan);
          })
          .catch(() => {});
        fetch("/api/admin/settings")
          .then(res => res.json())
          .then(data => {
            if (data && data.targetMargin !== undefined) {
              setSettings(data);
              setSettingsLow(data.boxPriceLow.toString());
              setSettingsMedium(data.boxPriceMedium.toString());
              setSettingsHigh(data.boxPriceHigh.toString());
              setSettingsMargin(data.targetMargin.toString());
            }
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
          e("div", { className: "card", style: { marginBottom: "20px" } },
            e("h3", { style: { fontSize: "16px", fontWeight: "600", marginBottom: "12px" } }, "🎯 AI Curation Margin & Price Settings"),
            e("p", { style: { color: "#6d7175", marginBottom: "20px", fontSize: "13px" } }, "Configure the target box price for each price sensitivity tier and your desired target margin. The AI Curation Engine will automatically optimize product matching to stay within these parameters."),
            e("div", { style: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "16px", marginBottom: "20px" } },
              e("div", null,
                e("label", { style: { display: "block", fontWeight: "600", fontSize: "12px", marginBottom: "4px" } }, "Value Tier Price ($)"),
                e("input", { type: "number", value: settingsLow, onChange: (e) => setSettingsLow(e.target.value), style: { width: "100%", padding: "6px", borderRadius: "4px", border: "1px solid #8c9196", fontSize: "13px" } })
              ),
              e("div", null,
                e("label", { style: { display: "block", fontWeight: "600", fontSize: "12px", marginBottom: "4px" } }, "Balanced Tier Price ($)"),
                e("input", { type: "number", value: settingsMedium, onChange: (e) => setSettingsMedium(e.target.value), style: { width: "100%", padding: "6px", borderRadius: "4px", border: "1px solid #8c9196", fontSize: "13px" } })
              ),
              e("div", null,
                e("label", { style: { display: "block", fontWeight: "600", fontSize: "12px", marginBottom: "4px" } }, "Luxury Tier Price ($)"),
                e("input", { type: "number", value: settingsHigh, onChange: (e) => setSettingsHigh(e.target.value), style: { width: "100%", padding: "6px", borderRadius: "4px", border: "1px solid #8c9196", fontSize: "13px" } })
              ),
              e("div", null,
                e("label", { style: { display: "block", fontWeight: "600", fontSize: "12px", marginBottom: "4px" } }, "Target Profit Margin (%)"),
                e("input", { type: "number", value: settingsMargin, onChange: (e) => setSettingsMargin(e.target.value), style: { width: "100%", padding: "6px", borderRadius: "4px", border: "1px solid #8c9196", fontSize: "13px" } })
              )
            ),
            e("div", { style: { display: "flex", gap: "12px" } },
              e("button", { className: "button-primary", onClick: () => handleSaveSettings(settingsLow, settingsMedium, settingsHigh, settingsMargin) }, "💾 Save Curation Settings"),
              e("button", { className: "button-secondary", style: { backgroundColor: "#00875a", color: "#fff", border: "none" }, onClick: handleGenerateCurations }, "⚡ Run AI Curation Optimizer Engine")
            )
          ),
          e("div", { className: "card" },
            e("h3", { style: { fontSize: "16px", fontWeight: "600", marginBottom: "12px" } }, "AI-Curated Box Suggestions (Next Cycle)"),
            curations.map(c => {
              const displayName = c.customerName || "Subscription Subscriber";
              const actualPrice = c.totalPrice ? "$" + c.totalPrice.toFixed(2) : "$55.00";
              const targetVal = c.targetPrice ? "$" + c.targetPrice.toFixed(2) : "$60.00";
              const achievedMargin = c.margin ? c.margin + "%" : "55.4%";
              
              // Enforce rigid price ceilings check
              const isOverBudget = c.totalPrice && c.targetPrice && c.totalPrice > c.targetPrice;

              // Fetch customer profile details
              const profile = profiles.find(p => p.customerId === c.customerId);

              return e("div", { key: c.id, style: { borderBottom: "1px solid #e1e3e5", paddingBottom: "16px", marginBottom: "16px" } },
                e("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" } },
                  e("div", null,
                    e("span", { style: { fontWeight: "bold", fontSize: "15px", color: "#1c1d1f" } }, "👤 " + displayName),
                    e("span", { style: { marginLeft: "12px", className: "badge badge-loyal" } }, "Month: " + c.boxMonth),
                    e("span", { style: { marginLeft: "12px", color: isOverBudget ? "#d32f2f" : "#00875a", fontSize: "13px", fontWeight: "600" } }, 
                      "Achieved Price: " + actualPrice + " (Target: " + targetVal + ")"
                    ),
                    e("span", { style: { marginLeft: "12px", color: "#00875a", fontSize: "13px", fontWeight: "600" } }, "Predicted Margin: " + achievedMargin),
                    
                    // Render high-visibility budget warnings
                    isOverBudget && e("span", { 
                      className: "badge", 
                      style: { marginLeft: "12px", backgroundColor: "#fbeae5", color: "#8a2408", fontWeight: "bold", border: "1px solid #f3d6ce" } 
                    }, "⚠️ EXCEEDS BUDGET CEILING"),

                    // Render interactive customer profile pills
                    profile && e("div", { style: { marginTop: "6px", display: "flex", gap: "6px", flexWrap: "wrap" } },
                      e("span", { className: "badge", style: { backgroundColor: "#f4f6f8", color: "#202223", border: "1px solid #e1e3e5" } }, "🧴 Skin Type: " + (profile.skinType || "dry")),
                      profile.concerns && profile.concerns.length > 0 && e("span", { className: "badge", style: { backgroundColor: "#e2f1e8", color: "#1e5128", border: "1px solid #b8dfc4" } }, "🎯 Concerns: " + profile.concerns.join(", ")),
                      profile.allergens && profile.allergens.length > 0 && e("span", { className: "badge", style: { backgroundColor: "#fbeae5", color: "#8a2408", border: "1px solid #f3d6ce" } }, "⚠️ Allergens: " + profile.allergens.join(", "))
                    )
                  ),
                  e("div", null,
                    c.status === "SUGGESTED"
                      ? e("div", { style: { display: "flex", gap: "8px" } },
                          c.isEdited && e("button", { 
                            className: "button-primary", 
                            style: { 
                              backgroundColor: isOverBudget ? "#8c9196" : "#008060", 
                              color: "#fff", 
                              border: "none",
                              cursor: isOverBudget ? "not-allowed" : "pointer"
                            },
                            disabled: isOverBudget,
                            onClick: () => handleSaveCustomBox(c.id) 
                          }, isOverBudget ? "🚫 Over Budget" : "💾 Save Custom Box"),
                          
                          e("button", { 
                            className: "button-primary",
                            style: { 
                              backgroundColor: isOverBudget ? "#8c9196" : "#008060",
                              cursor: isOverBudget ? "not-allowed" : "pointer"
                            },
                            disabled: isOverBudget,
                            onClick: () => handleCurationAccept(c.id) 
                          }, "Accept Suggestions")
                        )
                      : e("span", { className: "badge badge-loyal" }, "APPROVED & LOCKED")
                  )
                ),
                e("table", null,
                  e("thead", null,
                    e("tr", null,
                      e("th", null, "Personalized Product"),
                      e("th", null, "AI Confidence Score"),
                      e("th", null, "Curation Matching Logic"),
                      c.status === "SUGGESTED" && e("th", null, "Manual Override / Swap")
                    )
                  ),
                  e("tbody", null,
                    (typeof c.suggestedItems === "string" ? JSON.parse(c.suggestedItems) : c.suggestedItems).map((item, idx) => {
                      return e("tr", { key: idx },
                        e("td", { style: { fontWeight: "500", color: "#1c1d1f" } }, formatProductName(item.productName || item.variantId)),
                        e("td", { style: { fontWeight: "600" } }, item.score + "%"),
                        e("td", { style: { color: "#6d7175" } }, item.reason),
                        c.status === "SUGGESTED" && e("td", null,
                          e("select", {
                            value: item.productName || item.variantId,
                            onChange: (event) => handleSwapProduct(c.id, idx, event.target.value),
                            style: { padding: "6px", borderRadius: "4px", border: "1px solid #8c9196", fontSize: "13px", width: "100%", maxWidth: "200px" }
                          },
                            inventory.map(inv => e("option", { key: inv.productId, value: inv.productId }, formatProductName(inv.productId)))
                          )
                        )
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
                    e("td", { style: { fontWeight: "500" } }, formatProductName(inv.productName || inv.productId)),
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
              e("label", { style: { display: "block", fontWeight: "bold", marginBottom: "6px" } }, "Select Customer"),
              e("select", { value: selectedQuizCustomerId, onChange: (e) => setSelectedQuizCustomerId(e.target.value), style: { width: "100%", padding: "8px", borderRadius: "4px", border: "1px solid #8c9196" } },
                shopifyCustomers.map(sc => e("option", { key: sc.id, value: sc.id }, sc.name + " (" + sc.email + ")")),
                e("option", { value: "new" }, "➕ Enter Custom/New Customer Info")
              )
            ),
            selectedQuizCustomerId === "new" && e("div", { style: { background: "#f6f6f7", padding: "12px", borderRadius: "6px", marginBottom: "16px" } },
              e("div", { style: { marginBottom: "10px" } },
                e("label", { style: { display: "block", fontWeight: "600", fontSize: "12px", marginBottom: "4px" } }, "Customer Full Name"),
                e("input", { type: "text", value: manualQuizName, onChange: (e) => setManualQuizName(e.target.value), style: { width: "100%", padding: "6px", borderRadius: "4px", border: "1px solid #8c9196", fontSize: "13px" } })
              ),
              e("div", { style: { marginBottom: "10px" } },
                e("label", { style: { display: "block", fontWeight: "600", fontSize: "12px", marginBottom: "4px" } }, "Customer Email"),
                e("input", { type: "text", value: manualQuizEmail, onChange: (e) => setManualQuizEmail(e.target.value), style: { width: "100%", padding: "6px", borderRadius: "4px", border: "1px solid #8c9196", fontSize: "13px" } })
              )
            ),
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
            e("div", { style: { marginBottom: "16px" } },
              e("label", { style: { display: "block", fontWeight: "bold", marginBottom: "6px" } }, "Preferred Product Categories"),
              e("select", { value: quizCategories[0], onChange: (e) => setQuizCategories([e.target.value]), style: { width: "100%", padding: "8px", borderRadius: "4px", border: "1px solid #8c9196" } },
                e("option", { value: "skincare" }, "Skincare Only"),
                e("option", { value: "makeup" }, "Makeup Only"),
                e("option", { value: "haircare" }, "Haircare Only"),
                e("option", { value: "all" }, "A Mix of Everything")
              )
            ),
            e("div", { style: { marginBottom: "16px" } },
              e("label", { style: { display: "block", fontWeight: "bold", marginBottom: "6px" } }, "Ethical / Ingredient Preference"),
              e("select", { value: quizEthical[0], onChange: (e) => setQuizEthical([e.target.value]), style: { width: "100%", padding: "8px", borderRadius: "4px", border: "1px solid #8c9196" } },
                e("option", { value: "cruelty-free" }, "Cruelty-Free"),
                e("option", { value: "vegan" }, "Vegan Only"),
                e("option", { value: "organic" }, "Clean / Organic"),
                e("option", { value: "none" }, "No Restrictions")
              )
            ),
            e("div", { style: { marginBottom: "16px" } },
              e("label", { style: { display: "block", fontWeight: "bold", marginBottom: "6px" } }, "Hair Type & Texture"),
              e("select", { value: quizHair, onChange: (e) => setQuizHair(e.target.value), style: { width: "100%", padding: "8px", borderRadius: "4px", border: "1px solid #8c9196" } },
                e("option", { value: "straight" }, "Fine & Straight"),
                e("option", { value: "wavy" }, "Wavy / Textured"),
                e("option", { value: "curly" }, "Curly"),
                e("option", { value: "coily" }, "Coily / Textured"),
                e("option", { value: "none" }, "Do not include Hair Products")
              )
            ),
            e("div", { style: { marginBottom: "16px" } },
              e("label", { style: { display: "block", fontWeight: "bold", marginBottom: "6px" } }, "Primary Local Climate"),
              e("select", { value: quizClimate, onChange: (e) => setQuizClimate(e.target.value), style: { width: "100%", padding: "8px", borderRadius: "4px", border: "1px solid #8c9196" } },
                e("option", { value: "arid" }, "Arid / Dry"),
                e("option", { value: "humid" }, "Humid / Tropical"),
                e("option", { value: "temperate" }, "Temperate / Seasonal"),
                e("option", { value: "cold" }, "Cold / Dry")
              )
            ),
            e("div", { style: { marginBottom: "16px" } },
              e("label", { style: { display: "block", fontWeight: "bold", marginBottom: "6px" } }, "Zip / Postal Code"),
              e("input", { type: "text", value: quizZipCode, onChange: (e) => setQuizZipCode(e.target.value), placeholder: "e.g. 90210", style: { width: "100%", padding: "8px", borderRadius: "4px", border: "1px solid #8c9196", boxSizing: "border-box" } }),
              e("p", { style: { margin: "4px 0 0 0", fontSize: "11px", color: "#6d7175" } }, "Used to dynamically analyze local weather, UV indexes, and humidity to auto-tune skincare formulation.")
            ),
            e("div", { style: { marginBottom: "16px" } },
              e("label", { style: { display: "block", fontWeight: "bold", marginBottom: "6px" } }, "Ingredient Allergens / Exclusions"),
              e("div", {
                style: {
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "6px",
                  padding: "6px 10px",
                  border: "1px solid #8c9196",
                  borderRadius: "4px",
                  backgroundColor: "#ffffff",
                  minHeight: "42px",
                  boxSizing: "border-box",
                  alignItems: "center",
                  cursor: "text"
                },
                onClick: () => {
                  const inp = document.getElementById("admin-allergens-input");
                  if (inp) inp.focus();
                }
              },
                quizAllergens.map((tag, idx) =>
                  e("span", {
                    key: idx,
                    style: {
                      display: "inline-flex",
                      alignItems: "center",
                      backgroundColor: "#f1f2f4",
                      color: "#202223",
                      padding: "4px 8px",
                      borderRadius: "12px",
                      fontSize: "12px",
                      fontWeight: "500",
                      gap: "4px",
                      border: "1px solid #e1e3e5"
                    }
                  },
                    tag,
                    e("span", {
                      style: { cursor: "pointer", fontWeight: "bold", color: "#6d7175", marginLeft: "4px" },
                      onClick: (ev) => {
                        ev.stopPropagation();
                        setQuizAllergens(quizAllergens.filter((_, i) => i !== idx));
                      }
                    }, "✕")
                  )
                ),
                e("input", {
                  id: "admin-allergens-input",
                  type: "text",
                  placeholder: quizAllergens.length === 0 ? "Type allergen and press comma or Enter" : "",
                  style: { border: "none", outline: "none", padding: "4px 0", fontSize: "14px", flexGrow: 1, minWidth: "150px", background: "transparent" },
                  onKeyDown: (ev) => {
                    if (ev.key === "Enter" || ev.key === ",") {
                      ev.preventDefault();
                      let val = ev.target.value.trim().toLowerCase();
                      if (val.endsWith(",")) val = val.substring(0, val.length - 1).trim();
                      if (val && !quizAllergens.includes(val)) {
                        setQuizAllergens([...quizAllergens, val]);
                      }
                      ev.target.value = "";
                    } else if (ev.key === "Backspace" && ev.target.value === "" && quizAllergens.length > 0) {
                      setQuizAllergens(quizAllergens.slice(0, -1));
                    }
                  },
                  onBlur: (ev) => {
                    let val = ev.target.value.trim().toLowerCase();
                    if (val.endsWith(",")) val = val.substring(0, val.length - 1).trim();
                    if (val && !quizAllergens.includes(val)) {
                      setQuizAllergens([...quizAllergens, val]);
                    }
                    ev.target.value = "";
                  }
                })
              ),
              e("p", { style: { margin: "4px 0 0 0", fontSize: "11px", color: "#6d7175" } }, "Used to strictly filter out matching ingredients from being curated in subscription boxes.")
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
