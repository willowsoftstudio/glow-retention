import { shopifyApp } from "@shopify/shopify-app-express";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import { LATEST_API_VERSION } from "@shopify/shopify-api";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Dynamically initialize the official Shopify App Express configurations
export const shopify = shopifyApp({
  api: {
    apiVersion: LATEST_API_VERSION,
    apiKey: process.env.SHOPIFY_API_KEY,
    apiSecretKey: process.env.SHOPIFY_API_SECRET,
    scopes: process.env.SCOPES ? process.env.SCOPES.split(",") : [
      "write_products",
      "read_products",
      "write_customers",
      "read_customers",
      "write_draft_orders",
      "write_validations",
      "read_validations",
      "read_orders"
    ],
    hostName: process.env.HOST 
      ? process.env.HOST.replace(/https?:\/\//, "") 
      : (process.env.VERCEL_URL ? process.env.VERCEL_URL : "localhost:3002"),
    restResources: undefined,
    billing: undefined
  },
  auth: {
    path: "/api/auth",
    callbackPath: "/api/auth/callback"
  },
  webhooks: {
    path: "/api/webhooks"
  },
  sessionStorage: new PrismaSessionStorage(prisma)
});

export default shopify;
