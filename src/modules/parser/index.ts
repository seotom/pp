// src\modules\parser\index.ts

import { buildChatPrompt } from "@/modules/prompt-builder";
import {
  loadConversationHistory,
  formatHistoryForPrompt,
} from "@/modules/conversation-history";
import { resolveEntities } from "@/modules/entity-resolver";
import { analyzeIntent } from "@/modules/intent-analyzer";
import { applyUpdates } from "@/modules/update-applier";
import { handleClarification } from "@/modules/clarification-handler";
import { canonicalizeFoodItems } from "@/modules/canonicalization";
import {
  checkStepProgress,
  markPrimaryMemberStepComplete,
  markBudgetStepComplete,
  markFamilyStepComplete,
} from "@/modules/step-controller";
import { getSupabaseServiceRoleClient } from "@/lib/supabase";

type ParseUserMessageResult = {
  content: string;
};

// ✅ ИСПРАВЛЕННАЯ: Функция для формирования контекста из БД
async function buildProfileContext(userId: string): Promise<string> {
  const supabase = getSupabaseServiceRoleClient();

  const { data: profile } = await supabase
    .from("profiles")
    .select("id, budget, goals, family_data")
    .eq("user_id", userId)
    .single();

  if (!profile) {
    return "";
  }

  // ✅ НОВОЕ: Загружаем членов семьи ОТДЕЛЬНО с фильтром по profile_id
  const { data: familyMembers } = await supabase
    .from("family_members")
    .select("id, name, age, weight")
    .eq("profile_id", profile.id);

  let context = "";
  const members = familyMembers || [];
  const familyData = profile.family_data as any;

  console.log("📋 Building profile context:", {
    profileId: profile.id,
    membersCount: members.length,
    memberNames: members.map((m) => m.name),
  });

  // Состав семьи
  if (members.length > 0) {
    context += `✅ Семья (${members.length}): ${members
      .map((m: any) => `${m.name} (${m.age} лет, ${m.weight} кг)`)
      .join(", ")}\n`;
  } else {
    context += "❌ Семья: не указана\n";
  }

  // Основной представитель
  if (familyData?.primary_member_id) {
    const primaryMember = members.find(
      (m: any) => m.id === familyData.primary_member_id
    );
    if (primaryMember) {
      context += `✅ Основной представитель: ${primaryMember.name}\n`;
    }
  }

  // Бюджет
  if (profile.budget) {
    context += `✅ Бюджет на неделю: ${profile.budget} ₽\n`;
  } else {
    context += "❌ Бюджет: не указан\n";
  }

  // Цели
  if (profile.goals && Array.isArray(profile.goals) && profile.goals.length > 0) {
    context += `✅ Цели: ${profile.goals.join(", ")}\n`;
  }

  return context;
}

