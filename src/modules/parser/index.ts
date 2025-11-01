import { buildChatPrompt } from "@/modules/prompt-builder";
import { resolveEntities } from "@/modules/entity-resolver";
import { analyzeIntent } from "@/modules/intent-analyzer";
import { applyUpdates } from "@/modules/update-applier";
import { handleClarification } from "@/modules/clarification-handler";
import { canonicalizeFoodItems } from "@/modules/canonicalization";
import { getSupabaseServiceRoleClient } from "@/lib/supabase";import {
  checkStepProgress,
  markPrimaryMemberStepComplete,
  markBudgetStepComplete,
} from "@/modules/step-controller";

type ParseUserMessageResult = {
  content: string;
};

export async function parseUserMessage(
  message: string,
  userId: string,
): Promise<ParseUserMessageResult> {
  // 🔹 если пользователь выбрал основное лицо
if (message.startsWith("primary_member:")) {
  const memberName = message.split(":")[1]?.trim();
  if (!memberName) {
    return { content: "Пожалуйста, выберите имя представителя семьи." };
  }

  const supabase = getSupabaseServiceRoleClient();

  // Найдём профиль и члена семьи
  const { data: profile } = await supabase
    .from("profiles")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle();

  if (!profile) {
    return { content: "Профиль не найден." };
  }

  const { data: member } = await supabase
    .from("family_members")
    .select("id, name")
    .eq("profile_id", profile.id)
    .ilike("name", memberName)
    .maybeSingle();

  if (!member) {
    return { content: `Не удалось найти члена семьи с именем "${memberName}".` };
  }

  // Сохраняем primary_member_id
  await markPrimaryMemberStepComplete(profile.id, member.id);

  // 🔹 Проверяем следующий шаг
  const { nextStep } = await checkStepProgress(userId);
  if (nextStep === "budget") {
    return {
      content:
        "Отлично! Теперь расскажите, какой у вас недельный бюджет на питание (в рублях)?",
    };
  }

  return {
    content: `Отлично! ${member.name} теперь будет основным представителем семьи.`,
  };
}

  // 🔹 если пользователь прислал число бюджета
  const budgetMatch = message.match(/\b(\d{3,6})\b/);
  if (budgetMatch) {
    const budget = parseInt(budgetMatch[1]);
    const supabase = getSupabaseServiceRoleClient();
    const { data: profile } = await supabase
      .from("profiles")
      .select("id")
      .eq("user_id", userId)
      .maybeSingle();

    if (profile) {
      await markBudgetStepComplete(profile.id, budget);
      return {
        content: `Отлично, я записал недельный бюджет — ${budget.toLocaleString()} ₽.`,
      };
    }
  }

  // 🔹 2. Обычная логика анализа сообщений
  const prompt = buildChatPrompt({ message });
  const parsedIntent = await analyzeIntent(prompt);
  const resolvedIntent = await resolveEntities({ userId, intent: parsedIntent });
  const canonicalIntent = canonicalizeFoodItems(resolvedIntent);

  const clarificationResult = await handleClarification({
    userId,
    message,
    intent: canonicalIntent,
  });

  if (clarificationResult.requiresClarification) {
    return {
      content:
        clarificationResult.clarificationContent ??
        "Мне нужно чуть больше информации, чтобы продолжить.",
    };
  }

  // 🔹 3. Применяем обновления (сохраняем семью и пр.)
  const content = await applyUpdates({ intent: clarificationResult.intent });

  // 🔹 4. Проверяем прогресс шагов
  const { nextStep, members } = await checkStepProgress(userId);

  if (nextStep === "family") {
    return {
      content:
        "Давайте начнём с семьи. Расскажите, кто входит в вашу семью? Укажите возраст и вес каждого.",
    };
  }

  if (nextStep === "primary_member") {
    // Возвращаем структуру для фронта
    return {
      content: JSON.stringify({
        type: "choose_primary_member",
        message: "Кто будет основным представителем семьи? Это значит, что в будущем 'Я' будет относиться именно к этому члену семьи.",
        members: members.map((m) => ({
          id: m.id,
          name: m.name,
        })),
      }),
    };
  }

  return { content };
}

export type { ParseUserMessageResult };
