import { describe, it, expect } from "vitest";

// Port of matching rules for isolated unit testing of Beauty AI Curation & Churn Prediction
const MOCK_PRODUCTS = [
  {
    id: "prod-vit-c",
    title: "Vitamin C Brightening Serum",
    concerns: ["dullness", "aging"],
    skinTypes: ["dry", "combination", "oily"],
    margin: 62.5,
    ingredients: ["vitamin c", "hyaluronic acid", "glycerin", "orange oil"]
  },
  {
    id: "prod-salicylic",
    title: "Salicylic Acid Acne Cleanser",
    concerns: ["acne", "redness"],
    skinTypes: ["oily", "combination"],
    margin: 58.0,
    ingredients: ["salicylic acid", "tea tree oil", "aloe vera", "parabens"]
  },
  {
    id: "prod-ceramide",
    title: "Ceramide Barrier Repair Cream",
    concerns: ["dryness", "redness", "sensitive"],
    skinTypes: ["dry", "sensitive"],
    margin: 52.0,
    ingredients: ["ceramides", "shea butter", "peanuts", "glycerin"]
  }
];

export interface CustomerProfile {
  name: string;
  skinType: string;
  concerns: string[];
  skipCount: number;
  emailOpenRate: number; // 0 to 100
  failedPaymentCount?: number;
  tenureMonths?: number;
  zipCode?: string;
  localClimate?: string;
  allergens?: string[];
  deliveredProductIds?: string[];
}

export interface InventoryItem {
  stockLevel: number;
  expiryDays: number;
}

export function calculateChurnRisk(customer: CustomerProfile) {
  let riskScore = 15.0; // Base risk
  const flaggedReasons: string[] = [];

  const tenure = customer.tenureMonths ?? 1;
  const skips = customer.skipCount ?? 0;
  const failedPayments = customer.failedPaymentCount ?? 0;

  // Skip count penalty: Recency-weighted skip decay
  if (skips > 0) {
    const penalty = (skips * 25.0) / Math.max(1, tenure);
    riskScore += penalty;
    flaggedReasons.push(`skipped last ${skips} boxes (tenure: ${tenure} mo)`);
  }

  // Failed payments: critical billing decay (the strongest Churn predictor)
  if (failedPayments > 0) {
    const penalty = failedPayments * 35.0;
    riskScore += penalty;
    flaggedReasons.push(`billing failure: ${failedPayments} card decline retries`);
  }

  // Email engagement check
  if (customer.emailOpenRate < 20.0) {
    riskScore += 20.0;
    flaggedReasons.push("unopened emails (open rate < 20%)");
  } else if (customer.emailOpenRate > 80.0) {
    riskScore -= 10.0; // Reward highly engaged
  }

  // Bound the score between 0 and 100
  riskScore = Math.max(0.0, Math.min(100.0, riskScore));

  const status = riskScore >= 60.0 ? "AT_RISK" : (riskScore <= 20.0 ? "LOYAL" : "DORMANT");

  return { riskScore, status, flaggedReasons };
}

export function generateCurationSuggestions(
  profile: CustomerProfile, 
  products = MOCK_PRODUCTS,
  inventoryDb: Record<string, InventoryItem> = {}
) {
  const profileConcerns = profile.concerns.map(c => c.toLowerCase());
  const profileSkinType = profile.skinType.toLowerCase();
  const profileAllergens = (profile.allergens || []).map(a => a.toLowerCase().trim());
  const deliveredProductIds = profile.deliveredProductIds || [];

  const results = products.map(product => {
    const matchesSkinType = product.skinTypes.includes(profileSkinType);
    if (!matchesSkinType) {
      return { ...product, score: 0, reason: "Incompatible skin type" };
    }

    // 1. Allergen Gating: Check overlapping allergens
    const matchingAllergens = product.ingredients.filter(ing => 
      profileAllergens.some(allerg => ing.toLowerCase().includes(allerg))
    );
    if (matchingAllergens.length > 0) {
      return { ...product, score: 0, reason: `Allergen conflict: contains ${matchingAllergens.join(", ")}` };
    }

    let score = 50; // Starting base score for compatible skin type
    const matchingConcerns = product.concerns.filter(concern => profileConcerns.includes(concern.toLowerCase()));

    // Boost score based on concern alignment
    score += matchingConcerns.length * 20;

    // High margin boost
    if (product.margin >= 60.0) {
      score += 10;
    }

    let reason = "Standard match";
    if (matchingConcerns.length > 0) {
      reason = `Perfect concern match for: ${matchingConcerns.join(", ")}`;
    } else {
      reason = "General skin type compatibility match";
    }

    // 2. Weather & Seasonal Climate Adaptation (Dry, Humid, Temperate, Cold)
    const climate = profile.localClimate || "temperate";
    if (climate === "dry") {
      if (product.id === "prod-vit-c" || product.id === "prod-ceramide") {
        score += 25;
        reason += " | Weather/Climate Boost (Dry Climate)";
      }
    } else if (climate === "humid") {
      if (product.id === "prod-salicylic") {
        score += 25;
        reason += " | Weather/Climate Boost (Humid Climate)";
      }
    } else if (climate === "cold") {
      if (product.id === "prod-ceramide") {
        score += 25;
        reason += " | Weather/Climate Boost (Cold Climate)";
      }
    }

    // 3. Inventory Bandit Boosting
    const inventory = inventoryDb[product.id];
    if (inventory) {
      if (inventory.stockLevel > 1000 || inventory.expiryDays < 60) {
        score += 30;
        reason += ` | Inventory Bandit Boost (Stock: ${inventory.stockLevel})`;
      }
    }

    // 4. Saturation Decay: historically received products penalty
    if (deliveredProductIds.includes(product.id)) {
      score = Math.round(score * 0.2); // Apply -80% penalty
      reason += " | Saturation Penalty applied (historically delivered)";
    }

    return { ...product, score, reason };
  });

  return results.filter(r => r.score > 0).sort((a, b) => b.score - a.score);
}

