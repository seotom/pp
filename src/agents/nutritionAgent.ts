import fs from "fs";
import path from "path";
import { Agent, AgentContext, AgentResult, ChatMessage } from "./core";
import { OpenAIService } from "@/services/openai";
import { DataExtractor } from "@/services/dataExtractor";
import { DialogueManager } from "@/services/dialogueManager";
import { DatabaseService } from "@/services/database";
import { ValidationService } from "@/services/validation";
import { CanonicalizationService } from "@/services/canonicalization";
import AiClassifier from "@/services/aiClassifier";

export default class NutritionAgent implements Agent {
  constructor(
    private ai: OpenAIService,
    private extractor: DataExtractor,
    private dialogue: DialogueManager,
    private db: DatabaseService,
    private validator: ValidationService,
    private canonical: CanonicalizationService
  ) {}

  private promptCache: string | null = null;
  private async getPrompt(): Promise<string> {
    if (this.promptCache) return this.promptCache;
    const filePath = path.join(process.cwd(), "src", "prompts", "nutrition-agent.md");
    this.promptCache = await fs.promises.readFile(filePath, "utf-8");
    return this.promptCache;
  }

  async handleChat(messages: ChatMessage[], context: AgentContext): Promise<AgentResult> {
    const system = await this.getPrompt();
    const content = await this.ai.chat(messages, system);
    const extracted = await this.extractor.extract(messages);
    const aiCls = new AiClassifier(this.ai);
    const { facts: aiFacts, confidence, resolved } = await aiCls.classify(messages, context?.profile);
    // Безопасная валидация: ниже порога — запрашиваем подтверждение и не пишем в БД
    const threshold = Number(process.env.AI_CONFIDENCE_THRESHOLD || 0.6);
    const canonFacts = aiFacts; // доверяем AI канонизацию
    if (confidence < threshold) {
      const summary = [
        "Проверяем интерпретацию данных:",
        `- Дом: любимые: ${aiFacts.householdLikes?.join(", ") || "нет"}`,
        `- Дом: нелюбимые: ${aiFacts.householdDislikes?.join(", ") || "нет"}`,
        `- Дом: аллергии: ${aiFacts.householdAllergies?.join(", ") || "нет"}`,
        `- Члены семьи: ${Array.isArray(aiFacts.members) && aiFacts.members.length ? aiFacts.members.map(m => `${m.name || "?"}: ❤ ${m.likes?.join("/") || "—"}; ✗ ${m.dislikes?.join("/") || "—"}; ⚠ ${m.allergies?.join("/") || "—"}`).join("; ") : "нет"}`,
        "\nЯ немного не уверен в части интерпретации. Подтвердите, пожалуйста, или уточните.",
      ].join("\n");
      return { content: [content, "\n\n", summary].join("") };
    }
    // Обработка явного снятия аллергий
    try {
      const profileId = (context?.profile as any)?.id ? Number((context!.profile as any).id) : undefined;
      if (profileId) {
        // Снятие конкретных аллергий на уровне дома
        const householdResolved = Array.isArray(resolved?.householdAllergies) ? resolved!.householdAllergies! : [];
        for (const it of householdResolved) {
          const canonItem = this.canonical.canonicalize(it);
          await this.db.removeHouseholdAllergy(profileId, canonItem);
        }
        // Полная очистка аллергий на уровне дома
        if (resolved && (resolved as any).householdNoAllergies === true) {
          await this.db.clearHouseholdAllergies(profileId);
        }
        // Снятие «нелюбимых» на уровне дома
        const householdResolvedDislikes = Array.isArray((resolved as any)?.householdDislikes) ? (resolved as any).householdDislikes : [];
        for (const it of householdResolvedDislikes) {
          const canonItem = this.canonical.canonicalize(it);
          await this.db.removeHouseholdDislike(profileId, canonItem);
        }
        // Снятие/очистка на уровне конкретных членов
        const membersResolved = Array.isArray(resolved?.members) ? resolved!.members! : [];
        for (const rm of membersResolved) {
          const name = (rm?.name || "").trim();
          const items = Array.isArray(rm?.resolvedAllergies) ? rm!.resolvedAllergies! : [];
          const itemsDislikes = Array.isArray((rm as any)?.resolvedDislikes) ? (rm as any).resolvedDislikes : [];
          const noAll = (rm as any)?.noAllergies === true;
          if (!name) continue;
          if (noAll) {
            await this.db.clearMemberAllergies(profileId, name);
            continue;
          }
          for (const it of items) {
            const canonItem = this.canonical.canonicalize(it);
            await this.db.removeMemberAllergy(profileId, name, canonItem);
          }
          for (const it of itemsDislikes) {
            const canonItem = this.canonical.canonicalize(it);
            await this.db.removeMemberDislike(profileId, name, canonItem);
          }
        }
      }
    } catch (e: any) {
      console.error("resolvedAllergies handling failed", e?.message || e);
    }
    const profileId = (context?.profile as any)?.id ? Number((context!.profile as any).id) : undefined;
    if (profileId) {
      // Снятие конфликтующих dislikes, если появились новые лайки
      try {
        const hLikes: string[] = Array.isArray((canonFacts as any)?.householdLikes) ? (canonFacts as any).householdLikes : [];
        for (const it of hLikes) {
          await this.db.removeHouseholdDislike(profileId, it);
        }
        const membersArr: Array<{ name?: string; likes?: string[] }> = Array.isArray((canonFacts as any)?.members) ? (canonFacts as any).members : [];
        for (const m of membersArr) {
          const name = (m?.name || "").trim();
          if (!name) continue;
          const likes = Array.isArray(m?.likes) ? m.likes! : [];
          for (const it of likes) {
            await this.db.removeMemberDislike(profileId, name, it);
          }
        }
      } catch (e: any) {
        console.error("dislikes reconciliation failed", e?.message || e);
      }
      await this.db.upsertDietFacts(profileId, canonFacts);
      // Обновляем family_members актуальными данными: возраст/вес/активность и предпочтения
      const byName: Record<string, { name?: string; age?: number; weight?: number; activity?: string; likes?: string[]; dislikes?: string[]; allergies?: string[] }> = {};
      const norm = (n?: string) => (n || "").trim().toLowerCase();
      const extractedMembers = Array.isArray((extracted as any)?.family_members) ? (extracted as any).family_members : [];
      for (const m of extractedMembers) {
        const key = norm(m?.name);
        if (!key) continue;
        byName[key] = {
          name: m?.name,
          age: typeof m?.age === "number" ? m.age : undefined,
          weight: typeof (m as any)?.weight === "number" ? (m as any).weight : undefined,
          activity: typeof m?.activity === "string" ? m.activity : undefined,
          // ВАЖНО: не устанавливать пустые массивы, чтобы не перетирать существующие значения
          // Аллергии из извлечённого блока можно сохранить, если они есть
          allergies: Array.isArray((m as any)?.allergies) && (m as any).allergies.length > 0 ? (m as any).allergies : undefined,
        };
      }
      const canonMembers = Array.isArray((canonFacts as any)?.members) ? (canonFacts as any).members : [];
      for (const m of canonMembers) {
        const key = norm(m?.name);
        if (!key) continue;
        const likesArr = Array.isArray((m as any)?.likes) ? (m as any).likes : [];
        const dislikesArr = Array.isArray((m as any)?.dislikes) ? (m as any).dislikes : [];
        const allergiesArr = Array.isArray((m as any)?.allergies) ? (m as any).allergies : [];
        byName[key] = {
          ...(byName[key] || { name: m?.name }),
          // Передаём массивы только если есть новые элементы, иначе оставляем undefined
          likes: likesArr.length > 0 ? likesArr : undefined,
          dislikes: dislikesArr.length > 0 ? dislikesArr : undefined,
          allergies: allergiesArr.length > 0 ? allergiesArr : undefined,
        };
      }
      // Не перетираем существующие значения пустыми массивами: фильтруем пустые
      const combined = Object.values(byName).map((m) => ({
        ...m,
        likes: Array.isArray(m.likes) && m.likes.length > 0 ? m.likes : undefined,
        dislikes: Array.isArray(m.dislikes) && m.dislikes.length > 0 ? m.dislikes : undefined,
        allergies: Array.isArray(m.allergies) && m.allergies.length > 0 ? m.allergies : undefined,
      }));
      if (combined.length > 0) {
        await this.db.upsertFamilyMembersDetails(profileId, combined);
      }
    }
    return { content, data: { extracted, facts: canonFacts } };
  }
}

export { NutritionAgent };