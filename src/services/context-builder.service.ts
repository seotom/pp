// src/services/context-builder.service.ts
import { DatabaseService } from "./database.service";
import { UserData } from "@/types/chat.types";
import { CanonicalizationService } from "./canonicalization";

export class ContextBuilderService {
  private databaseService = new DatabaseService();
  private canonicalizationService = new CanonicalizationService();

  private BASE_SYSTEM_PROMPT = `
  Ты - дружелюбный и умный AI-помощник по семейному питанию. 
  Твоя задача — помогать пользователю с планированием питания и вести диалог так, чтобы пошагово собрать нужные данные.

  ОСНОВНЫЕ ПРАВИЛА:

  1. Сначала последовательно собери полные данные в 5 шагах:
    Шаг 1 — состав семьи (количество человек, возраст и вес каждого, все пункты обязательны);
    Шаг 2 — бюджет на неделю (в рублях);
    Шаг 3 — любимые и нелюбимые продукты;
    Шаг 4 — аллергии на продукты;
    Шаг 5 — цели (например: похудеть, улучшить питание, набрать массу, экономить и т.д.).

  2. ОТВЕЧАЙ НА ЛЮБЫЕ ВОПРОСЫ О ПИТАНИИ:
   - Различия продуктов (макароны vs спагетти, гречка vs рис)
   - Пищевая ценность, состав продуктов
   - Советы по готовке, хранению продуктов
   - Бюджетное планирование питания
   - Здоровые альтернативы продуктам

    3. ОГРАНИЧЕНИЯ (ЧЕГО НЕ ДЕЛАТЬ):
    - НЕ ставить медицинские диагнозы
    - НЕ назначать лекарства или лечение
    - НЕ давать советы по серьезным заболеваниям
    - НЕ обсуждать политику, религию, развлечения

    4. КОГДА ВСЕ 5 ШАГОВ ЗАВЕРШЕНЫ:
    - Предлагай генерацию плана питания
    - Помогай с рекомендациями и шопинг-листами

    ПРИМЕРЫ РАЗРЕШЕННЫХ ТЕМ:
    ✅ "Чем отличаются макароны от спагетти?" - ОТВЕЧАЙ
    ✅ "Что полезнее: гречка или рис?" - ОТВЕЧАЙ  
    ✅ "Как хранить овощи?" - ОТВЕЧАЙ
    ✅ "Какие дешевые аналоги дорогих продуктов?" - ОТВЕЧАЙ
    ✅ "Сколько белка в курице?" - ОТВЕЧАЙ

    ПРИМЕРЫ ЗАПРЕЩЕННЫХ ТЕМ:
    ❌ "У меня болит живот, что делать?" - ВЕЖЛИВО ОТКАЖИ
    ❌ "Какое лекарство от аллергии?" - ВЕЖЛИВО ОТКАЖИ
    ❌ "Какую музыку слушать за едой?" - ВЕРНИ К ТЕМЕ

    ВЕЖЛИВЫЙ ОТКАЗ: "Извините, я не могу давать медицинские рекомендации. Как помощник по питанию, я могу помочь с планированием меню или подбором продуктов."

    КЛЮЧЕВЫЕ СООБЩЕНИЯ:
    - Питаться правильно можно даже экономя.
    - Продуманный список покупок — основа здоровья семьи.
    - Покупайте с умом — не отказывайтесь от полезного.

    ИСТОЧНИКИ:

    - Российские нормы питания (МР 2.3.1.0253-21).
    - Данные о составе продуктов.
    - Усредненные цены российских магазинов.
`;

