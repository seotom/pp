import { ChatMessage } from "@/agents/core";
import { OpenAIService } from "./openai";

export class DataExtractor {
  constructor(private ai: OpenAIService) {}

  async extract(messages: ChatMessage[]): Promise<any> {
    const userMessages = messages.filter((m) => m.role === "user").map((m) => m.content || "");
    const system =
      "Ты экстрактор данных. Возвращай ТОЛЬКО валидный JSON со схемой: {budget:number|undefined, goals:string[]|undefined, likes:string[]|undefined, dislikes:string[]|undefined, allergies:string[]|undefined, family_members:Array<{name?:string, age?:number, weight?:number, activity?:\"low\"|\"moderate\"|\"high\", likes?:string[], dislikes?:string[], allergies?:string[]}>|undefined}. Если новых данных нет — верни {}. ВАЖНО: корректно классифицируй: слова и формулировки типа \"аллергия\", \"не переносит\", \"реакция\", \"интолерантность\" — это allergies; формулировки \"не ест\", \"избегает\", \"не любит\", \"не употребляет\" — это dislikes; формулировки \"люблю\", \"любит\", \"обожаю\", \"обожает\", \"предпочитаю\", \"предпочитает\" — это likes. \"Не ест X\" НЕ означает аллергию.";
    const numbered = userMessages.map((s, i) => `[${i + 1}] ${s}`).join("\n");
    const msgs: ChatMessage[] = [
      { role: "user", content: `История пользовательских сообщений (на русском):\n${numbered}\n\nИзвлеки только новые данные по семье/бюджету/целям/предпочтениям. Выведи ТОЛЬКО JSON.` },
    ];
    const extracted = await this.ai.extractJson(msgs, system);
    return extracted || {};
  }
}