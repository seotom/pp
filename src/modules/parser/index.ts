// src/modules/parser/index.ts

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
import type { FamilyMemberRow } from "@/types/database"; // Импортируем тип

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

  // Загружаем членов семьи ОТДЕЛЬНО с фильтром по profile_id
  const { data: familyMembers } = await supabase
    .from("family_members")
    .select("*") // <--- Загружаем всё
    .eq("profile_id", profile.id);

  const members = (familyMembers as FamilyMemberRow[] | null) || [];
  const familyData = profile.family_data as any;

  let contextLines: string[] = [];

  console.log("📋 Building profile context:", {
    profileId: profile.id,
    membersCount: members.length,
    memberNames: members.map((m: FamilyMemberRow) => m.name),
  });

  if (members.length > 0) {
    const memberDetails = members.map((m: FamilyMemberRow) => {
        let details = `${m.name} (${m.age ?? 'возраст не указан'} лет, ${m.weight ?? 'вес не указан'} кг)`;
        const prefs = [];
        if (m.likes?.length) prefs.push(`любит: ${m.likes.join(', ')}`);
        if (m.dislikes?.length) prefs.push(`не любит: ${m.dislikes.join(', ')}`);
        if (m.allergies?.length) prefs.push(`аллергия: ${m.allergies.join(', ')}`);
        if (prefs.length) details += ` | ${prefs.join('; ')}`;
        return details;
    }).join('\n'); // Используем '\n' для лучшей читаемости
    contextLines.push(`✅ Семья (${members.length}):\n${memberDetails}`);
  } else {
    contextLines.push("❌ Семья: не указана");
  }

  if (familyData?.primary_member_id) {
    const primaryMember = members.find((m: FamilyMemberRow) => m.id === familyData.primary_member_id);
    if (primaryMember) {
      contextLines.push(`✅ Основной представитель: ${primaryMember.name}`);
    }
  }

  if (profile.budget) {
    contextLines.push(`✅ Бюджет на неделю: ${profile.budget} ₽`);
  } else {
    contextLines.push("❌ Бюджет: не указан");
  }

  if (profile.goals && Array.isArray(profile.goals) && profile.goals.length > 0) {
    contextLines.push(`✅ Цели: ${profile.goals.join(", ")}`);
  }

  return contextLines.join("\n\n"); // Разделяем блоки двойным переводом строки
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

  // Загружаем историю
  const history = await loadConversationHistory(userId, 5);
  const historyForPrompt = formatHistoryForPrompt(history);

  // Загружаем контекст профиля
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
  
  // Если это 'read' action, мы доверяем aiMessage, который был сгенерирован на основе ПОЛНОГО контекста
  // и немедленно возвращаем его.
  if (intent.action_type === 'read') {
    return { content: aiMessage || "Вот информация по вашему запросу." };
  }

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

  // Обрабатываем удаление членов
  if (
    clarificationResult.intent.membersToDelete &&
    clarificationResult.intent.membersToDelete.length > 0
  ) {
    console.log(
      "✅ MEMBERS TO DELETE - Total:",
      clarificationResult.intent.membersToDelete.length
    );

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
      const newMembersNames = (clarificationResult.intent.newMembers as {name: string}[])
        .map((m) => m.name)
        .join(", ");

      let newMembersResponse = `✅ Отлично! ${newMembersNames} теперь в вашей семье.`;

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

  // Определяем финальный ответ
  const finalResponse = aiMessage || updateSummary || "Готово.";
  
  return { content: finalResponse };
}

export type { ParseUserMessageResult };
