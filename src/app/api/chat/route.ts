// src\app\api\chat\route.ts

// стабильный фикс

import { NextRequest } from "next/server";
import OpenAI from "openai";
import { getSupabaseServer } from "@/lib/supabase";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

const BASE_SYSTEM_PROMPT = `Ты - дружелюбный и умный AI-помощник по семейному питанию.

      ОСНОВНЫЕ ПРАВИЛА:
      1. Когда пользователь дает полные данные (семья, бюджет, предпочтения, аллергии, цели) - ПРЕДЛАГАЙ генерацию плана питания
      2. Если данных не хватает - вежливо запроси недостающее
      3. Подтверждай изменения простыми словами
      4. Понимай сложные конструкции ("раньше не любил, теперь люблю")
      5. Отвечай ТОЛЬКО на вопросы по питанию, бюджету, шопинг-листам
      6. НЕ давай медицинских рекомендаций и диагнозов
      7. НЕ обсуждай политику, развлечения, технические детали
      8. При off-topic запросах вежливо возвращай к теме питания

      СОБИРАЙ ДАННЫЕ ПО ШАГАМ ИЗ ВЫШЕУКАЗАННОГО СПИСКА:
      - Шаг 1: узнай состав семьи (количество, имена или роли, возраст и вес каждого)
      - Шаг 2: уточни недельный бюджет (в рублях)
      - Шаг 3: собери любимые и нелюбимые продукты у каждого
      - Шаг 4: собери пищевые аллергии
      - Шаг 5: уточни цели питания
      Не перескакивай через шаги и не перечисляй их все сразу — за один ответ запрашивай или подтверждай только следующий незаполненный шаг.

      КОГДА ПРЕДЛАГАТЬ ПЛАН ПИТАНИЯ:
      - Есть информация о семье (количество, возраст)
      - Известен бюджет
      - Известны предпочтения (что не любят)
      - Известны аллергии
      - Известны цели

      ПРИМЕРЫ ЕСТЕСТВЕННЫХ ОТВЕТОВ:
      - На сложные конструкции: "Понял! Обновляю: добавляю свинину в любимые, убираю курицу из нелюбимых"
      - На массовые операции: "Хорошо, очищаю все ваши аллергии и предпочтения"
      - На полный сброс: "Отлично, начинаю с чистого листа!"

      Всегда будь краток, дружелюбен и точен.

      КЛЮЧЕВЫЕ СООБЩЕНИЯ:
      - Питаться правильно можно даже экономя
      - Продуманный список покупок - основа здоровья семьи
      - Покупайте с умом - не отказывайтесь от полезного

      ИСТОЧНИКИ:
      - Российские нормы питания (МР 2.3.1.0253-21)
      - Данные о составе продуктов
      - Усредненные цены российских магазинов`;

type SupabaseProfile = {
  id: number;
  budget: number | null;
  goals: string | null;
};

type SupabaseFamilyMember = {
  name: string | null;
  age: number | null;
  weight: number | null;
  allergies: string[] | null;
  dislikes: string[] | null;
  likes: string[] | null;
};

// 🔹 Функция получения актуальных данных из Supabase
async function getUserDataFromDB(
  user_id: string
): Promise<{ profile: SupabaseProfile; family: SupabaseFamilyMember[] } | null> {
  const supabase = getSupabaseServer();

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, budget, goals")
    .eq("user_id", user_id)
    .single();

  if (profileError || !profile) {
    console.error("❌ Не удалось найти профиль пользователя:", profileError);
    return null;
  }

  const { data: familyMembers, error: familyError } = await supabase
    .from("family_members")
    .select("name, age, weight, allergies, dislikes, likes")
    .eq("profile_id", profile.id);

  if (familyError) {
    console.error("❌ Ошибка получения family_members:", familyError);
  }

  return {
    profile,
    family: (familyMembers as SupabaseFamilyMember[] | null) || [],
  };
}

