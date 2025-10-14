import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import type { NutritionProfile } from "@/types/nutrition";

let cachedNutritionPrompt: string | null = null;
async function getNutritionPrompt(): Promise<string> {
  if (cachedNutritionPrompt) return cachedNutritionPrompt;
  const filePath = path.join(process.cwd(), "src", "prompts", "nutrition-agent.md");
  cachedNutritionPrompt = await fs.promises.readFile(filePath, "utf-8");
  return cachedNutritionPrompt;
}

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const messages = (body?.messages ?? []) as Array<{ role: "user" | "assistant" | "system"; content: string }>;
    const profile = body?.profile as NutritionProfile | undefined;
    const user_id = body?.user_id as string | undefined;
    // Хранилище извлечённых структурированных данных из пользовательского текста
    let parsed: any = {};

    // Делегирование в NutritionAgent при активном флаге USE_AGENT
    try {
      console.log("chat: USE_AGENT raw", process.env.USE_AGENT);
      const useAgent = process.env.USE_AGENT === "true";
      console.log("chat: useAgent resolved", useAgent);
      if (useAgent) {
        const agentModule = await import("@/agents/nutritionAgent");
        // Поддержка разных вариантов экспорта: именованный, default-класс или default-namespace с полем NutritionAgent
        const NutritionAgentCtor =
          (agentModule as any).NutritionAgent ??
          (typeof (agentModule as any).default === "function"
            ? (agentModule as any).default
            : (agentModule as any).default?.NutritionAgent);
        console.log(
          "chat: agent module exports",
          Object.keys(agentModule),
          "default keys",
          (agentModule as any).default && typeof (agentModule as any).default === "object"
            ? Object.keys((agentModule as any).default)
            : []
        );
        if (typeof NutritionAgentCtor !== "function") {
          throw new Error("NutritionAgent export not a constructor");
        }
        const { OpenAIService } = await import("@/services/openai");
        const { DataExtractor } = await import("@/services/dataExtractor");
        const { DialogueManager } = await import("@/services/dialogueManager");
        const { DatabaseService } = await import("@/services/database");
        const { ValidationService } = await import("@/services/validation");
        const { CanonicalizationService } = await import("@/services/canonicalization");

        // NEW: обеспечить наличие profile.id по user_id перед вызовом агента
        const { getSupabaseServer } = await import("@/lib/supabase");
        const supabase = getSupabaseServer();
        let profileWithId = profile as any;
        if ((!profileWithId || typeof (profileWithId as any).id !== "number") && user_id) {
          const { data: existing } = await supabase
            .from("profiles")
            .select("id")
            .eq("user_id", user_id)
            .limit(1)
            .maybeSingle();
          let ensuredId = existing?.id as number | undefined;
          if (!ensuredId) {
            const insertPayload: any = { user_id };
            if (profile && typeof (profile as any)?.budget?.weekly === "number") {
              insertPayload.budget = (profile as any).budget.weekly;
            }
            if (profile && Array.isArray((profile as any)?.goals)) {
              insertPayload.goals = (profile as any).goals;
            }
            const { data: inserted } = await supabase
              .from("profiles")
              .insert(insertPayload)
              .select("id")
              .limit(1)
              .maybeSingle();
            ensuredId = inserted?.id as number | undefined;
          }
          profileWithId = { ...(profile || {}), id: ensuredId } as any;
        }

        const ai = new OpenAIService();
        const agent = new NutritionAgentCtor(
          ai,
          new DataExtractor(ai),
          new DialogueManager(),
          new DatabaseService(),
          new ValidationService(),
          new CanonicalizationService()
        );
        const { content, data: agentData } = await agent.handleChat(messages as any, { userId: user_id, profile: profileWithId });
        // После выполнения агента актуализируем бюджет/цели в profiles
        try {
          const normalizeBudget = (val: any): number | undefined => {
            if (typeof val === "number" && Number.isFinite(val)) return Math.round(val);
            if (typeof val === "string") {
              const digits = val.replace(/[^\d]/g, "");
              const num = parseInt(digits, 10);
              if (!Number.isNaN(num)) return num;
            }
            return undefined;
          };
          const normalizeGoals = (val: any): string[] | undefined => {
            if (Array.isArray(val)) {
              const arr = val
                .map((s: any) => (typeof s === "string" ? s.trim() : ""))
                .filter(Boolean);
              return arr.length ? arr : undefined;
            }
            if (typeof val === "string") {
              const arr = val
                .split(/[;,]/)
                .map((s) => s.trim())
                .filter(Boolean);
              return arr.length ? arr : undefined;
            }
            return undefined;
          };

          const extracted = (agentData as any)?.extracted || {};
          const budgetNum = normalizeBudget(extracted?.budget);
          const goalsArr = normalizeGoals(extracted?.goals);

          const payload: any = { user_id };
          if (typeof budgetNum === "number") payload.budget = budgetNum;
          if (Array.isArray(goalsArr)) payload.goals = goalsArr.join(", ");

          if (payload.budget != null || payload.goals != null) {
            const { getSupabaseServer } = await import("@/lib/supabase");
            const supabaseAgent = getSupabaseServer();
            const { error } = await supabaseAgent
              .from("profiles")
              .upsert(payload, { onConflict: "user_id" });
            if (error) {
              console.error("profiles upsert (agent) error:", error.message);
            } else {
              console.log("profiles upsert (agent) OK", { budget: payload.budget, goals: payload.goals });
            }
          } else {
            console.log("profiles upsert (agent): nothing to update");
          }
        } catch (e: any) {
          console.error("profiles upsert (agent) failure", e?.message || e);
        }
        console.log("chat: agent path used");
        return NextResponse.json({ content, meta: { path: "agent", useAgent } });
      } else {
        console.log("chat: agent disabled — using legacy path");
      }
    } catch (agentErr: any) {
      console.error("Agent path failed, falling back to legacy route", agentErr?.message || agentErr);
    }

    const systemContent = await getNutritionPrompt();
    const messagesForModel: Array<{ role: "user" | "assistant" | "system"; content: string }> = [
      { role: "system", content: systemContent },
      ...messages,
    ];
    if (profile) {
      messagesForModel.push({
        role: "system",
        content: `Начальные данные профиля пользователя (JSON):\n${JSON.stringify(profile)}`,
      });
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: messagesForModel,
      temperature: 0.7,
    });

    const content = completion.choices?.[0]?.message?.content ?? "";
    console.log("chat: POST invoked", {
      messagesCount: messages.length,
      user_id,
      roles: messages.map((m) => m.role),
    });

    // === Новое: парсинг всей истории пользовательских сообщений и сохранение в БД ===
    const userMessages = messages.filter((m) => m.role === "user").map((m) => m.content ?? "");
    const userText = userMessages.join("\n");
    const lastUserMessage = (userMessages[userMessages.length - 1] ?? "").trim();
    console.log("chat: user messages collected", { userMessagesCount: userMessages.length, hasUserText: !!userText.trim() });
    if (user_id && userText.trim()) {
      try {
        // динамический импорт, чтобы не править верхние импорты
        const { getSupabaseServer } = await import("@/lib/supabase");
        const supabase = getSupabaseServer();

        // Вызов модели для жестко-структурированного JSON (только извлечение, без советов)
        const extract = await client.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "Ты экстрактор данных. Возвращай ТОЛЬКО валидный JSON со схемой: {budget:number|undefined, goals:string[]|undefined, preferences:string[]|undefined, family_members:Array<{name?:string, age?:number, activity?:\"low\"|\"moderate\"|\"high\", allergies?:string[], preferences?:string[], likes?:string[]}>|undefined}. Если новых данных нет — верни {}. ВАЖНО: корректно классифицируй \"аллергии\" против \"предпочтений\": слова и формулировки типа \"аллергия\", \"не переносит\", \"реакция\", \"интолерантность\" — это allergies; формулировки \"не ест\", \"избегает\", \"не любит\", \"не употребляет\" — это preferences; формулировки \"люблю\", \"любит\", \"обожаю\", \"обожает\", \"предпочитаю\", \"предпочитает\" — это likes. \"Не ест X\" НЕ означает аллергию.",
            },
            {
              role: "user",
              content: `История пользовательских сообщений (на русском):\n${userMessages.map((s, i) => `[${i + 1}] ${s}`).join("\n")}\n\nИзвлеки только новые данные по семье/бюджету/целям/предпочтениям. Выведи ТОЛЬКО JSON.`,
            },
          ],
        });
        let raw = extract.choices?.[0]?.message?.content ?? "{}";
        const fencedMatch = raw.trim().match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fencedMatch) {
          raw = fencedMatch[1];
        }
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = {};
        }
        console.log("chat: extractor parsed keys", Object.keys(parsed));
        // Удалённый ранее legacy-блок: заглушки не требуются, оставляем реальную обработку ниже

        // Обработка продолжается: сохраняем профиль и данные ниже без раннего return

        // Локальная копия членов семьи, чтобы избежать использования переменной,
        // объявленной ниже по файлу, и ошибок порядка объявления
        const famArrLocal: any[] = Array.isArray((parsed as any)?.family_members)
          ? [...(parsed as any).family_members]
          : [];
        // Локальные известные имена на основе имеющихся членов семьи
        const knownNames: string[] = famArrLocal
          .map((m: any) => (typeof m?.name === "string" ? m.name : ""))
          .filter(Boolean);

        const detectSpeakerFromContext = (text: string, names: string[]): string | undefined => {
          const t = text.toLowerCase();
          if (names.includes("муж") && /(мне\s*\(мужу\)|мужу\s*\d+)/.test(t)) return "муж";
          if (names.includes("жена") && /(мне\s*\(жене\)|жене\s*\d+)/.test(t)) return "жена";
          return names[0];
        };

        const splitItems = (s: string): string[] =>
          s
            .split(/[,;]|\s+и\s+/i)
            .map((x) => x.trim())
            .filter(Boolean);

        type Statement = { who: string; items: string[] };
        const likes: Statement[] = [];
        const dislikes: Statement[] = [];
        const allergiesSt: Statement[] = [];

        // Avoid undefined variable; legacy parsing disabled
        for (const sent of [] as string[]) {
          // аллергии: «аллергия на X» — фиксируем по субъекту фразы
          const a = Array.from(sent.matchAll(/аллергия\s+на\s+([а-яёa-z][^.!?;()]+)/gi)).map((m) => m[1].trim());

          // Определяем субъект, включая «семья»
          const subjectMatch = sent.match(/\b(жена|муж|мы\s*оба|мы|оба|я|семья)\b/i);
          const whoRaw = subjectMatch?.[1]?.toLowerCase() ?? "";

          // Триггеры лайков расширены: «любить», «стал/стала/стали любить»
          const isLike = /(люблю|любит|обожаю|обожает|предпочитаю|предпочитает|любить|стал\s+любить|стала\s+любить|стали\s+любить)/i.test(sent);
          const isDislike = /(не\s*люблю|не\s*любит|не\s*ест|избегаю|избегает|не\s*употребля[юе]т)/i.test(sent);

          // Извлекаем предметы строго ПОСЛЕ триггеров
          const takeAfter = (re: RegExp): string[] => {
            const acc: string[] = [];
            for (const m of sent.matchAll(re)) {
              const chunk = (m[2] || "").trim();
              if (!chunk) continue;
              const parts = splitItems(chunk)
                .map((x) => x.replace(/\b(жена|муж|мы|оба|я|семья)\b/gi, "").trim())
                // Удаляем триггеры из каждого куска, чтобы не тащить «стал любить» в dislikes
                .map((x) => stripTriggersDisplay(x))
                .map((x) => x.trim())
                .filter((x) => !!x && x.length <= 50);
              acc.push(...parts);
            }
            return acc;
          };

          const likeItems = takeAfter(/\b(люблю|любит|обожаю|обожает|предпочитаю|предпочитает|любить|стал\s+любить|стала\s+любить|стали\s+любить)\b\s*([^.!?;]+)/gi);
          const dislikeItems = takeAfter(/\b(не\s*люблю|не\s*любит|не\s*ест|избегаю|избегает|не\s*употребля[юе]т)\b\s*([^.!?;]+)/gi)
            // Защита от «склеек» через запятую: выбрасываем фразы с позитивными триггерами
            .filter((x) => !/(люблю|любит|любить|обожаю|обожает|предпочитаю|предпочитает|стал[аи]?\s+любить)/i.test(x));

          if (isLike && likeItems.length) likes.push({ who: whoRaw || "", items: likeItems });
          if (isDislike && dislikeItems.length) dislikes.push({ who: whoRaw || "", items: dislikeItems });
          if (a.length) allergiesSt.push({ who: whoRaw || "", items: a });
        }

        const ensureMember = (fname: string) => {
          const idx = famArrLocal.findIndex((m: any) => (typeof m?.name === "string" ? m.name : "") === fname);
          if (idx >= 0) return famArrLocal[idx];
          const created = { name: fname, likes: [], dislikes: [], allergies: [] } as any;
          famArrLocal.push(created);
          return created;
        };

        const applyToTargets = (who: string, items: string[], kind: "likes" | "preferences" | "allergies") => {
          let targets: string[] = [];
          if (who === "жена") targets = ["жена"];
          else if (who === "муж") targets = ["муж"];
          else if (who === "оба" || who === "мы оба" || who === "мы" || who === "семья") {
            // применяем только к известным именам, чтобы избежать распространения на всех по умолчанию
            targets = knownNames.length ? knownNames : [];
          } else if (who === "я") {
            const guess = detectSpeakerFromContext(userText, knownNames);
            targets = guess ? [guess] : [];
          } else {
            // если субъект не указан — пропускаем во избежание некорректного присвоения
            targets = [];
          }
          targets = targets.filter(Boolean);
          for (const t of targets) {
            const m = ensureMember(t);
            if (kind === "likes") {
              const arr = Array.isArray(m.likes) ? m.likes : [];
              m.likes = Array.from(new Set([...arr, ...items]));
            } else if (kind === "preferences") {
              const arr = Array.isArray(m.dislikes) ? m.dislikes : [];
              m.dislikes = Array.from(new Set([...arr, ...items]));
            } else if (kind === "allergies") {
              const arr = Array.isArray(m.allergies) ? m.allergies : [];
              m.allergies = Array.from(new Set([...arr, ...items]));
            }
          }
        };

        for (const st of likes) applyToTargets(st.who, st.items, "likes");
        for (const st of dislikes) applyToTargets(st.who, st.items, "preferences");
        for (const st of allergiesSt) applyToTargets(st.who, st.items, "allergies");

        parsed.family_members = famArrLocal;

        // Дополнительная переклассификация аллергий/предпочтений по тексту пользователя (хелпер)
        const reclassifyFromText = (obj: any, text: string) => {
          if (!obj || typeof obj !== "object" || !Array.isArray(obj.family_members) || !text) return obj;
          const lowerText = text.toLowerCase();
          // Сохраняем знак конца предложения и исключаем вопросы
          const sentencePairs2 = Array.from(lowerText.matchAll(/([^.!?;\n]+)([.!?;\n]+)/g));
          const sentences = sentencePairs2
            .map((m) => ({ text: m[1].trim(), end: m[2] }))
            .filter((p) => !!p.text && !p.end.includes("?"))
            .map((p) => p.text);

          const allergyHint = /(аллерг|интолерант|не\s*переносит|реакци)/i;
          // Предпочтения трактуем как НЕЛЮБИМЫЕ/избегаемые продукты, без «любит/обожает»
          const preferHint = /(не\s*ест|не\s*употребляет|избегает|не\s*любит)/i;
          // Отдельно распознаем позитивные формулировки, чтобы их не относить к «нелюбимым»
          const likeHint = /(любит|обожает|предпочитает)/i;
          const noAllergyHint = /(аллерг(ий)?\s*нет|нет\s*аллерг)/i;
          // Расширенные отрицания для «нелюбимых»: снимаем ранее добавленные dislikes
          const notDislikeHint = /(?:не\s*(?:явля(?:ет|ются)|счит(?:аю|аем|ает|ают))\s*[^.]*нелюбим[а-я]*)|(?:больше\s*не\s*счита[а-я]+\s*[^.]*нелюбим[а-я]*)|(?:теперь\s*не\s*нелюбим[а-я]+)|(?:больше\s*не\s*(?:избегаю|избегает|не\s*люблю|не\s*любит))|(?:не\s*против\s+[^.]+)|(?:[^.]+\s+(?:ок|приемлемо|можно\s*есть|можем\s*есть|может\s*есть))/i;
          // Расширенные отрицания для конкретных аллергий
          const allergyNegRe = /(нет\s*аллерг(ии|ий)\s*на|аллерг(ии|ий)\s*на.*нет|не\s*аллергич[еа]н\s*на)/i;
          // Грубая морфологическая поддержка: матч по корню слова + до 3 букв окончания
          const flexMatch = (word: string) => {
            const root = String(word || "").toLowerCase().replace(/[а-яё]{0,2}$/i, "");
            if (!root) return /$a^/; // никогда не матчится
            return new RegExp(`\\b${root}[а-яё]{0,3}\\b`, "i");
          };

          // Помощник: определяет, относится ли предложение к члену семьи
          const isSentenceAboutMember = (s: string, nameLower: string): boolean => {
            const t = s.toLowerCase();
            if (!nameLower) return false;
            if (nameLower === "жена") {
              return /(жена|супруга|у\s*жены|жене)/i.test(t);
            }
            if (nameLower === "муж") {
              // «я/у меня» считаем как муж + явные упоминания мужа
              return /(муж|супруг|у\s*мужа|мужу|\bя\b|у\s*меня)/i.test(t);
            }
            return t.includes(nameLower);
          };

          obj.family_members = obj.family_members.map((m: any) => {
            const name = typeof m?.name === "string" ? m.name.trim() : "";
            const nameLower = name.toLowerCase();
            const allergies: string[] = Array.isArray(m?.allergies) ? m.allergies : [];
            const dislikesTop: string[] = Array.isArray((m as any)?.dislikes) ? (m as any).dislikes : [];
            const prefsFallback: string[] = Array.isArray((m as any)?.preferences) ? (m as any).preferences : [];
            const prefs: string[] = [...dislikesTop, ...prefsFallback];

            const memberSents = nameLower ? sentences.filter((s) => isSentenceAboutMember(s, nameLower)) : sentences;
            const saysNoAllergies = memberSents.some((s) => noAllergyHint.test(s));

            const nextAllergies: string[] = [];
            const movedToPrefs: string[] = [];

            for (const it of allergies) {
              const itemLower = (it || "").toLowerCase();
              const memberItemSents = sentences.filter(
                (s) => flexMatch(itemLower).test(s) && isSentenceAboutMember(s, nameLower)
              );

              const hasAllergyCtx = memberItemSents.some((s) => allergyHint.test(s));
              const hasPreferCtx = memberItemSents.some((s) => preferHint.test(s));
              // Отрицание конкретной аллергии применяем только если фраза относится к члену
              const negSpecific = memberItemSents.some((s) => allergyNegRe.test(s));

              if (negSpecific) {
                // Пользователь уточнил, что аллергии на этот продукт нет — удаляем, НЕ переносим в «нелюбимые»
                continue;
              } else if (hasPreferCtx && !hasAllergyCtx) {
                movedToPrefs.push(it);
              } else if (hasAllergyCtx) {
                nextAllergies.push(it);
              } else {
                // Общая формулировка «нет аллергий» не удаляет существующие элементы.
                // Оставляем текущие аллергии без изменений, если не было явного отрицания конкретного продукта.
                nextAllergies.push(it);
              }
            }

            // Извлечение новых аллергий из свободного текста: «аллергия на X»
            const extractedAllergies: string[] = [];
            for (const s of memberSents) {
              const m = s.match(/аллергия\s*на\s+([a-zа-яё\s\-]+)/i);
              if (m && m[1]) {
                const cleaned = m[1].trim();
                const parts = splitItems(cleaned).filter((x) =>
                  !!x && x.length <= 50 && !/(имеешь\s*в\s*виду|аллергия|вопрос|почему|как|можно|скажите|ты)/i.test(x)
                );
                extractedAllergies.push(...parts);
              }
            }

            // Явное снятие аллергии из фраз вида «нет аллергии на …»
            const resolvedAllergiesLocal: string[] = [];
            for (const s of memberSents) {
              if (allergyNegRe.test(s)) {
                const cleaned = stripTriggersDisplay(s);
                const parts = splitItems(cleaned).filter((x) =>
                  !!x && x.length <= 50 && !/(имеешь\s*в\s*виду|вопрос|почему|как|скажите|ты)/i.test(x)
                );
                resolvedAllergiesLocal.push(...parts);
              }
            }

            // Извлечение «нелюбимых» из свободного текста: «не любит/не ест/избегает X»
            const extractedDislikes: string[] = [];
            for (const s of memberSents) {
              const m = s.match(/(?:не\s*любит|не\s*ест|избегает)\s+([a-zа-яё\s\-]+)/i);
              if (m && m[1]) {
                const cleaned = m[1].trim();
                const parts = splitItems(cleaned).filter((x) =>
                  !!x && x.length <= 50 && !/(имеешь\s*в\s*виду|вопрос|почему|как|можно|скажите|ты)/i.test(x)
                );
                extractedDislikes.push(...parts);
              }
            }

            // Позитивные формулировки (любит/обожает/предпочитает) НЕ добавляем в «нелюбимые»
            const filteredPrefs = prefs.filter((p) => !likeHint.test(p.toLowerCase()));

            // Явные отрицания «не нелюбимые» для текущего члена семьи
            const resolvedLocal: string[] = [];
            for (const s of memberSents) {
              if (notDislikeHint.test(s)) {
                const cleaned = stripTriggersDisplay(s);
                const parts = splitItems(cleaned).filter((x) =>
                  !!x && x.length <= 50 && !/(имеешь\s*в\s*виду|вопрос|почему|как|скажите|ты)/i.test(x)
                );
                resolvedLocal.push(...parts);
              }
            }

            // Итоговые «нелюбимые» без явно отменённых элементов
            const nextDislikes = Array.from(new Set([
              ...filteredPrefs,
              ...movedToPrefs,
              ...extractedDislikes,
            ])).filter((x) => !resolvedLocal.includes(x));

            return {
              ...m,
              allergies: Array.from(new Set([...(nextAllergies.length ? nextAllergies : []), ...extractedAllergies])),
              dislikes: nextDislikes,
              // Промаркируем явные снятия аллергий для последующего удаления в diet_facts
              _resolvedAllergies: Array.from(new Set(resolvedAllergiesLocal)),
            };
          });

          // Household‑уровень: снимаем dislikes при общих отрицаниях
          const householdResolved: string[] = [];
          for (const s of sentences) {
            if (notDislikeHint.test(s) && !/(я|муж|жена|мы\s*оба|оба)/i.test(s)) {
              const cleaned = stripTriggersDisplay(s);
              const parts = splitItems(cleaned).filter((x) =>
                !!x && x.length <= 50 && !/(имеешь\s*в\s*виду|вопрос|почему|как|скажите|ты)/i.test(x)
              );
              householdResolved.push(...parts);
            }
          }
          const uniqHouseholdResolved = Array.from(new Set(householdResolved));
          obj.preferences = Array.isArray(obj.preferences) ? obj.preferences.filter((p: any) => {
            const s = typeof p === "string" ? stripTriggersDisplay(p) : "";
            if (!s) return false;
            const items = splitItems(s);
            return !items.some((it) => uniqHouseholdResolved.includes(it));
          }) : obj.preferences;
          // Household‑уровень: снимаем аллергии при общих отрицаниях
          const householdResolvedAllergies: string[] = [];
          for (const s of sentences) {
            if (allergyNegRe.test(s) && /(мы|оба|все)/i.test(s) && !/(муж|жена|я)/i.test(s)) {
              const cleaned = stripTriggersDisplay(s);
              const parts = splitItems(cleaned).filter((x) =>
                !!x && x.length <= 50 && !/(имеешь\s*в\s*виду|вопрос|почему|как|скажите|ты)/i.test(x)
              );
              householdResolvedAllergies.push(...parts);
            }
          }
          const uniqHouseholdResolvedAllergies = Array.from(new Set(householdResolvedAllergies));
          obj.allergies = Array.isArray(obj.allergies)
            ? obj.allergies.filter((p: any) => {
                const s = typeof p === "string" ? stripTriggersDisplay(p) : "";
                if (!s) return false;
                const items = splitItems(s);
                return !items.some((it) => uniqHouseholdResolvedAllergies.includes(it));
              })
            : obj.allergies;

          // Сохраним явные снятия, чтобы на уровне сохранения фактов удалить из diet_facts
          const resolvedMembers = (obj.family_members || []).map((m: any) => ({
            name: typeof m?.name === "string" ? m.name : undefined,
            resolvedAllergies: Array.isArray(m?._resolvedAllergies) ? m._resolvedAllergies : [],
          }));
          (obj as any)._resolved = {
            householdAllergies: uniqHouseholdResolvedAllergies,
            members: resolvedMembers,
          };
          return obj;
        };

        // Применяем переклассификацию, чтобы различать \"аллергии\" и \"не ест\" как предпочтения
        parsed = reclassifyFromText(parsed, userText);

        // Фолбэк: извлекаем бюджет и цели из всей пользовательской истории, если JSON пустой
        if (userText) {
          const lower = userText.toLowerCase();
          const budgetMatch = lower.match(/(?:бюджет|в неделю|неделю)[^\d]*(\d[\d\s]+)/);
          let fbBudgetStr = budgetMatch?.[1];
          if (!fbBudgetStr) {
            const alt = lower.match(/(\d[\d\s]+)\s*(?:руб|₽)/);
            fbBudgetStr = alt?.[1];
          }

          const goalsLineMatch = lower.match(/цели?:\s*([^\n]+)/);
          const fbGoalsArrFromLine = goalsLineMatch?.[1]
            ?.split(/[;,]/)
            ?.map((s) => s.trim())
            ?.filter(Boolean) ?? [];

          const inferredGoals: string[] = [];
          if (/здоров/i.test(lower)) inferredGoals.push("здоровье");
          if (/эконом/i.test(lower)) inferredGoals.push("экономия");
          if (/разнообраз/i.test(lower)) inferredGoals.push("разнообразие");
          if (/похуд/i.test(lower)) inferredGoals.push("похудение");
          if (/без\s+сахар/i.test(lower)) inferredGoals.push("без сахара");
          if (/правильн[оая][^\n]*питан/i.test(lower) || /здоров[оая][^\n]*питан/i.test(lower)) inferredGoals.push("здоровое питание");
          const fbGoalsArr = fbGoalsArrFromLine && fbGoalsArrFromLine.length ? fbGoalsArrFromLine : inferredGoals;

          if (parsed.budget == null && fbBudgetStr) parsed.budget = fbBudgetStr;
          if (!Array.isArray(parsed.goals) && fbGoalsArr.length) parsed.goals = Array.from(new Set(fbGoalsArr));
        }

        // прочитать текущий профиль
        const { data: existingProfile } = await supabase
          .from("profiles")
          .select("id,user_id,budget,goals,family_data")
          .eq("user_id", user_id)
          .limit(1)
          .maybeSingle();

        const currentFamilyData = existingProfile?.family_data ?? {};
        let profileId: number | undefined = existingProfile?.id as any;
        const nextFamilyData = { ...currentFamilyData };
        // preferences: если пришёл массив и в профиле ещё нет — добавим
        if (Array.isArray(parsed?.preferences) && !currentFamilyData?.preferences) {
          nextFamilyData.preferences = parsed.preferences;
        }

        // Гибкая нормализация бюджета и целей из парсинга
        const normalizeBudget = (val: any): number | undefined => {
          if (typeof val === "number" && Number.isFinite(val)) return Math.round(val);
          if (typeof val === "string") {
            const digits = val.replace(/[^\d]/g, "");
            const num = parseInt(digits, 10);
            if (!Number.isNaN(num)) return num;
          }
          return undefined;
        };
        const normalizeGoals = (val: any): string[] | undefined => {
          if (Array.isArray(val)) {
            const arr = val
              .map((s: any) => (typeof s === "string" ? s.trim() : ""))
              .filter(Boolean);
            return arr.length ? arr : undefined;
          }
          if (typeof val === "string") {
            const arr = val
              .split(/[;,]/)
              .map((s) => s.trim())
              .filter(Boolean);
            return arr.length ? arr : undefined;
          }
          return undefined;
        };

        const extractedBudget = normalizeBudget(parsed?.budget);
        const extractedGoalsArr = normalizeGoals(parsed?.goals);

        const payload: any = {
          user_id,
          family_data: nextFamilyData,
        };

        // Обновляем бюджет, если есть извлечённое значение и оно отличается от текущего
        if (typeof extractedBudget === "number") {
          if (existingProfile?.budget == null || existingProfile?.budget !== extractedBudget) {
            payload.budget = extractedBudget;
          }
        }

        // Обновляем цели, если пришли и отличаются от текущих
        if (Array.isArray(extractedGoalsArr)) {
          const nextGoalsStr = extractedGoalsArr.join(", ");
          const currentGoalsStr = (existingProfile?.goals ?? "").trim();
          if (currentGoalsStr === "" || currentGoalsStr !== nextGoalsStr) {
            payload.goals = nextGoalsStr;
          }
        }

        console.log("profiles upsert payload", { extractedBudget, extractedGoalsArr, payload });
        if (
          payload.budget != null ||
          payload.goals != null ||
          JSON.stringify(payload.family_data) !== JSON.stringify(currentFamilyData)
        ) {
          const { data: upsertData, error: upsertError } = await supabase
            .from("profiles")
            .upsert(payload, { onConflict: "user_id" })
            .select("id")
            .limit(1);
          if (upsertError) {
            // Логируем ошибку, чтобы видеть причину (например, RLS или несовпадение типов)
            console.error("profiles upsert error:", upsertError.message);
          } else {
            console.log("profiles upsert OK");
            // зафиксировать profileId, если он не был известен
            if (!profileId) {
              const newId = Array.isArray(upsertData) && upsertData.length > 0 ? (upsertData[0] as any)?.id : undefined;
              profileId = newId ?? profileId;
            }
          }
        } else {
          console.log("profiles: nothing to update");
        }

        // Мердж-обновление family_members: сопоставляем и обновляем/добавляем записей
        if (Array.isArray(parsed?.family_members)) {
          // Если профиль ещё не был создан — попробуем прочитать его сейчас
          if (!profileId) {
            const { data: ensuredProfile } = await supabase
              .from("profiles")
              .select("id")
              .eq("user_id", user_id)
              .limit(1)
              .maybeSingle();
            profileId = ensuredProfile?.id as any;
          }

          if (profileId) {
            // Считываем существующие записи для профиля
            const { data: existingMembers, error: readErr } = await supabase
              .from("family_members")
              .select("id, name, age, weight, activity, likes, dislikes, allergies")
              .eq("profile_id", profileId);
            if (readErr) {
              console.error("family_members read error", readErr.message);
            }

            const normalizeName = (val: any): string | null =>
              typeof val === "string" && val.trim() ? val.trim() : null;
            const normalizeActivity = (val: any): string | null =>
              typeof val === "string" && val.trim() ? val.trim() : null;
            const normalizeNumber = (val: any): number | null =>
              typeof val === "number" && Number.isFinite(val) ? val : null;

            const toAttrsObj = (m: any) => {
              const name = normalizeName(m?.name) ?? normalizeName(m?.preferences?.name);
              const allergies = Array.isArray(m?.allergies)
                ? m.allergies
                : Array.isArray(m?.preferences?.allergies)
                ? m.preferences.allergies
                : null;
              const dislikesArr = Array.isArray((m as any)?.dislikes)
                ? (m as any).dislikes
                : Array.isArray(m?.preferences?.preferences)
                ? m.preferences.preferences
                : Array.isArray(m?.preferences?.dislikes)
                ? m.preferences.dislikes
                : null;
              const likesArr = Array.isArray(m?.likes)
                ? m.likes
                : Array.isArray(m?.preferences?.likes)
                ? m.preferences.likes
                : null;
              return name || allergies || dislikesArr || likesArr
                ? { name, allergies, dislikes: dislikesArr, likes: likesArr }
                : null;
            };

            const incoming = parsed.family_members
              .filter((m: any) => m && (m.age || m.activity || m.name || m.dislikes || m.likes || m.allergies || m.preferences || m.weight || m.weightKg))
              .map((m: any) => {
                const weightVal = normalizeNumber(m?.weight) ?? normalizeNumber(m?.weightKg);
                const attrs = toAttrsObj(m);
                // Разрешаем местоимение «я»: мапим на существующего члена семьи (муж/жена),
                // чтобы не создавать новую запись с именем "я"
                let nameNorm = attrs?.name ?? null;
                if (typeof nameNorm === "string" && nameNorm.toLowerCase() === "я") {
                  const existingNamesLower = Array.isArray(existingMembers)
                    ? existingMembers
                        .map((em: any) => (normalizeName(em?.name) || "").toLowerCase())
                        .filter(Boolean)
                    : [];
                  if (existingNamesLower.includes("муж")) nameNorm = "муж";
                  else if (existingNamesLower.includes("жена")) nameNorm = "жена";
                  else nameNorm = null; // без привязки — будем сопоставлять по age+activity
                }
                return {
                  name: nameNorm,
                  age: normalizeNumber(m?.age),
                  weight: weightVal,
                  activity: normalizeActivity(m?.activity),
                  likes: Array.isArray(attrs?.likes) ? attrs!.likes : null,
                  dislikes: Array.isArray(attrs?.dislikes) ? attrs!.dislikes : null,
                  allergies: Array.isArray(attrs?.allergies) ? attrs!.allergies : null,
                };
              })
              .filter((r: any) => r.age != null || r.activity != null || r.weight != null || r.name != null || r.likes != null || r.dislikes != null || r.allergies != null);

            let updates = 0;
            let inserts = 0;

            // Канонизация и дедупликация элементов (простые эвристики для русского)
        const stripTriggers = (raw: string): string => {
          return raw
            .toLowerCase()
            .replace(/\b(не\s*ест|не\s*употребля[юе]т|избегает|избегаю|не\s*любит|не\s*люблю|люблю|любит|обожаю|обожает|предпочитаю|предпочитает)\b/g, "")
            .replace(/\b(жена|муж|мы|оба|я)\b/g, "")
            .replace(/\b(аллергия\s*на|непереносимость|интолерантность|реакция\s*на)\b/g, "")
            .replace(/\b(имеешь\s*в\s*виду|в\s*виду)\b/g, "")
            .replace(/["'«»().,;:]/g, " ")
            .replace(/\s+/g, " ")
            .trim();
        };

              const canonicalMap: Record<string, string> = {
                // Частые продукты и формы
                "курица": "курица",
                "курицу": "курица",
                "курицы": "курица",
                "говядина": "говядина",
                "говядину": "говядина",
                "говядины": "говядина",
                "молоко": "молоко",
                "лактоза": "лактоза",
                "морепродукты": "морепродукты",
                "гречка": "гречка",
                "брокколи": "брокколи",
                // Капуста: унифицируем на общий термин
                "капуста": "капуста",
                "капусту": "капуста",
                "капусты": "капуста",
                "капусте": "капуста",
                "капустой": "капуста",
                "белокочанная капуста": "капуста",
                "капуста белокочанная": "капуста",
                "пекинская капуста": "капуста",
                "капуста пекинская": "капуста",
                "цветная капуста": "капуста",
                "капуста цветная": "капуста",
              // Орехи: унифицируем грецкие орехи
              "грецкие орехи": "грецкие орехи",
              "грецкий орех": "грецкие орехи",
              "орехи грецкие": "грецкие орехи",
              "орех грецкий": "грецкие орехи",
              // Тыква: нормализуем падежи
              "тыква": "тыква",
              "тыкву": "тыква",
              "тыквы": "тыква",
            };

              const canonicalizeItem = (raw: any): string => {
                if (typeof raw !== "string") return "";
                const s = stripTriggers(raw);
                if (!s) return "";
                // Если есть точное соответствие — используем его
                if (canonicalMap[s]) return canonicalMap[s];
                // Простая нормализация окончания винительного падежа для известных слов
                const simpleAccusative = s.replace(/^(куриц)(у|ы)$/i, "курица");
                const simpleAccusative2 = simpleAccusative.replace(/^(говядин)(у|ы)$/i, "говядина");
                return canonicalMap[simpleAccusative2] ?? simpleAccusative2;
              };

            const canonicalizeList = (arr: any): string[] => {
              const items = Array.isArray(arr) ? arr : [];
              const norm = items
                .map((x) => canonicalizeItem(x))
                .filter((x) => !!x);
              return Array.from(new Set(norm));
            };

            // Объединение likes/dislikes/allergies с заменой массивов при наличии новых данных
            const mergeAttrs = (existing: any, next: any) => {
              const base: any = existing && typeof existing === "object" ? { ...existing } : {};
              if (next && typeof next === "object") {
                const nextName = normalizeName(next.name);
                if (nextName) base.name = nextName;

                if (Array.isArray(next.allergies)) {
                  base.allergies = canonicalizeList(next.allergies);
                }

                if (Array.isArray(next.dislikes)) {
                  let dislikesCanon = canonicalizeList(next.dislikes);
                  const allergySet = new Set(base.allergies || []);
                  dislikesCanon = dislikesCanon.filter((p) => !allergySet.has(p));
                  base.dislikes = dislikesCanon;
                }

                if (Array.isArray(next.likes)) {
                  let likesCanon = canonicalizeList(next.likes);
                  const allergySet = new Set(base.allergies || []);
                  likesCanon = likesCanon.filter((p) => !allergySet.has(p));
                  base.likes = likesCanon;
                }
              }
              // Нормализуем пустые массивы в отсутствие данных
              if (base.allergies && !Array.isArray(base.allergies)) delete base.allergies;
              if (base.likes && !Array.isArray(base.likes)) delete base.likes;
              if (base.dislikes && !Array.isArray(base.dislikes)) delete base.dislikes;
              return Object.keys(base).length ? base : null;
            };

            // Сопоставление по имени (name) или по паре age+activity
            const findMatch = (member: any): any | undefined => {
              const nextName = normalizeName(member?.name);
              if (nextName && Array.isArray(existingMembers)) {
                const byName = existingMembers.find((em: any) => normalizeName(em?.name)?.toLowerCase() === nextName.toLowerCase());
                if (byName) return byName;
              }
              if (Array.isArray(existingMembers)) {
                const byCombo = existingMembers.find(
                  (em: any) =>
                    (normalizeNumber(em?.age) ?? null) === (normalizeNumber(member?.age) ?? null) &&
                    (normalizeActivity(em?.activity) ?? null) === (normalizeActivity(member?.activity) ?? null)
                );
                if (byCombo) return byCombo;
              }
              return undefined;
            };

            for (const m of incoming) {
              const match = findMatch(m);
              if (match) {
                const updatePayload: any = {};
                if (m.age != null && m.age !== match.age) updatePayload.age = m.age;
                if (m.weight != null && m.weight !== match.weight) updatePayload.weight = m.weight;
                if (m.activity != null && m.activity !== match.activity) updatePayload.activity = m.activity;
                if (normalizeName(m.name) && normalizeName(m.name) !== normalizeName(match.name)) {
                  updatePayload.name = normalizeName(m.name);
                }
                const merged = mergeAttrs({
                  name: match.name,
                  likes: match.likes,
                  dislikes: match.dislikes,
                  allergies: match.allergies,
                }, {
                  name: m.name,
                  likes: m.likes,
                  dislikes: m.dislikes,
                  allergies: m.allergies,
                });
                if (merged) {
                  if (Array.isArray(merged.likes) && JSON.stringify(merged.likes) !== JSON.stringify(match.likes)) {
                    updatePayload.likes = merged.likes;
                  }
                  if (Array.isArray(merged.dislikes) && JSON.stringify(merged.dislikes) !== JSON.stringify(match.dislikes)) {
                    updatePayload.dislikes = merged.dislikes;
                  }
                  if (Array.isArray(merged.allergies) && JSON.stringify(merged.allergies) !== JSON.stringify(match.allergies)) {
                    updatePayload.allergies = merged.allergies;
                  }
                }
                if (Object.keys(updatePayload).length > 0) {
                  try {
                    await supabase
                      .from("family_members")
                      .update(updatePayload)
                      .eq("id", match.id);
                    updates += 1;
                  } catch (e: any) {
                    console.error("family_members update error", e?.message || e);
                  }
                }
              } else if (Array.isArray(existingMembers) && existingMembers.length === 1) {
                // Фолбэк: если запись одна, обновляем её вместо вставки новой
                const single = existingMembers[0];
                const updatePayload: any = {};
                if (m.age != null && m.age !== single.age) updatePayload.age = m.age;
                if (m.weight != null && m.weight !== single.weight) updatePayload.weight = m.weight;
                if (m.activity != null && m.activity !== single.activity) updatePayload.activity = m.activity;
                if (normalizeName(m.name) && normalizeName(m.name) !== normalizeName(single.name)) {
                  updatePayload.name = normalizeName(m.name);
                }
                const merged = mergeAttrs({
                  name: single.name,
                  likes: single.likes,
                  dislikes: single.dislikes,
                  allergies: single.allergies,
                }, {
                  name: m.name,
                  likes: m.likes,
                  dislikes: m.dislikes,
                  allergies: m.allergies,
                });
                if (merged) {
                  if (Array.isArray(merged.likes) && JSON.stringify(merged.likes) !== JSON.stringify(single.likes)) {
                    updatePayload.likes = merged.likes;
                  }
                  if (Array.isArray(merged.dislikes) && JSON.stringify(merged.dislikes) !== JSON.stringify(single.dislikes)) {
                    updatePayload.dislikes = merged.dislikes;
                  }
                  if (Array.isArray(merged.allergies) && JSON.stringify(merged.allergies) !== JSON.stringify(single.allergies)) {
                    updatePayload.allergies = merged.allergies;
                  }
                }
                if (Object.keys(updatePayload).length > 0) {
                  try {
                    await supabase
                      .from("family_members")
                      .update(updatePayload)
                      .eq("id", single.id);
                    updates += 1;
                  } catch (e: any) {
                    console.error("family_members single-update error", e?.message || e);
                  }
                }
              } else {
                try {
                  await supabase.from("family_members").insert({
                    profile_id: profileId,
                    name: normalizeName(m.name) ?? null,
                    age: m.age ?? null,
                    weight: m.weight ?? null,
                    activity: m.activity ?? null,
                    likes: Array.isArray(m.likes) ? m.likes : null,
                    dislikes: Array.isArray(m.dislikes) ? m.dislikes : null,
                    allergies: Array.isArray(m.allergies) ? m.allergies : null,
                  });
                  inserts += 1;
                } catch (e: any) {
                  console.error("family_members insert error", e?.message || e);
                }
              }
            }

            console.log("family_members merge done", { updates, inserts, existingCount: existingMembers?.length || 0, incomingCount: incoming.length });

            // Build and persist intelligent facts (likes/dislikes/allergies) with confidence
            if (profileId) {
              try {
                const { data: finalMembers } = await supabase
                  .from("family_members")
                  .select("id,name,likes,dislikes,allergies")
                  .eq("profile_id", profileId);

                const nameId = new Map<string, number>();
                (finalMembers || []).forEach((m: any) => {
                  const n = typeof m?.name === "string" ? m.name.trim().toLowerCase() : "";
                  if (n) nameId.set(n, m.id);
                });

                // Снятия аллергий на уровне членов семьи (из reclassifyFromText)
                const resolvedMembers: Array<{ name?: string; resolvedAllergies?: string[] }> = Array.isArray(
                  (parsed as any)?._resolved?.members
                )
                  ? (parsed as any)._resolved.members
                  : [];
                for (const rm of resolvedMembers) {
                  const nm = typeof rm?.name === "string" ? rm.name.trim().toLowerCase() : "";
                  const memberId = nm ? nameId.get(nm) : undefined;
                  const items = canonicalizeList(Array.isArray(rm?.resolvedAllergies) ? rm!.resolvedAllergies! : []);
                  if (memberId && items.length) {
                    for (const canon of items) {
                      await supabase
                        .from("diet_facts")
                        .delete()
                        .eq("profile_id", profileId)
                        .eq("member_id", memberId)
                        .eq("subject_scope", "member")
                        .eq("category", "allergy")
                        .eq("canonical", canon);
                    }
                  }
                }

                const nowIso = new Date().toISOString();
                const upsertHousehold = async (category: string, item: string, confidence: number) => {
                  const canonical = canonicalizeItem(item);
                  // household scope: ensure uniqueness via select+update or insert
                  const { data: existing } = await supabase
                    .from("diet_facts")
                    .select("id,evidence_count,confidence")
                    .eq("profile_id", profileId)
                    .is("member_id", null)
                    .eq("subject_scope", "household")
                    .eq("category", category)
                    .eq("canonical", canonical)
                    .limit(1)
                    .maybeSingle();
                  if (existing?.id) {
                    await supabase
                      .from("diet_facts")
                      .update({
                        confidence: Math.max(existing.confidence ?? 0.5, confidence),
                        evidence_count: (existing.evidence_count ?? 1) + 1,
                        last_seen: nowIso,
                      })
                      .eq("id", existing.id);
                  } else {
                    await supabase.from("diet_facts").insert({
                      profile_id: profileId,
                      member_id: null,
                      subject_scope: "household",
                      category,
                      item,
                      canonical,
                      confidence,
                      evidence_count: 1,
                      status: "unconfirmed",
                      first_seen: nowIso,
                      last_seen: nowIso,
                    });
                  }
                };

                const upsertMember = async (member_id: number, category: string, item: string, confidence: number) => {
                  const canonical = canonicalizeItem(item);
                  const { data: existing } = await supabase
                    .from("diet_facts")
                    .select("id,evidence_count,confidence")
                    .eq("profile_id", profileId)
                    .eq("member_id", member_id)
                    .eq("subject_scope", "member")
                    .eq("category", category)
                    .eq("canonical", canonical)
                    .limit(1)
                    .maybeSingle();
                  if (existing?.id) {
                    await supabase
                      .from("diet_facts")
                      .update({
                        confidence: Math.max(existing.confidence ?? 0.5, confidence),
                        evidence_count: (existing.evidence_count ?? 1) + 1,
                        last_seen: nowIso,
                      })
                      .eq("id", existing.id);
                  } else {
                    await supabase.from("diet_facts").insert({
                      profile_id: profileId,
                      member_id,
                      subject_scope: "member",
                      category,
                      item,
                      canonical,
                      confidence,
                      evidence_count: 1,
                      status: "unconfirmed",
                      first_seen: nowIso,
                      last_seen: nowIso,
                    });
                  }
                };

                // Household-level facts from parsed
                const householdPrefsArr = Array.isArray((parsed as any)?.preferences) ? (parsed as any).preferences : [];
                const householdAllergiesArr = Array.isArray((parsed as any)?.allergies) ? (parsed as any).allergies : [];
                for (const raw of canonicalizeList(householdPrefsArr)) {
                  await upsertHousehold("dislike", raw, 0.75);
                }
                for (const raw of canonicalizeList(householdAllergiesArr)) {
                  await upsertHousehold("allergy", raw, 0.85);
                }

                // Member-level facts from final members
                for (const m of (finalMembers || [])) {
                  const memberId = m.id as number;
                  const likesArr = canonicalizeList(Array.isArray(m?.likes) ? m.likes : []);
                  const dislikesArr = canonicalizeList(Array.isArray(m?.dislikes) ? m.dislikes : []);
                  const allergiesArr = canonicalizeList(Array.isArray(m?.allergies) ? m.allergies : []);
                  for (const it of likesArr) await upsertMember(memberId, "like", it, 0.8);
                  for (const it of dislikesArr) await upsertMember(memberId, "dislike", it, 0.8);
                  for (const it of allergiesArr) await upsertMember(memberId, "allergy", it, 0.9);
                }
                console.log("diet_facts upserted for profile", profileId);
              } catch (e: any) {
                console.error("diet_facts save error", e?.message || e);
              }
            }
          } else {
            console.log("family_members: skip insert — missing profileId");
          }
        }
      } catch (err: any) {
        console.error("profiles save block failed", err?.message || err);
        // не ломаем основной ответ, если сохранение профиля не удалось
      }
    } else {
      console.log("profiles: skip saving due to missing user_id or empty userText", {
        user_id,
        userTextLength: userText.trim().length,
      });
    }
    // Жёсткий шаг подтверждения: разрешаем план только при подтверждении И полной комплектности данных
    // Confirmation gating removed: use model content directly
    
    // Достаём текущие массивы для сводки
    let famArr = Array.isArray((global as any).parsed?.family_members)
      ? (global as any).parsed.family_members
      : Array.isArray((parsed as any)?.family_members)
      ? (parsed as any).family_members
      : [];
    let householdPrefs = Array.isArray((parsed as any)?.preferences) ? (parsed as any).preferences : [];
    let householdAllergies = Array.isArray((parsed as any)?.allergies) ? (parsed as any).allergies : [];
    const goalsArr = Array.isArray((parsed as any)?.goals) ? (parsed as any).goals : [];
    const budgetVal = typeof (parsed as any)?.budget === "number" ? (parsed as any).budget : undefined;
    
    const stripTriggersDisplay = (raw: string): string => {
      return raw
        .toLowerCase()
        .replace(/\b(не\s*ест|не\s*употребля[юе]т|избегает|избегаю|не\s*любит|не\s*люблю|люблю|любит|обожаю|обожает|предпочитаю|предпочитает)\b/g, "")
        .replace(/\b(аллергия\s*на|непереносимость|интолерантность|реакция\s*на)\b/g, "")
        .replace(/\b(имеешь\s*в\s*виду|в\s*виду)\b/g, "")
        .replace(/["'«»().,;:]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    };

    // Prefer reading aggregated facts from diet_facts if profile is available
    // Локально вычисляем profileId и создаем клиент Supabase для этого блока
  const localProfileId: number | undefined =
    typeof profile !== "undefined" && (profile as any)?.id ? Number((profile as any).id) : undefined;
    const { getSupabaseServer } = await import("@/lib/supabase");
    const supabaseClient = getSupabaseServer();

    if (localProfileId) {
      try {
        const { data: facts } = await supabaseClient
          .from("diet_facts")
          .select("member_id,subject_scope,category,canonical")
          .eq("profile_id", localProfileId);
        const houseLikes: string[] = [];
        const houseDislikes: string[] = [];
        const houseAllergies: string[] = [];
        const byMember: Record<string, { likes: string[]; dislikes: string[]; allergies: string[] }> = {};
        (facts || []).forEach((f: any) => {
          const canon = typeof f?.canonical === "string" ? f.canonical : "";
          if (!canon) return;
          if (f.subject_scope === "household") {
            if (f.category === "like") houseLikes.push(canon);
            else if (f.category === "dislike") houseDislikes.push(canon);
            else if (f.category === "allergy") houseAllergies.push(canon);
          } else if (f.subject_scope === "member" && typeof f?.member_id === "number") {
            const key = String(f.member_id);
            byMember[key] = byMember[key] || { likes: [], dislikes: [], allergies: [] };
            if (f.category === "like") byMember[key].likes.push(canon);
            else if (f.category === "dislike") byMember[key].dislikes.push(canon);
            else if (f.category === "allergy") byMember[key].allergies.push(canon);
          }
        });
        householdPrefs = houseDislikes;
        householdAllergies = houseAllergies;
        // Reconstruct famArr from DB members + facts
        const { data: dbMembers } = await supabaseClient
          .from("family_members")
          .select("id,name,age,weight,activity")
          .eq("profile_id", localProfileId);
        if (Array.isArray(dbMembers)) {
          famArr = dbMembers.map((m: any) => ({
            name: m?.name ?? undefined,
            age: m?.age ?? undefined,
            weight: m?.weight ?? undefined,
            activity: m?.activity ?? undefined,
            likes: Array.from(new Set(byMember[String(m.id)]?.likes || [])),
            dislikes: Array.from(new Set(byMember[String(m.id)]?.dislikes || [])),
            allergies: Array.from(new Set(byMember[String(m.id)]?.allergies || [])),
          }));
        }
      } catch (e: any) {
        console.error("diet_facts read error", e?.message || e);
      }
    }
    const displayCanonical: Record<string, string> = {
      ...{
        "курица": "курица",
        "курицу": "курица",
        "курицы": "курица",
        "молоко": "молоко",
        "лактоза": "лактоза",
        "морепродукты": "морепродукты",
        "гречка": "гречка",
        "брокколи": "брокколи",
        // Капуста: все формы отображаем как «капуста»
        "капуста": "капуста",
        "капусту": "капуста",
        "капусты": "капуста",
        "капусте": "капуста",
        "капустой": "капуста",
        "белокочанная капуста": "капуста",
        "капуста белокочанная": "капуста",
        "пекинская капуста": "капуста",
        "капуста пекинская": "капуста",
        "цветная капуста": "капуста",
        "капуста цветная": "капуста",
        "грецкие орехи": "грецкие орехи",
        "грецкий орех": "грецкие орехи",
        "орехи грецкие": "грецкие орехи",
        "орех грецкий": "грецкие орехи",
        "тыква": "тыква",
        "тыкву": "тыква",
        "тыквы": "тыква",
      },
    };
    const canonDisplayList = (arr: any): string[] => {
      const items = Array.isArray(arr) ? arr : [];
      const norm = items
        .map((x) => {
          const s = typeof x === "string" ? stripTriggersDisplay(x) : "";
          if (!s) return "";
          return displayCanonical[s] ?? s;
        })
        .filter((x) => !!x);
      return Array.from(new Set(norm));
    };
    
    // Разделяем и переклассифицируем householdPrefs: выделяем likes и dislikes из свободного текста
    const likePattern = /(люблю|любит|обожаю|обожает|предпочитаю|предпочитает)/i;
    const dislikePattern = /(не\s*люблю|не\s*любит|не\s*ест|избегаю|избегает|не\s*употребля[юе]т)/i;
    const splitItems = (s: string): string[] =>
      s
        .split(/[,;]|\s+и\s+/i)
        .map((x) => x.trim())
        .filter(Boolean);
    
    const householdLikesFromPrefs = Array.isArray(householdPrefs)
      ? householdPrefs.flatMap((raw: any) => {
          const s = typeof raw === "string" ? raw : "";
          if (!s) return [];
          if (!likePattern.test(s)) return [];
          // удаляем триггеры и делим на элементы
          const cleaned = stripTriggersDisplay(s);
          return splitItems(cleaned);
        })
      : [];
    const householdDislikesFromPrefs = Array.isArray(householdPrefs)
      ? householdPrefs.flatMap((raw: any) => {
          const s = typeof raw === "string" ? raw : "";
          if (!s) return [];
          if (!dislikePattern.test(s)) return [];
          const cleaned = stripTriggersDisplay(s);
          return splitItems(cleaned);
        })
      : [];
    
    const flatPrefsRaw = Array.from(
      new Set([
        ...householdDislikesFromPrefs,
        ...famArr.flatMap((m: any) => {
          const top = Array.isArray(m?.preferences) ? m.preferences : [];
          const nested = Array.isArray(m?.preferences?.preferences) ? m.preferences.preferences : [];
          // удаляем позитивные формулировки из топ-уровня
          const topFiltered = top.filter((x: any) => (typeof x === "string" ? !likePattern.test(x) : true));
          const nestedFiltered = nested.filter((x: any) => (typeof x === "string" ? !likePattern.test(x) : true));
          return [...topFiltered, ...nestedFiltered];
        }),
      ])
    );
    const flatAllergiesRaw = Array.from(
      new Set([
        ...householdAllergies,
        ...famArr.flatMap((m: any) => (Array.isArray(m?.allergies) ? m.allergies : [])),
      ])
    );
    const flatLikesRaw = Array.from(
      new Set([
        ...householdLikesFromPrefs,
        ...famArr.flatMap((m: any) => {
          const nestedLikes = Array.isArray(m?.preferences?.likes) ? m.preferences.likes : [];
          const topLikes = Array.isArray((m as any)?.likes) ? (m as any).likes : [];
          return [...nestedLikes, ...topLikes];
        }),
      ])
    );
    const flatPrefs = canonDisplayList(flatPrefsRaw);
    const flatAllergies = canonDisplayList(flatAllergiesRaw);
    const flatLikes = canonDisplayList(flatLikesRaw);
    const famDesc = famArr
      .map((m: any, idx: number) => {
        const name = typeof m?.name === "string" && m.name.trim() ? m.name.trim() : idx === 0 ? "Я" : "Член семьи";
        const age = typeof m?.age === "number" ? `${m.age} лет` : null;
        const weight = typeof m?.weight === "number" ? `${m.weight} кг` : typeof m?.weightKg === "number" ? `${m.weightKg} кг` : null;
        const activity = typeof m?.activity === "string" && m.activity.trim() ? `активность: ${m.activity}` : null;
        const parts = [age, weight, activity].filter(Boolean).join(", ");
        return `${name}${parts ? `: ${parts}` : ""}`;
      })
      .join("; ");
    
    // Проверка полноты: достаточно наличия возраста или активности хотя бы у одного члена семьи
    const hasFamilyDetails =
      famArr.length > 0 &&
      famArr.some((m: any) => typeof m?.age === "number" || (typeof m?.activity === "string" && m.activity.trim()));
    const hasBudget = typeof budgetVal === "number" && budgetVal > 0;
    const hasPrefs = flatPrefs.length > 0;
    const hasAllergiesRequired = flatAllergies.length > 0;
    const hasDietInfo = hasPrefs && hasAllergiesRequired; // обязательно оба
    const hasGoals = goalsArr.length > 0;
    const isComplete = hasFamilyDetails && hasBudget && hasDietInfo && hasGoals;
    
    const missing: string[] = [];
    if (!hasFamilyDetails) missing.push("состав семьи (возраст, активность)");
    if (!hasBudget) missing.push("бюджет на неделю");
    if (!hasPrefs) missing.push("предпочтения");
    if (!hasAllergiesRequired) missing.push("аллергии");
    if (!hasGoals) missing.push("цели");
    
    const confirmText = [
      "Проверяем данные:",
      "",
      `- Семья: ${famDesc || "данные не указаны"}`,
      `- Бюджет: ${typeof budgetVal === "number" ? `${budgetVal} руб/неделю` : "не указан"}`,
      `- Цели: ${goalsArr.length ? goalsArr.join(", ") : "не указаны"}`,
      `- Нелюбимые/ограничения: ${flatPrefs.length ? flatPrefs.join(", ") : "нет"}`,
      `- Любимые: ${flatLikes.length ? flatLikes.join(", ") : "нет"}`,
      `- Аллергии: ${flatAllergies.length ? flatAllergies.join(", ") : "нет"}`,
      "",
      isComplete
        ? "Всё верно? Подтвердите — и приступим к плану питания!"
        : `Не хватает: ${missing.join(", ")}. Пожалуйста, укажите эти данные.`,
    ].join("\n");
    
    // Confirmation prompt disabled — не переопределяем ответ модели
    return NextResponse.json({ content, meta: { path: "agent", useAgent: true } });
    
    
  } catch (err: any) {
    const message = err?.message ?? "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}