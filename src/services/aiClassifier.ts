import type { ChatMessage } from "@/agents/core";
import { OpenAIService } from "./openai";
import type { ClassifiedFacts } from "@/types/nutrition";

/**
 * AI‑только классификатор: просит модель извлечь факты сразу в канонизированном виде.
 * Возвращает факты и оценку уверенности (0..1).
 */
export class AiClassifier {
  constructor(private ai: OpenAIService) {}

  async classify(messages: ChatMessage[], profile?: any): Promise<{ facts: ClassifiedFacts; confidence: number; resolved: { householdAllergies?: string[]; householdNoAllergies?: boolean; householdDislikes?: string[]; members?: Array<{ name?: string; resolvedAllergies?: string[]; resolvedDislikes?: string[]; noAllergies?: boolean }> } }> {
    const system = [
      "Ты — классификатор фактов о питании.",
      "Задача: из истории диалога извлечь ПРЕДПОЧТЕНИЯ (нелюбимые), ЛЮБИМЫЕ и АЛЛЕРГИИ",
      "для домохозяйства и для членов семьи. Верни строго JSON.",
      "Канонизируй элементы (единая форма на русском), например: \"курица\", \"рис\", \"гречка\", \"говядина\", \"морепродукты\".",
      "Строго различай: \"аллергия/непереносимость\" ≠ \"не любит/избегает\".",
      "Если субъект: \"мы/мы оба\" — относись как household, и при наличии членов семьи можешь также продублировать в их dislikes.",
      "Если субъект: \"я\" — относись к мужу (при семейной паре), \"она\" — к жене.",
      "Укажи поле confidence (число 0..1) — насколько ты уверен в классификации.",
      "Если явно сказано, что аллергии больше НЕТ (например: 'нет аллергии на X', 'аллергия прошла'), внеси X в поля resolvedAllergies, а НЕ в allergies.",
      "Если сказано ОБЩЕЕ снятие без указания продукта (например: 'нет аллергий', 'аллергии вылечили', 'больше нет аллергий'),",
      "то добавь householdNoAllergies: true (для 'мы/у нас') или noAllergies: true внутри соответствующего члена семьи.",
      "Если просят убрать из 'нелюбимых' (например: 'убери X из списка нелюбимых', 'больше не считаем X нелюбимыми', 'X теперь ок'),",
      "внеси X в поля resolvedDislikes (а НЕ в dislikes).",
      "Схема JSON: {",
      "  householdLikes: string[],",
      "  householdDislikes: string[],",
      "  householdAllergies: string[],",
      "  householdResolvedAllergies: string[],",
      "  householdResolvedDislikes: string[],",
      "  householdNoAllergies: boolean,",
      "  members: Array<{ name?: string; likes?: string[]; dislikes?: string[]; allergies?: string[] }>,",
      "  membersResolved: Array<{ name?: string; resolvedAllergies?: string[]; resolvedDislikes?: string[]; noAllergies?: boolean }>,",
      "  confidence: number",
      "}",
      "Возвращай ТОЛЬКО JSON без пояснений.",
    ].join("\n");

    const msgs: ChatMessage[] = [];
    // Включаем всю историю пользователя и ассистента — у сервиса уже есть system из агента
    msgs.push(...messages);
    if (profile) {
      msgs.push({ role: "system", content: `Профиль пользователя (JSON): ${JSON.stringify(profile)}` });
    }

    const raw = await this.ai.extractJson(msgs, system);
    const facts: ClassifiedFacts = {
      householdLikes: Array.isArray(raw?.householdLikes) ? raw.householdLikes : [],
      householdDislikes: Array.isArray(raw?.householdDislikes) ? raw.householdDislikes : [],
      householdAllergies: Array.isArray(raw?.householdAllergies) ? raw.householdAllergies : [],
      members: Array.isArray(raw?.members) ? raw.members : [],
    };
    const confidence = typeof raw?.confidence === "number" && Number.isFinite(raw.confidence) ? raw.confidence : 0.5;
    const resolved = {
      householdAllergies: Array.isArray(raw?.householdResolvedAllergies) ? raw.householdResolvedAllergies : [],
      householdNoAllergies: Boolean(raw?.householdNoAllergies) === true,
      householdDislikes: Array.isArray(raw?.householdResolvedDislikes) ? raw.householdResolvedDislikes : [],
      members: Array.isArray(raw?.membersResolved)
        ? raw.membersResolved.map((m: any) => ({
            name: m?.name,
            resolvedAllergies: Array.isArray(m?.resolvedAllergies) ? m.resolvedAllergies : [],
            resolvedDislikes: Array.isArray(m?.resolvedDislikes) ? m.resolvedDislikes : [],
            noAllergies: Boolean(m?.noAllergies) === true,
          }))
        : Array.isArray(raw?.members)
        ? raw.members.map((m: any) => ({
            name: m?.name,
            resolvedAllergies: Array.isArray(m?.resolvedAllergies) ? m.resolvedAllergies : [],
            resolvedDislikes: Array.isArray(m?.resolvedDislikes) ? m.resolvedDislikes : [],
            noAllergies: Boolean(m?.noAllergies) === true,
          }))
        : [],
    };
    return { facts, confidence, resolved };
  }
}

export default AiClassifier;