  buildKnownDataSummary(data: UserData | null): string {
    if (!data) {
      return "Известных данных пока нет.";
    }
    
    const segments: string[] = [];
    const family = data.family || [];
    
    if (family.length > 0) {
      const memberLines = family
        .map((member, index) => {
          const name = member.name || `Участник ${index + 1}`;
          const age = typeof member.age === "number" && !Number.isNaN(member.age) ? `${member.age} лет` : "возраст не указан";
          const weight = typeof member.weight === "number" && !Number.isNaN(member.weight) ? `${member.weight} кг` : "вес не указан";
          
          // 🔄 ИНТЕГРАЦИЯ CANONICALIZATION SERVICE - НОРМАЛИЗАЦИЯ ПРИ ОТОБРАЖЕНИИ
          const normalizedLikes = this.canonicalizationService.canonicalizeList(member.likes || []);
          const normalizedDislikes = this.canonicalizationService.canonicalizeList(member.dislikes || []);
          const normalizedAllergies = this.canonicalizationService.canonicalizeList(member.allergies || []);
          
          const likes = normalizedLikes.join(", ") || "не указаны";
          const dislikes = normalizedDislikes.join(", ") || "не указаны";
          const allergies = normalizedAllergies.join(", ") || "не указаны";
          
          return `- ${name}: ${age}, ${weight}. Любимые: ${likes}. Нелюбимые: ${dislikes}. Аллергии: ${allergies}.`;
        })
        .join("\n");
      segments.push(`Состав семьи:\n${memberLines}`);
    }

    const budgetValue = data.profile?.budget;
    if (typeof budgetValue === "number" && !Number.isNaN(budgetValue)) {
      segments.push(`Бюджет на неделю: ${budgetValue} руб.`);
    }

    const goalsValue = typeof data.profile?.goals === "string" ? data.profile.goals.trim() : "";
    if (goalsValue.length > 0) {
      segments.push(`Цели: ${goalsValue}.`);
    }

    return segments.length === 0 ? "Известных данных пока нет." : segments.join("\n");
  }

  buildStepGuidance(data: UserData | null): string {
    const family = data?.family || [];
    const hasCompleteFamily = family.length > 0 && family.every((member) => {
      const hasName = typeof member.name === "string" && member.name.trim().length > 0;
      const hasAge = typeof member.age === "number" && !Number.isNaN(member.age);
      const hasWeight = typeof member.weight === "number" && !Number.isNaN(member.weight);
      return hasName && hasAge && hasWeight;
    });

    if (!hasCompleteFamily) {
      return "Шаг 1: сначала уточни состав семьи — сколько человек, их возраст и вес каждого. Если чего-то не хватает, вежливо запроси эти данные.";
    }

    const budgetValue = data?.profile?.budget;
    const hasBudget = typeof budgetValue === "number" && !Number.isNaN(budgetValue);
    if (!hasBudget) {
      return "Шаг 2: запроси недельный бюджет семьи на питание в рублях. Не переходи к следующим шагам, пока бюджет не указан.";
    }

    const hasPreferences = family.every((member) => Array.isArray(member.likes) && Array.isArray(member.dislikes));
    if (!hasPreferences) {
      return "Шаг 3: уточни любимые и нелюбимые продукты по каждому члену семьи. Можно отметить, если у кого-то нет выраженных предпочтений.";
    }

    const hasAllergies = family.every((member) => Array.isArray(member.allergies));
    if (!hasAllergies) {
      return "Шаг 4: попроси перечислить пищевые аллергии или подтвердить, что их нет.";
    }

    const goalsValue = typeof data?.profile?.goals === "string" ? data.profile?.goals?.trim() : "";
    const hasGoals = !!goalsValue;
    if (!hasGoals) {
      return "Шаг 5: уточни цели питания (например, экономия, ЗОЖ, похудение). После получения целей предложи сформировать план.";
    }

    return "Все шаги выполнены. Поддерживай тему питания и при необходимости предложи составить план питания на основе собранных данных.";
  }

  async buildSystemContext(userId: string): Promise<string> {
    const userData = await this.databaseService.getUserData(userId);
    const stepGuidance = this.buildStepGuidance(userData);
    const knownDataSummary = this.buildKnownDataSummary(userData);

    return [
      this.BASE_SYSTEM_PROMPT,
      `Текущий статус сбора данных: ${stepGuidance}`,
      `Известные данные профиля: ${knownDataSummary}`,
      "Всегда поддерживай последовательность шагов и не переходи к следующему, пока предыдущий не закрыт.",
    ].join("\n\n");
  }
}