function buildKnownDataSummary(data: Awaited<ReturnType<typeof getUserDataFromDB>>): string {
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
        const weight =
          typeof member.weight === "number" && !Number.isNaN(member.weight)
            ? `${member.weight} кг`
            : "вес не указан";
        const likes = Array.isArray(member.likes) ? member.likes.join(", ") || "не указаны" : "не указаны";
        const dislikes = Array.isArray(member.dislikes) ? member.dislikes.join(", ") || "не указаны" : "не указаны";
        const allergies = Array.isArray(member.allergies) ? member.allergies.join(", ") || "не указаны" : "не указаны";

        return `- ${name}: ${age}, ${weight}. Любимые: ${likes}. Нелюбимые: ${dislikes}. Аллергии: ${allergies}.`;
      })
      .join("\n");

    segments.push(`Состав семьи:\n${memberLines}`);
  }

  const budgetValue = data.profile?.budget;
  if (typeof budgetValue === "number" && !Number.isNaN(budgetValue)) {
    segments.push(`Бюджет на неделю: ${budgetValue} руб.`);
  }

  const goalsValue =
    typeof data.profile?.goals === "string" ? data.profile.goals.trim() : "";
  if (goalsValue.length > 0) {
    segments.push(`Цели: ${goalsValue}.`);
  }

  if (segments.length === 0) {
    return "Известных данных пока нет.";
  }

  return segments.join("\n");
}

