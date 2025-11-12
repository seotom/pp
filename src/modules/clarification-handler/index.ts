// src\modules\clarification-handler\index.ts

import { getSupabaseServiceRoleClient } from "@/lib/supabase";
import type {
  ClarificationState,
  PendingClarification,
  ResolvedIntent,
} from "@/modules/parser/types";
import type { Json } from "@/types/database";

import type { Database } from "@/types/database";
type Profile = Database["public"]["Tables"]["profiles"]["Row"];

type ClarificationContext = {
  userId: string;
  message: string;
  intent: ResolvedIntent;
};

type ClarificationResult = {
  intent: ResolvedIntent;
  requiresClarification?: boolean;
  clarificationContent?: string;
};

function buildClarificationContent(
  clarifications: PendingClarification[],
): string {
  const items = clarifications.map((clarification, index) => {
    const prefix = `${index + 1}.`;
    const target =
      clarification.requestedName ??
      (clarification.target_scope === "self"
        ? 'уточните члена семьи, который будет как "Я"'
        : "какой член семьи должен быть обновлен");

    return `${prefix} Уточните, ${target}: ${clarification.message}`;
  });

  return [
    "Еще немного информации для уточнения:",
    ...items,
    "укажите детали и сможем двигаться дальше.",
  ].join("\n");
}

export async function handleClarification(
  context: ClarificationContext,
): Promise<ClarificationResult> {
  const supabase = getSupabaseServiceRoleClient();
  const { intent, message } = context;

  const currentFamilyData =
    (intent.profile.family_data as ClarificationState | null) ?? {};

  // ✅ ВАРИАНТ 5: Обработка бюджета И зарплаты

  // 1️⃣ Если ЯВНЫЙ бюджет на неделю (любая сумма) → применяем сразу
  if (intent.budget && intent.budget > 0) {
    console.log("💰 DEBUG: Budget detected in intent:", intent.budget);

    const { error: budgetError } = await supabase
      .from("profiles")
      .update({
        budget: intent.budget,
        family_data: {
          ...currentFamilyData,
          progress: {
            ...(currentFamilyData.progress ?? {}),
            budget: true,
          },
        } as Json,
      })
      .eq("id", intent.profile.id);

    if (budgetError) {
      console.error("Failed to apply budget:", budgetError);
    } else {
      console.log("✅ Budget applied successfully:", intent.budget);

      const { data: updatedProfile } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", intent.profile.id)
        .single();

      if (updatedProfile) {
        return {
          intent: {
            ...intent,
            profile: updatedProfile as Profile,
            clarifications: [],
          },
          requiresClarification: false,
        };
      }
    }
  }

  // 2️⃣ Если упоминается ЗАРПЛАТА (но не явный бюджет) → показываем рекомендацию
  if (intent.mentioned_salary && intent.mentioned_salary > 0) {
    console.log("💼 DEBUG: Mentioned salary detected:", intent.mentioned_salary);

    // Рекомендуем 10-15% от месячного дохода
    const monthlyIncome = intent.mentioned_salary;
    const recommendedMin = Math.round(monthlyIncome * 0.1 / 4); // 10% / 4 недели
    const recommendedMax = Math.round(monthlyIncome * 0.15 / 4); // 15% / 4 недели

    console.log(
      `📊 Recommending budget: ${recommendedMin}-${recommendedMax} ₽/week`
    );

    // Создаём clarification с рекомендацией
    return {
      intent: {
        ...intent,
        clarifications: [
          {
            message: `Спасибо за информацию! Из месячного дохода ${monthlyIncome.toLocaleString()} ₽ рекомендуем выделять на питание примерно ${recommendedMin.toLocaleString()}-${recommendedMax.toLocaleString()} ₽ в неделю (это 10-15% дохода). Какой бюджет вы хотите установить?`,
            requestedName: null,
            target_scope: "unknown" as const,
            operations: {
              add_allergies: [],
              add_dislikes: [],
              add_likes: [],
              remove_allergies: [],
              remove_dislikes: [],
              remove_likes: [],
            },
          },
        ],
      },
      requiresClarification: true,
      clarificationContent: `Спасибо за информацию! Из месячного дохода ${monthlyIncome.toLocaleString()} ₽ рекомендуем выделять на питание примерно **${recommendedMin.toLocaleString()}-${recommendedMax.toLocaleString()} ₽ в неделю** (это 10-15% дохода).\n\nКакой бюджет вы хотите установить?`,
    };
  }

  // 3️⃣ Стандартная логика для остальных clarifications
  const hasClarifications = intent.clarifications.length > 0;
  const updatedFamilyData: ClarificationState = { ...currentFamilyData };

  if (hasClarifications) {
    updatedFamilyData.pending_clarification = {
      message,
      timestamp: new Date().toISOString(),
      updates_per_person: intent.clarifications,
    };
  } else if (updatedFamilyData.pending_clarification) {
    delete updatedFamilyData.pending_clarification;
  }

  const familyDataToStore =
    Object.keys(updatedFamilyData).length > 0
      ? (updatedFamilyData as Json)
      : null;

  const { data: updatedProfile, error } = await supabase
    .from("profiles")
    .update({
      family_data: familyDataToStore,
    })
    .eq("id", intent.profile.id)
    .select()
    .single();

  if (error || !updatedProfile) {
    throw error ?? new Error("Failed to update profile.family_data.");
  }

  const nextIntent: ResolvedIntent = {
    ...intent,
    profile: { ...(intent.profile as Profile), ...updatedProfile },
  };

  if (hasClarifications) {
    return {
      intent: nextIntent,
      requiresClarification: true,
      clarificationContent: buildClarificationContent(intent.clarifications),
    };
  }

  return {
    intent: nextIntent,
  };
}

export type { ClarificationContext, ClarificationResult };