describe("Beauty Subscription Optimizer Unit Tests — Churn Prediction & AI Curation", () => {
  it("should correctly identify a customer with multiple skips and low email engagement as AT_RISK", () => {
    const atRiskCustomer: CustomerProfile = {
      name: "Jessica Alchemist",
      skinType: "dry",
      concerns: ["aging", "dryness"],
      skipCount: 2,
      emailOpenRate: 15.0 // very low
    };

    const audit = calculateChurnRisk(atRiskCustomer);
    expect(audit.riskScore).toBe(85.0); // 15 + 50 + 20
    expect(audit.status).toBe("AT_RISK");
    expect(audit.flaggedReasons).toContain("skipped last 2 boxes (tenure: 1 mo)");
    expect(audit.flaggedReasons).toContain("unopened emails (open rate < 20%)");
  });

  it("should reward highly engaged customers with a LOYAL status and low risk score", () => {
    const loyalCustomer: CustomerProfile = {
      name: "Rohit Clay",
      skinType: "oily",
      concerns: ["acne"],
      skipCount: 0,
      emailOpenRate: 90.0 // very high
    };

    const audit = calculateChurnRisk(loyalCustomer);
    expect(audit.riskScore).toBe(5.0); // 15 - 10
    expect(audit.status).toBe("LOYAL");
    expect(audit.flaggedReasons.length).toBe(0);
  });

  it("should curate and prioritize products matching dry skin and aging concerns", () => {
    const dryAgedCustomer: CustomerProfile = {
      name: "Jessica Alchemist",
      skinType: "dry",
      concerns: ["aging", "dryness"],
      skipCount: 2,
      emailOpenRate: 15.0
    };

    const recs = generateCurationSuggestions(dryAgedCustomer);
    expect(recs[0].id).toBe("prod-vit-c"); // Serum has dullness/aging + high margin (62.5%) -> score 50 + 20 (aging) + 10 (margin) = 80
    expect(recs[1].id).toBe("prod-ceramide"); // Ceramide Repair Cream has dryness concern -> score 50 + 20 (dryness) = 70
    expect(recs.some(r => r.id === "prod-salicylic")).toBe(false); // Salicylic Acid is oily/combination only!
  });

  it("should curate Salicylic Acid Acne Cleanser for oily skin with acne", () => {
    const oilyAcneCustomer: CustomerProfile = {
      name: "Oily Acne Profile",
      skinType: "oily",
      concerns: ["acne"],
      skipCount: 0,
      emailOpenRate: 50.0
    };

    const recs = generateCurationSuggestions(oilyAcneCustomer);
    expect(recs[0].id).toBe("prod-salicylic"); // score 50 + 20 (acne) = 70
    expect(recs.some(r => r.id === "prod-ceramide")).toBe(false); // Ceramide is dry/sensitive only!
  });

  // --- HARDCORE PREDICTIVE ENGINE UPGRADE UNIT TESTS ---

  it("should calculate recency-weighted skip decay (skip forgiveness based on customer tenure)", () => {
    const freshSkipper: CustomerProfile = {
      name: "Month 1 Skipper",
      skinType: "dry",
      concerns: [],
      skipCount: 1,
      emailOpenRate: 50.0,
      tenureMonths: 1 // month 1
    };

    const loyalVetsSkipper: CustomerProfile = {
      name: "Month 12 Skipper",
      skinType: "dry",
      concerns: [],
      skipCount: 1,
      emailOpenRate: 50.0,
      tenureMonths: 12 // month 12 (loyal veteran)
    };

    const auditFresh = calculateChurnRisk(freshSkipper);
    const auditVet = calculateChurnRisk(loyalVetsSkipper);

    // Month 1 skipper penalty is (1 * 25.0) / 1 = 25.0 -> risk score is 15 + 25 = 40.0
    expect(auditFresh.riskScore).toBe(40.0);
    // Month 12 skipper penalty is (1 * 25.0) / 12 = 2.0833 -> risk score is 15 + 2.0833 = 17.08
    expect(auditVet.riskScore).toBeCloseTo(17.08, 1);
  });

  it("should trigger critical risk on failed billing payment dunning declines", () => {
    const dunningCustomer: CustomerProfile = {
      name: "Decline Victim",
      skinType: "dry",
      concerns: [],
      skipCount: 0,
      emailOpenRate: 50.0,
      failedPaymentCount: 2 // 2 credit card retry declines
    };

    const audit = calculateChurnRisk(dunningCustomer);
    // 15 base + (2 * 35.0) = 85.0
    expect(audit.riskScore).toBe(85.0);
    expect(audit.status).toBe("AT_RISK");
    expect(audit.flaggedReasons).toContain("billing failure: 2 card decline retries");
  });

  it("should strictly apply allergen gating (block product suggestions containing active allergens)", () => {
    const peanutAllergicCustomer: CustomerProfile = {
      name: "Peanut Allergic Customer",
      skinType: "dry",
      concerns: ["dryness"],
      skipCount: 0,
      emailOpenRate: 50.0,
      allergens: ["peanuts"] // allergic to peanuts!
    };

    const recs = generateCurationSuggestions(peanutAllergicCustomer);
    // Ceramide Repair Cream contains "peanuts" in ingredients list, must be filtered out!
    expect(recs.some(r => r.id === "prod-ceramide")).toBe(false);
  });

  it("should apply saturation decay penalty to historically delivered product IDs", () => {
    const saturatedCustomer: CustomerProfile = {
      name: "Saturated Customer",
      skinType: "dry",
      concerns: ["aging"],
      skipCount: 0,
      emailOpenRate: 50.0,
      deliveredProductIds: ["prod-vit-c"] // already received Vitamin C Brightening Serum!
    };

    const recs = generateCurationSuggestions(saturatedCustomer);
    const vitC = recs.find(r => r.id === "prod-vit-c");
    expect(vitC).toBeDefined();
    // Normal score: 50 + 20 (aging) + 10 (margin) = 80. Saturated score: Math.round(80 * 0.2) = 16!
    expect(vitC!.score).toBe(16);
    expect(vitC!.reason).toContain("Saturation Penalty applied");
  });

  it("should apply weather and regional climate boost for Dry Climate", () => {
    const dryClimateCustomer: CustomerProfile = {
      name: "Dry Climate Customer",
      skinType: "dry",
      concerns: ["aging"],
      skipCount: 0,
      emailOpenRate: 50.0,
      localClimate: "dry"
    };

    const recs = generateCurationSuggestions(dryClimateCustomer);
    const vitC = recs.find(r => r.id === "prod-vit-c");
    // Normal score: 50 + 20 (aging) + 10 (margin) = 80. Weather boost (+25) -> score is 105!
    expect(vitC!.score).toBe(105);
    expect(vitC!.reason).toContain("Weather/Climate Boost (Dry Climate)");
  });

  it("should aggressively push overstocked items using inventory bandit boosting", () => {
    const normalCustomer: CustomerProfile = {
      name: "Standard Client",
      skinType: "dry",
      concerns: ["aging"],
      skipCount: 0,
      emailOpenRate: 50.0
    };

    const inventoryDb = {
      "prod-vit-c": { stockLevel: 1500, expiryDays: 120 } // Overstocked (>1000)
    };

    const recs = generateCurationSuggestions(normalCustomer, MOCK_PRODUCTS, inventoryDb);
    const vitC = recs.find(r => r.id === "prod-vit-c");
    // Normal score: 50 + 20 (aging) + 10 (margin) = 80. Bandit boost (+30) -> score is 110!
    expect(vitC!.score).toBe(110);
    expect(vitC!.reason).toContain("Inventory Bandit Boost");
  });
});