function buildStepGuidance(data: Awaited<ReturnType<typeof getUserDataFromDB>>): string {
  const family = (data?.family as SupabaseFamilyMember[]) || [];

  const hasCompleteFamily =
    family.length > 0 &&
    family.every((member) => {
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

  const hasPreferences = family.every(
    (member) => Array.isArray(member.likes) && Array.isArray(member.dislikes)
  );
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

// 🔧 Функция синхронизированного анализа и возврата данных
async function extractBasicInfo(message: string, userId: string) {
  try {
    const supabase = getSupabaseServer();

    // 1️⃣ Получаем профиль или создаём, если его ещё нет
    let profile: SupabaseProfile | null = null;
    const { data: profileData, error: profileError } = await supabase
      .from("profiles")
      .select("id, budget, goals")
      .eq("user_id", userId)
      .maybeSingle();

    if (profileError) {
      console.error("❌ Ошибка чтения профиля:", profileError);
      return;
    }

    if (profileData) {
      profile = profileData as SupabaseProfile;
    } else {
      const { data: insertedProfile, error: insertProfileError } = await supabase
        .from("profiles")
        .insert({ user_id: userId })
        .select("id, budget, goals")
        .maybeSingle();

      if (insertProfileError || !insertedProfile) {
        console.error("❌ Не удалось создать профиль пользователя:", insertProfileError);
        return;
      }

      profile = insertedProfile as SupabaseProfile;
    }

    if (!profile) {
      console.error("❌ Профиль пользователя остался неинициализированным");
      return;
    }

    let profileRecord = profile as SupabaseProfile;

    const clarificationNotes: string[] = [];
    const unknownMembers = new Set<string>();

    const { data: existingMembersRaw, error: existingMembersError } = await supabase
      .from("family_members")
      .select("id, name, age, weight, allergies, dislikes, likes")
      .eq("profile_id", profileRecord.id);

    if (existingMembersError) {
      console.error("⚠️ Ошибка загрузки текущих членов семьи:", existingMembersError);
    }

    const existingMemberNames = (existingMembersRaw || [])
      .map((member) => (typeof member?.name === "string" ? member.name.trim() : ""))
      .filter((name) => name.length > 0);

    const parserKnownMembersSegment =
      existingMemberNames.length > 0
        ? `Известные члены семьи (используй точные имена при совпадении): ${JSON.stringify(existingMemberNames)}.`
        : "Нет известных членов семьи, любые имена уточняй у пользователя.";

    // 2️⃣ Анализируем сообщение через AI
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Ты — парсер сообщений пользователя для AI-ассистента питания.
          ${parserKnownMembersSegment}
          Верни СТРОГО JSON:
          {
            "family_members": [
              {
                "name": string,
                "age": number | null,
                "weight": number | null,
                "likes": string[] | [],
                "dislikes": string[] | [],
                "allergies": string[] | []
              }
            ],
            "budget": number | null,
            "goals": string[] | [],
            "updates_per_person": [
              {
                "name": string,
                "resolved_names": string[] | [],
                "applies_to_family": boolean,
                "add_allergies": string[] | [],
                "remove_allergies": string[] | [],
                "add_dislikes": string[] | [],
                "remove_dislikes": string[] | [],
                "add_likes": string[] | [],
                "remove_likes": string[] | []
              }
            ]
          }
          Если изменение касается всей семьи или всех существующих участников, установи applies_to_family=true и оставь resolved_names пустым, даже если в сообщении есть обобщенные выражения.
          Если можешь сопоставить упомянутое имя с одним из известных членов семьи, перечисли эти имена в resolved_names в точном написании как в списке. Не выдумывай новых членов семьи и не используй роли, если есть совпадение по имени.
          Если не уверен, оставь resolved_names пустым и applies_to_family=false, чтобы ассистент уточнил у пользователя.
          Если упомянуто, что данных нет, передай пустой массив. Никакого текста вне JSON.`
        },
        { role: "user", content: message }
      ],
      temperature: 0.1,
      response_format: { type: "json_object" },
    });

    const raw = response.choices[0]?.message?.content;
    if (!raw) return console.log("AI не вернул данные");

    const data = JSON.parse(raw);

    const normalizeArray = (value: unknown): string[] | null => {
      if (!Array.isArray(value)) return null;
      return value
        .map((item) => {
          if (typeof item === "string") return item.trim();
          if (item == null) return "";
          return String(item).trim();
        })
        .filter((item) => item.length > 0);
    };

    const toNumberOrNull = (value: unknown): number | null => {
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string" && value.trim().length > 0) {
        const numeric = Number(value.replace(/,/g, "."));
        if (Number.isFinite(numeric)) return numeric;
      }
      return null;
    };

    const normalizeName = (value: string | undefined | null): string =>
      typeof value === "string" ? value.trim() : "";

    const memberMap = new Map<string, any>();

    for (const member of existingMembersRaw || []) {
      const key = normalizeName(member?.name).toLowerCase();
      if (key) {
        memberMap.set(key, member);
      }
    }

    const isGroupPlaceholder = (rawName: string | undefined | null) => {
      const trimmed = normalizeName(rawName);
      if (!trimmed) return false;
      const lower = trimmed.toLowerCase();
      return (
        [
          "все",
          "вся семья",
          "семья",
          "всем",
          "для всех",
          "вся наша семья",
          "всей семье",
          "оба",
        ].includes(lower) || /^(все|вся|оба)(\s|$)/.test(lower)
      );
    };

    const ambiguousNamePlaceholders = new Set([
      "",
      "пользователь",
      "партнер",
      "партнёр",
      "я",
      "сам",
      "сама",
      "себя",
      "меня",
      "мне",
      "мной",
      "мы",
    ]);

    const isAmbiguousName = (rawName: unknown) => {
      const trimmed = normalizeName(typeof rawName === "string" ? rawName : String(rawName ?? ""));
      if (!trimmed) return true;
      const lower = trimmed.toLowerCase();
      return ambiguousNamePlaceholders.has(lower) || isGroupPlaceholder(lower);
    };

    const getExistingMemberRecord = (
      rawName: string | undefined | null,
      options: { quiet?: boolean } = {}
    ) => {
      const trimmedName = normalizeName(rawName);
      if (!trimmedName) return null;
      const key = trimmedName.toLowerCase();
      const cached = memberMap.get(key);
      if (!cached && !options.quiet) {
        console.log(`⚠️ Член семьи ${trimmedName} не найден среди существующих записей — пропускаем без авто-создания.`);
        if (trimmedName) {
          unknownMembers.add(trimmedName);
        }
      }
      return cached || null;
    };

    const applySnapshotToMember = async (
      snapshot: any,
      options: { allowPreferenceChanges: boolean }
    ) => {
      const trimmedName = normalizeName(snapshot?.name);
      if (!trimmedName) return;
      if (isGroupPlaceholder(trimmedName)) return;

      const key = trimmedName.toLowerCase();
      const age = toNumberOrNull(snapshot?.age);
      const weight = toNumberOrNull(snapshot?.weight);
      const likesRaw = normalizeArray(snapshot?.likes);
      const dislikesRaw = normalizeArray(snapshot?.dislikes);
      const allergiesRaw = normalizeArray(snapshot?.allergies);

      const wantsPreferenceChanges = Boolean(
        (likesRaw && likesRaw.length) ||
          (dislikesRaw && dislikesRaw.length) ||
          (allergiesRaw && allergiesRaw.length)
      );

      const allowPreferences = options.allowPreferenceChanges;
      const likes = allowPreferences ? likesRaw : null;
      const dislikes = allowPreferences ? dislikesRaw : null;
      const allergies = allowPreferences ? allergiesRaw : null;

      if (!allowPreferences && wantsPreferenceChanges) {
        clarificationNotes.push(
          `Я услышал про изменения вкусов, но не понял, кого именно касается фраза «${message}». Уточните имя участника, пожалуйста.`
        );
      }

      const existing = memberMap.get(key);
      if (existing) {
        const updatePayload: Record<string, any> = {};
        if ((existing.name || "").trim() !== trimmedName) updatePayload.name = trimmedName;
        if (age !== null) updatePayload.age = age;
        if (weight !== null) updatePayload.weight = weight;
        if (likes !== null) updatePayload.likes = likes;
        if (dislikes !== null) updatePayload.dislikes = dislikes;
        if (allergies !== null) updatePayload.allergies = allergies;

        if (Object.keys(updatePayload).length > 0) {
          const { data: updated, error: updateError } = await supabase
            .from("family_members")
            .update(updatePayload)
            .eq("id", existing.id)
            .select("id, name, age, weight, allergies, dislikes, likes")
            .maybeSingle();

          if (updateError) {
            console.error(`❌ Ошибка обновления данных ${trimmedName}:`, updateError);
          } else if (updated) {
            memberMap.set(key, updated);
          }
        }
      } else {
        if (isAmbiguousName(trimmedName)) {
          unknownMembers.add(trimmedName);
          return;
        }

        const insertPayload: Record<string, any> = {
          profile_id: profileRecord.id,
          name: trimmedName,
        };
        if (age !== null) insertPayload.age = age;
        if (weight !== null) insertPayload.weight = weight;
        if (likes !== null) insertPayload.likes = likes;
        if (dislikes !== null) insertPayload.dislikes = dislikes;
        if (allergies !== null) insertPayload.allergies = allergies;

        if (Object.keys(insertPayload).length <= 2) {
          unknownMembers.add(trimmedName);
          clarificationNotes.push(
            `Чтобы добавить участника «${trimmedName}», назовите, пожалуйста, его возраст и вес.`
          );
          return;
        }

        const { data: inserted, error: insertError } = await supabase
          .from("family_members")
          .insert(insertPayload)
          .select("id, name, age, weight, allergies, dislikes, likes")
          .maybeSingle();

        if (insertError) {
          console.error(`❌ Ошибка добавления нового члена семьи ${trimmedName}:`, insertError);
        } else if (inserted) {
          memberMap.set(key, inserted);
        }
      }
    };

    const candidateBudget = toNumberOrNull(data?.budget);
    if (candidateBudget !== null) {
      const normalizedBudget = Math.max(0, Math.round(candidateBudget));
      const { error: budgetError } = await supabase
        .from("profiles")
        .update({ budget: normalizedBudget })
        .eq("id", profileRecord.id);

      if (budgetError) {
        console.error("⚠️ Ошибка обновления бюджета:", budgetError);
      } else {
        profileRecord = { ...profileRecord, budget: normalizedBudget } as SupabaseProfile;
      }
    }

    let goalsArray = normalizeArray(data?.goals);
    if (!goalsArray && typeof data?.goals === 'string') {
      goalsArray = normalizeArray(data.goals.split(/[;,]/));
    }
    if (goalsArray && goalsArray.length > 0) {
      const goalsString = goalsArray.join(", ");
      const { error: goalsError } = await supabase
        .from("profiles")
        .update({ goals: goalsString })
        .eq("id", profileRecord.id);

      if (goalsError) {
        console.error("⚠️ Ошибка обновления целей:", goalsError);
      } else {
        profileRecord = { ...profileRecord, goals: goalsString } as SupabaseProfile;
      }
    }

    const toProductList = (value: unknown): string[] => normalizeArray(value) || [];

    const updatesPerPerson: any[] = Array.isArray(data?.updates_per_person)
      ? data.updates_per_person.map((rawUpdate: any) => {
          const trimmedName = normalizeName(rawUpdate?.name);
          const originalName = typeof rawUpdate?.name === "string" ? rawUpdate.name : trimmedName;
          return {
            name: trimmedName,
            original_name: originalName,
            resolved_names: normalizeArray(rawUpdate?.resolved_names) || [],
            applies_to_family: Boolean(rawUpdate?.applies_to_family),
            add_allergies: toProductList(rawUpdate?.add_allergies),
            remove_allergies: toProductList(rawUpdate?.remove_allergies),
            add_dislikes: toProductList(rawUpdate?.add_dislikes),
            remove_dislikes: toProductList(rawUpdate?.remove_dislikes),
            add_likes: toProductList(rawUpdate?.add_likes),
            remove_likes: toProductList(rawUpdate?.remove_likes),
          };
        })
      : [];

    // 🧠 AI-анализ контекста "прошла ли аллергия"
    let shouldApplyFamilyAllergyCleanup = false;
    let shouldDeferAllergyUpdatesForConfirmation = false;

    try {
      const intentPrompt = `
        Ты — аналитик сообщений о питании. Определи, описывает ли пользователь ситуацию,
        в которой пищевая аллергия прошла и данные об аллергии нужно удалить.
        Отличай высказывания о вкусовых предпочтениях ("нравится", "стали есть")
        от сообщений о здоровье.

        Верни СТРОГО JSON вида:
        {
          "classification": "allergy_gone" | "no_allergy_context" | "uncertain",
          "scope": "entire_family" | "specific_people" | "none",
          "needs_confirmation": boolean,
          "reason": string
        }

        Правила:
        - "allergy_gone" ставь только если явно говорится, что аллергии больше нет или её нужно удалить.
        - "no_allergy_context" используй, если речь идёт о вкусах или теме, не связанной с аллергией.
        - Если сомневаешься, используй "uncertain" и needs_confirmation=true.
        - Если сообщение охватывает всю семью, выбирай scope="entire_family".
          Если упомянуты конкретные люди, используй "specific_people".
        - reason коротко поясняет вывод на русском языке.

        Сообщение пользователя: "${message}"
      `;

      const intentResp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: intentPrompt }],
        temperature: 0,
        response_format: { type: "json_object" },
      });

      const parsedIntent = JSON.parse(intentResp.choices[0]?.message?.content || "{}");
      const classification = typeof parsedIntent.classification === "string" ? parsedIntent.classification : "no_allergy_context";
      const scope = typeof parsedIntent.scope === "string" ? parsedIntent.scope : "none";
      const needsConfirmation = Boolean(parsedIntent.needs_confirmation);
      const reason = typeof parsedIntent.reason === "string" ? parsedIntent.reason.trim() : "";

      if (classification === "allergy_gone" && !needsConfirmation) {
        if (scope === "entire_family") {
          console.log('🧠 AI подтвердил, что аллергии прошли у всей семьи — очищаем список аллергий.');
          shouldApplyFamilyAllergyCleanup = true;
        }
      } else if (classification === "uncertain" || needsConfirmation) {
        shouldDeferAllergyUpdatesForConfirmation = true;
        console.log('⚠️ Контекст неоднозначен — запрошено уточнение перед изменением данных.');
        const clarificationText = reason
          ? `${reason} Подтвердите, пожалуйста, прежде чем я обновлю данные.`
          : "Правильно ли я понимаю, что у вас действительно прошла аллергия? Подтвердите, пожалуйста, прежде чем я обновлю данные.";
        clarificationNotes.push(clarificationText);
      }
    } catch (intentError) {
      console.error('⚠️ Ошибка при анализе смысла intentPrompt:', intentError);
    }

    if (shouldDeferAllergyUpdatesForConfirmation) {
      for (const entry of updatesPerPerson) {
        entry.add_allergies = [];
        entry.remove_allergies = [];
      }
    }

    if (shouldApplyFamilyAllergyCleanup && !shouldDeferAllergyUpdatesForConfirmation) {
      if (updatesPerPerson.length === 0) {
        updatesPerPerson.push({
          name: "",
          original_name: "вся семья",
          resolved_names: [],
          applies_to_family: true,
          add_allergies: [],
          remove_allergies: ["все"],
          add_dislikes: [],
          remove_dislikes: [],
          add_likes: [],
          remove_likes: [],
        });
      } else {
        for (const entry of updatesPerPerson) {
          entry.applies_to_family = true;
          entry.remove_allergies = ["все"];
        }
      }
    }




    const hasResolvedTargets = updatesPerPerson.some((update) => {
      if (update.applies_to_family && memberMap.size > 0) {
        return true;
      }
      if (Array.isArray(update.resolved_names)) {
        for (const resolved of update.resolved_names) {
          if (getExistingMemberRecord(resolved, { quiet: true })) {
            return true;
          }
        }
      }
      if (update.name && getExistingMemberRecord(update.name, { quiet: true })) {
        return true;
      }
      return false;
    });

    const shouldSkipPreferenceSnapshots = updatesPerPerson.length > 0 && !hasResolvedTargets;

    const rawSnapshots: any[] = Array.isArray(data?.family_members) ? data.family_members : [];
    for (const snapshot of rawSnapshots) {
      await applySnapshotToMember(snapshot, { allowPreferenceChanges: !shouldSkipPreferenceSnapshots });
    }

    if (shouldSkipPreferenceSnapshots) {
      console.log('🤔 Не удалось точно определить, кто из членов семьи упомянут — пропускаем сохранение до уточнения пользователя');
      clarificationNotes.push(
        'Пока не понял, для кого в семье нужно обновить данные. Уточните, пожалуйста, имя или роль человека, чтобы я мог сохранить изменения.'
      );
      updatesPerPerson.length = 0;
    }

    // 3️⃣ Применяем обновления из updates_per_person
    if (updatesPerPerson.length > 0) {
      for (const update of updatesPerPerson) {
        const {
          name,
          original_name,
          resolved_names = [],
          applies_to_family = false,
          add_allergies = [],
          remove_allergies = [],
          add_dislikes = [],
          remove_dislikes = [],
          add_likes = [],
          remove_likes = [],
        } = update;

        const targetMap = new Map<number, any>();

        if (applies_to_family) {
          const allMembers = Array.from(memberMap.values());
          if (allMembers.length === 0) {
            console.log('⚠️ Нет членов семьи для группового обновления — пропускаем операцию.');
            clarificationNotes.push(
              'Пока нет данных о членах семьи, поэтому не могу применить групповое изменение. Добавьте, пожалуйста, информацию о семье.'
            );
            continue;
          }
          for (const memberRecord of allMembers) {
            if (memberRecord?.id != null) {
              targetMap.set(memberRecord.id, memberRecord);
            }
          }
        }

        for (const resolved of resolved_names) {
          const memberRecord = getExistingMemberRecord(resolved);
          if (memberRecord?.id != null) {
            targetMap.set(memberRecord.id, memberRecord);
          }
        }

        if (!applies_to_family && targetMap.size === 0 && name) {
          const memberRecord = getExistingMemberRecord(name);
          if (memberRecord?.id != null) {
            targetMap.set(memberRecord.id, memberRecord);
          }
        }

        if (targetMap.size === 0) {
          const mention = original_name || name;
          clarificationNotes.push(
            mention
              ? `Пока не понял, кого касается изменение «${mention}». Укажите, пожалуйста, конкретного участника семьи.`
              : 'Пока не понял, кого касается это изменение. Назовите конкретного человека или скажите, что речь о всей семье.'
          );
          continue;
        }

        for (const memberRecord of targetMap.values()) {
          const updated = {
            allergies: [...(Array.isArray(memberRecord.allergies) ? memberRecord.allergies : [])],
            dislikes: [...(Array.isArray(memberRecord.dislikes) ? memberRecord.dislikes : [])],
            likes: [...(Array.isArray(memberRecord.likes) ? memberRecord.likes : [])],
          };

          // Добавления и удаления с автоматическим контролем взаимных связей

          // ✅ Аллергии
          if (add_allergies.length) {
            for (const a of add_allergies) {
              if (!updated.allergies.includes(a)) updated.allergies.push(a);
              // Удаляем из likes и dislikes, если есть пересечение
              updated.likes = updated.likes.filter(l => l !== a);
              updated.dislikes = updated.dislikes.filter(d => d !== a);
            }
          }
          if (remove_allergies.length) {
            if (remove_allergies.includes('все')) {
              // 🧹 Полное очищение аллергий
              console.log(`🧹 Полностью очищаем аллергии у ${memberRecord.name}`);
              updated.allergies = [];
            } else {
              // Точечное удаление указанных аллергий
              updated.allergies = updated.allergies.filter(a => !remove_allergies.includes(a));
              console.log(`❌ Удаляем конкретные аллергии у ${memberRecord.name}: ${remove_allergies.join(', ')}`);
            }
          }

          // ✅ Нелюбимые продукты
          if (add_dislikes.length) {
            for (const d of add_dislikes) {
              if (!updated.dislikes.includes(d)) updated.dislikes.push(d);
              // Удаляем из likes, если продукт туда попадал
              updated.likes = updated.likes.filter(l => l !== d);
            }
          }
          if (remove_dislikes.length) {
            updated.dislikes = updated.dislikes.filter(d => !remove_dislikes.includes(d));
          }

          // ✅ Любимые продукты
          if (add_likes.length) {
            for (const l of add_likes) {
              if (!updated.likes.includes(l)) updated.likes.push(l);
              // Удаляем из dislikes и allergies, если продукт был там
              updated.dislikes = updated.dislikes.filter(d => d !== l);
              updated.allergies = updated.allergies.filter(a => a !== l);
            }
          }
          if (remove_likes.length) {
            updated.likes = updated.likes.filter(l => !remove_likes.includes(l));
          }


          // Убираем пересечения
          updated.allergies = [...new Set(updated.allergies.filter(a => !updated.likes.includes(a) && !updated.dislikes.includes(a)))];
          updated.dislikes = [...new Set(updated.dislikes.filter(d => !updated.likes.includes(d) && !updated.allergies.includes(d)))];
          updated.likes = [...new Set(updated.likes.filter(l => !updated.dislikes.includes(l) && !updated.allergies.includes(l)))];

          const { data: savedMember, error } = await supabase
            .from('family_members')
            .update({
              allergies: updated.allergies,
              dislikes: updated.dislikes,
              likes: updated.likes
            })
            .eq('id', memberRecord.id)
            .select('id, name, age, weight, allergies, dislikes, likes')
            .maybeSingle();

          const targetName = memberRecord.name || name;
          if (error) {
            console.error(`Ошибка обновления ${targetName}:`, error);
          } else {
            console.log(`✅ Обновлены данные для ${targetName}:`, updated);
            if (savedMember) {
              memberMap.set(normalizeName(savedMember.name).toLowerCase(), savedMember);
            }
          }
        }
      }
    }

    if (unknownMembers.size > 0) {
      const unknownList = Array.from(unknownMembers)
        .map((name) => `«${name}»`)
        .join(', ');
      clarificationNotes.push(
        `Пока не нашёл в вашей семье участника ${unknownList}. Напишите, пожалуйста, точное имя или добавьте его отдельным шагом.`
      );
    }

    // 4️⃣ Подтягиваем актуальные данные из БД
    const { data: familyMembers } = await supabase
      .from('family_members')
      .select('name, age, weight, allergies, dislikes, likes')
      .eq('profile_id', profileRecord.id);

    // 5️⃣ Формируем финальный ответ исключительно из БД
    let text = `Вот актуальная информация о вашей семье:\n\n`;

    for (const m of familyMembers || []) {
      text += `**${m.name}**\n`;
      text += `- Возраст: ${typeof m.age === 'number' ? `${m.age} лет` : 'не указан'}\n`;
      text += `- Вес: ${typeof m.weight === 'number' ? `${m.weight} кг` : 'не указан'}\n`;
      text += `- Любимые продукты: ${m.likes?.join(', ') || 'нет'}\n`;
      text += `- Нелюбимые продукты: ${m.dislikes?.join(', ') || 'нет'}\n`;
      text += `- Аллергии: ${m.allergies?.join(', ') || 'нет'}\n\n`;
    }

    if (profileRecord.budget) text += `**Бюджет:** ${profileRecord.budget} руб.\n`;
    if (profileRecord.goals) text += `**Цели:** ${profileRecord.goals}\n`;

    // console.log("💬 Итоговый ответ сформирован из БД:", text);

    if (clarificationNotes.length > 0) {
      const uniqueNotes = Array.from(new Set(clarificationNotes));
      text = `${uniqueNotes.join('\n\n')}\n\n${text}`;
    }

    return { content: text };
  } catch (err) {
    console.error("Ошибка в extractBasicInfo:", err);
  }
}


// Сохранение в diet_facts
async function saveToDietFacts(profileId: number, memberId: number, member: any) {
  try {
    const supabase = getSupabaseServer();
    const now = new Date().toISOString();

    // Сохраняем аллергии
    for (const allergy of member.allergies || []) {
      if (!allergy) continue;
      
      const { error } = await supabase
        .from('diet_facts')
        .upsert({
          profile_id: profileId,
          member_id: memberId,
          subject_scope: 'member',
          category: 'allergy',
          item: allergy,
          canonical: allergy.toLowerCase().trim(),
          confidence: 0.9,
          evidence_count: 1,
          status: 'unconfirmed',
          first_seen: now,
          last_seen: now
        }, {
          onConflict: 'profile_id,member_id,subject_scope,category,canonical'
        });

      if (error) {
        console.error('Ошибка сохранения аллергии в diet_facts:', error);
      }
    }

    // Сохраняем dislikes
    for (const dislike of member.dislikes || []) {
      if (!dislike) continue;
      
      const { error } = await supabase
        .from('diet_facts')
        .upsert({
          profile_id: profileId,
          member_id: memberId,
          subject_scope: 'member',
          category: 'dislike',
          item: dislike,
          canonical: dislike.toLowerCase().trim(),
          confidence: 0.8,
          evidence_count: 1,
          status: 'unconfirmed',
          first_seen: now,
          last_seen: now
        }, {
          onConflict: 'profile_id,member_id,subject_scope,category,canonical'
        });

      if (error) {
        console.error('Ошибка сохранения dislike в diet_facts:', error);
      }
    }

    // Сохраняем likes
    for (const like of member.likes || []) {
      if (!like) continue;
      
      const { error } = await supabase
        .from('diet_facts')
        .upsert({
          profile_id: profileId,
          member_id: memberId,
          subject_scope: 'member',
          category: 'like',
          item: like,
          canonical: like.toLowerCase().trim(),
          confidence: 0.8,
          evidence_count: 1,
          status: 'unconfirmed',
          first_seen: now,
          last_seen: now
        }, {
          onConflict: 'profile_id,member_id,subject_scope,category,canonical'
        });

      if (error) {
        console.error('Ошибка сохранения like в diet_facts:', error);
      }
    }

    console.log('Данные сохранены в diet_facts для member_id:', memberId);

  } catch (error) {
    console.error('Ошибка в saveToDietFacts:', error);
  }
}

// 🔹 ОБРАБОТКА ИНФОРМАЦИОННЫХ ЗАПРОСОВ (например: "Покажи мне информацию о семье")
async function handleInfoRequest(userId: string) {
  const supabase = getSupabaseServer();

  // Получаем профиль
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, budget, goals')
    .eq('user_id', userId)
    .single();

  if (!profile) {
    console.log('Профиль не найден для user_id:', userId);
    return { content: "Профиль не найден" };
  }

  // Получаем членов семьи
  const { data: familyMembers } = await supabase
    .from('family_members')
    .select('name, age, weight, likes, dislikes, allergies')
    .eq('profile_id', profile.id);

  // Формируем текстовый ответ для чата
  let familyText = '';
  if (familyMembers && familyMembers.length > 0) {
    familyMembers.forEach((member, index) => {
      familyText += `${index + 1}. **${member.name}**\n`;
      familyText += member.age ? `   - Возраст: ${member.age} лет\n` : '';
      familyText += member.weight ? `   - Вес: ${member.weight} кг\n` : '';
      familyText += `   - Любимые продукты: ${member.likes?.join(', ') || 'нет данных'}\n`;
      familyText += `   - Нелюбимые продукты: ${member.dislikes?.join(', ') || 'нет данных'}\n`;
      familyText += `   - Аллергии: ${member.allergies?.join(', ') || 'нет аллергий'}\n\n`;
    });
  } else {
    familyText = 'Информация о членах семьи отсутствует.';
  }

  const budgetText = profile.budget ? `- **Бюджет на неделю:** ${profile.budget} рублей\n` : '';
  const goalsText = profile.goals ? `- **Цели:** ${profile.goals}\n` : '';

  const content = `Вот актуальная информация о вашей семье:\n\n### Состав семьи:\n${familyText}### Общая информация:\n${budgetText}${goalsText}`;

  // Возвращаем объект JSON для UI
  return {
    content,
    family: familyMembers || [],
    budget: profile.budget || null,
    goals: profile.goals ? profile.goals.split(',').map((g: string) => g.trim()) : []
  };
}


// ✅ Основной обработчик POST /api/chat
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const messages = body?.messages || [];
    const user_id = body?.user_id;

    console.log("Получен запрос chat:", {
      user_id,
      messagesCount: messages.length,
      lastMessage: messages[messages.length - 1]?.content,
    });

    const lastUserMessage = messages.filter((m: { role: string }) => m.role === "user").pop()?.content ?? "";
    const userData = user_id ? await getUserDataFromDB(user_id) : null;
    const stepGuidance = buildStepGuidance(userData);
    const knownDataSummary = buildKnownDataSummary(userData);
    const systemMessageContent = [
      BASE_SYSTEM_PROMPT,
      `Текущий статус сбора данных: ${stepGuidance}`,
      `Известные данные профиля: ${knownDataSummary}`,
      "Всегда поддерживай последовательность шагов и не переходи к следующему, пока предыдущий не закрыт.",
    ].join("\n\n");

    // 🔹 Если запрос информационный — сразу отдаём из БД
    if (/покажи|информация|предпочтения|семья|профиль/i.test(lastUserMessage)) {
      console.log("🔹 Информационный запрос, подставляем данные из БД");
      const data = await extractBasicInfo(lastUserMessage, user_id);
      const text = data?.content || "Не удалось получить информацию";
      return new Response(text, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-cache",
        },
      });
    }

    // 🔹 Обычный сценарий — с обновлениями
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        try {
          const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "system", content: systemMessageContent }, ...messages],
            temperature: 0.7,
            stream: true,
          });

          for await (const part of completion) {
            const delta = part.choices[0]?.delta?.content || "";
            if (delta) {
              controller.enqueue(encoder.encode(delta));
            }
          }

          if (user_id && lastUserMessage) {
            extractBasicInfo(lastUserMessage, user_id).catch((err) =>
              console.error("Ошибка в extractBasicInfo:", err)
            );
          }
        } catch (error) {
          console.error("Ошибка генерации ответа:", error);
          controller.enqueue(encoder.encode("Ошибка обработки запроса к модели"));
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    });
  } catch (error) {
    console.error("Ошибка в API chat:", error);
    return new Response("Ошибка обработки запроса", { status: 500 });
  }
}
