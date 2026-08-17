import { describe, it, expect } from "vitest";

// Port of matching rules for isolated unit testing of Beauty AI Curation & Churn Prediction
const MOCK_PRODUCTS = [
  {
    id: "prod-vit-c",
    title: "Vitamin C Brightening Serum",
    concerns: ["dullness", "aging"],
    skinTypes: ["dry", "combination", "oily"],
    margin: 62.5
  },
  {
    id: "prod-salicylic",
    title: "Salicylic Acid Acne Cleanser",
    concerns: ["acne", "redness"],
    skinTypes: ["oily", "combination"],
    margin: 58.0
  },
  {
    id: "prod-ceramide",
    title: "Ceramide Barrier Repair Cream",
    concerns: ["dryness", "redness", "sensitive"],
    skinTypes: ["dry", "sensitive"],
    margin: 52.0
  }
];

export interface CustomerProfile {
  name: string;
  skinType: string;
  concerns: string[];
  skipCount: number;
  emailOpenRate: number; // 0 to 100
}

export function calculateChurnRisk(customer: CustomerProfile) {
  let riskScore = 15.0; // Base risk
  const flaggedReasons: string[] = [];

  // Skip count penalty
  if (customer.skipCount > 0) {
    const penalty = customer.skipCount * 25.0;
    riskScore += penalty;
    flaggedReasons.push(`skipped last ${customer.skipCount} boxes`);
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

export function generateCurationSuggestions(profile: CustomerProfile, products = MOCK_PRODUCTS) {
  const profileConcerns = profile.concerns.map(c => c.toLowerCase());
  const profileSkinType = profile.skinType.toLowerCase();

  const results = products.map(product => {
    const matchesSkinType = product.skinTypes.includes(profileSkinType);
    if (!matchesSkinType) {
      return { ...product, score: 0, reason: "Incompatible skin type" };
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
    expect(audit.flaggedReasons).toContain("skipped last 2 boxes");
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
});
