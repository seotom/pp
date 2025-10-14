export type ActivityLevel = "low" | "moderate" | "high";

export interface FamilyMember {
  name?: string;
  age: number;
  weightKg?: number;
  activity: ActivityLevel;
  allergies?: string[];
  preferences?: string[];
}

export interface Budget {
  currency: string; // e.g. RUB, USD
  weekly: number; // weekly budget amount
}

export type Goal = "weight_loss" | "maintenance" | "health";

export interface NutritionProfile {
  family: FamilyMember[];
  budget?: Budget;
  preferences?: string[]; // household-level preferences
  allergies?: string[]; // household-level allergies
  goals?: Goal[];
}

// Факты, классифицированные AI‑классификатором (household + члены семьи)
export type ClassifiedFacts = {
  householdLikes?: string[];
  householdDislikes?: string[];
  householdAllergies?: string[];
  members?: Array<{ name?: string; likes?: string[]; dislikes?: string[]; allergies?: string[] }>;
};