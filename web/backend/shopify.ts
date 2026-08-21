import { shopifyApp } from "@shopify/shopify-app-express";
import { LATEST_API_VERSION, Session, BillingInterval } from "@shopify/shopify-api";
import { SessionStorage } from "@shopify/shopify-app-session-storage";
import { PrismaClient } from "./prisma-client/index.js";

const prisma = new PrismaClient();

export class LocalPrismaSessionStorage implements SessionStorage {
  constructor(private client: PrismaClient) {}

  public async storeSession(session: Session): Promise<boolean> {
    const data = this.sessionToRow(session);
    await this.client.session.upsert({
      where: { id: session.id },
      update: data,
      create: data,
    });
    return true;
  }

  public async loadSession(id: string): Promise<Session | undefined> {
    const row = await this.client.session.findUnique({
      where: { id },
    });
    if (!row) return undefined;
    return this.rowToSession(row);
  }

  public async deleteSession(id: string): Promise<boolean> {
    try {
      await this.client.session.delete({ where: { id } });
    } catch {
      return true;
    }
    return true;
  }

  public async deleteSessions(ids: string[]): Promise<boolean> {
    await this.client.session.deleteMany({ where: { id: { in: ids } } });
    return true;
  }

  public async findSessionsByShop(shop: string): Promise<Session[]> {
    const sessions = await this.client.session.findMany({
      where: { shop },
      take: 25,
      orderBy: [{ expires: "desc" }],
    });
    return sessions.map((session) => this.rowToSession(session));
  }

  private sessionToRow(session: Session) {
    const sessionParams = session.toObject();
    return {
      id: session.id,
      shop: session.shop,
      state: session.state,
      isOnline: session.isOnline,
      isPremium: (sessionParams as any).isPremium || false,
      plan: (sessionParams as any).plan || "STARTER",
      scope: session.scope || null,
      expires: session.expires || null,
      accessToken: session.accessToken || "",
      userId: session.onlineAccessInfo?.associated_user?.id 
        ? BigInt(session.onlineAccessInfo.associated_user.id) 
        : null,
      firstName: session.onlineAccessInfo?.associated_user?.first_name || null,
      lastName: session.onlineAccessInfo?.associated_user?.last_name || null,
      email: session.onlineAccessInfo?.associated_user?.email || null,
      accountOwner: session.onlineAccessInfo?.associated_user?.account_owner || null,
      locale: session.onlineAccessInfo?.associated_user?.locale || null,
      collaborator: session.onlineAccessInfo?.associated_user?.collaborator || null,
      emailVerified: session.onlineAccessInfo?.associated_user?.email_verified || null,
    };
  }

  private rowToSession(row: any): Session {
    const session = new Session({
      id: row.id,
      shop: row.shop,
      state: row.state,
      isOnline: row.isOnline,
      accessToken: row.accessToken,
      scope: row.scope || undefined,
      expires: row.expires || undefined,
    });
    
    (session as any).isPremium = row.isPremium;
    (session as any).plan = row.plan;

    if (row.userId) {
      session.onlineAccessInfo = {
        associated_user: {
          id: Number(row.userId),
          first_name: row.firstName || "",
          last_name: row.lastName || "",
          email: row.email || "",
          account_owner: row.accountOwner || false,
          locale: row.locale || "",
          collaborator: row.collaborator || false,
          email_verified: row.emailVerified || false,
        },
      } as any;
    }
    return session;
  }
}

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
    billing: {
      "PRO": {
        amount: 99.00,
        currencyCode: "USD",
        interval: BillingInterval.Every30Days,
        trialDays: 14,
      },
      "ENTERPRISE": {
        amount: 499.00,
        currencyCode: "USD",
        interval: BillingInterval.Every30Days,
        trialDays: 30,
      }
    }
  },
  auth: {
    path: "/api/auth",
    callbackPath: "/api/auth/callback"
  },
  webhooks: {
    path: "/api/webhooks"
  },
  sessionStorage: new LocalPrismaSessionStorage(prisma)
});

export default shopify;