export async function parseUserMessage(
  message: string,
  userId: string,
): Promise<ParseUserMessageResult> {
  const supabase = getSupabaseServiceRoleClient();

  // 🔹 1. спец-ветка: выбор представителя семьи (кнопками)
  if (message.startsWith("primary_member:")) {
    const memberName = message.split(":")[1]?.trim();
    if (!memberName) {
      return { content: "Пожалуйста, выберите имя представителя семьи." };
    }

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
      return {
        content: `Не удалось найти члена семьи с именем "${memberName}".`,
      };
    }

    await markPrimaryMemberStepComplete(profile.id, member.id);

    const { nextStep } = await checkStepProgress(userId);
    const responseMessage =
      nextStep === "budget"
        ? "Отлично! Теперь расскажите, какой у вас недельный бюджет на питание (в рублях)?"
        : `Отлично! ${member.name} теперь будет основным представителем семьи.`;

    return { content: responseMessage };
  }

  // ✅ НОВОЕ: Загружаем историю
  const history = await loadConversationHistory(userId, 5);
  const historyForPrompt = formatHistoryForPrompt(history);

  // ✅ НОВОЕ: Загружаем контекст профиля
  const profileContext = await buildProfileContext(userId);

  // 🔹 2. обычная ветка: отправляем в OpenAI с контекстом
  const prompt = buildChatPrompt({
    message,
    profileContext,
    conversationHistory: historyForPrompt,
  });

  const { message: aiMessage, intent } = await analyzeIntent(prompt);

  const resolvedIntent = await resolveEntities({
    userId,
    intent,
  });

  console.log("🔍 DEBUG resolvedIntent.newMembers:", resolvedIntent.newMembers);
  console.log("🔍 DEBUG resolvedIntent.membersToDelete:", resolvedIntent.membersToDelete);

  const canonicalIntent = canonicalizeFoodItems(resolvedIntent);

  const clarificationResult = await handleClarification({
    userId,
    message,
    intent: canonicalIntent,
  });

  if (clarificationResult.requiresClarification) {
    const clarificationContent =
      clarificationResult.clarificationContent ??
      aiMessage ??
      "Мне нужно чуть больше информации, чтобы продолжить.";

    return { content: clarificationContent };
  }

  // ✅ НОВОЕ: Обрабатываем удаление членов
  if (
    clarificationResult.intent.membersToDelete &&
    clarificationResult.intent.membersToDelete.length > 0
  ) {
    console.log(
      "✅ MEMBERS TO DELETE - Total:",
      clarificationResult.intent.membersToDelete.length
    );

    // Применяем изменения (включая удаление)
    const updateSummary = await applyUpdates({
      intent: clarificationResult.intent,
    });

    const deletedNames = clarificationResult.intent.membersToDelete
      .map((m) => m.name)
      .join(", ");

    const responseMessage = updateSummary || `✅ ${deletedNames} удалены из семьи.`;

    return { content: responseMessage };
  }

  // применяем изменения
  const updateSummary = await applyUpdates({
    intent: clarificationResult.intent,
  });

  console.log(
    "🔍 DEBUG: newMembers count:",
    clarificationResult.intent.newMembers?.length
  );
  console.log(
    "🔍 DEBUG: newMembers data:",
    JSON.stringify(clarificationResult.intent.newMembers, null, 2)
  );

  const { nextStep, members } = await checkStepProgress(userId);
  console.log("🔍 DEBUG: nextStep after applyUpdates:", nextStep);
  console.log("🔍 DEBUG: members count:", members.length);

  if (
    clarificationResult.intent.newMembers &&
    clarificationResult.intent.newMembers.length > 0
  ) {
    console.log(
      "✅ NEW MEMBERS DETECTED - Total new members:",
      clarificationResult.intent.newMembers.length
    );

    if (nextStep === "primary_member") {
      console.log(
        "✅ nextStep === primary_member - SHOWING PRIMARY MEMBER SELECTOR"
      );

      const { data: profile } = await supabase
        .from("profiles")
        .select("id")
        .eq("user_id", userId)
        .maybeSingle();

      if (profile) {
        console.log("📝 Marking family step as complete");
        await markFamilyStepComplete(profile.id);
      }

      const jsonContent = JSON.stringify({
        type: "choose_primary_member",
        message:
          "Отлично! Я добавил новых членов семьи. Кто из них будет основным представителем для планирования питания?",
        members: members.map((m) => ({
          id: m.id,
          name: m.name,
        })),
      });

      return { content: jsonContent };
    } else {
      // ✅ НОВОЕ: Не использовать aiMessage при добавлении новых членов!
      // Используем статический текст, чтобы избежать повторного вопроса о бюджете
      const newMembersNames = clarificationResult.intent.newMembers
        .map((m) => m.name)
        .join(", ");

      let newMembersResponse = `✅ Отлично! ${newMembersNames} теперь в вашей семье.`;

      // Переходим к следующему корректному шагу
      if (nextStep === "likes") {
        newMembersResponse += " Теперь расскажите, какие продукты вы и ваша семья любите?";
      } else if (nextStep === "allergies") {
        newMembersResponse += " Теперь важно узнать об аллергиях. Есть ли аллергии у кого-нибудь из семьи?";
      } else if (nextStep === "goals") {
        newMembersResponse += " И последнее — какие у вас цели по питанию? (например: здоровое питание, похудение, набор мышечной массы)";
      } else if (nextStep === "budget") {
        newMembersResponse += " Теперь расскажите, какой у вас недельный бюджет на питание (в рублях)?";
      } else if (nextStep === "complete") {
        newMembersResponse += " Спасибо! Все данные собраны. Я готов помочь с планированием питания для вашей семьи!";
      }

      return { content: newMembersResponse };
    }
  }

  // ✅ Определяем финальный ответ
  let finalResponse = "";

  // ✅ НОВОЕ: Проверяем, есть ли уже бюджет в profileContext
  const budgetAlreadySet = profileContext.includes("✅ Бюджет на неделю:");

  // Стандартный flow для остальных шагов
  if (nextStep === "family") {
    finalResponse =
      aiMessage ||
      "Давайте начнём с семьи. Расскажите, кто входит в вашу семью? Укажите возраст и вес каждого.";
  } else if (nextStep === "primary_member") {
    console.log(
      "⚠️ primary_member step but no new members detected - showing standard selector"
    );
    const jsonContent = JSON.stringify({
      type: "choose_primary_member",
      message: "Кто будет основным представителем семьи?",
      members: members.map((m) => ({
        id: m.id,
        name: m.name,
      })),
    });
    finalResponse = jsonContent;
  } else if (nextStep === "budget" && !budgetAlreadySet) {
    // ✅ ИСПРАВЛЕНО: Спрашиваем бюджет только если его нет
    finalResponse =
      aiMessage ||
      "Теперь расскажите, какой у вас недельный бюджет на питание (в рублях)?";
  } else if (nextStep === "budget" && budgetAlreadySet) {
    // ✅ НОВОЕ: Если бюджет уже есть, пропускаем к следующему шагу
    finalResponse =
      aiMessage ||
      "Спасибо за информацию! Переходим к следующему шагу.";
  } else if (nextStep === "likes") {
    finalResponse =
      aiMessage ||
      "Отлично! Теперь расскажите, какие продукты вы и ваша семья любите?";
  } else if (nextStep === "allergies") {
    finalResponse =
      aiMessage ||
      "Теперь важно узнать об аллергиях. Есть ли аллергии у кого-нибудь из семьи?";
  } else if (nextStep === "goals") {
    finalResponse =
      aiMessage ||
      "И последнее — какие у вас цели по питанию? (например: здоровое питание, похудение, набор мышечной массы)";
  } else if (nextStep === "complete") {
    finalResponse =
      aiMessage ||
      "Спасибо! Все данные собраны. Я готов помочь с планированием питания для вашей семьи!";
  } else {
    finalResponse = aiMessage || updateSummary || "Готово.";
  }

  return { content: finalResponse };
}

export type { ParseUserMessageResult };
