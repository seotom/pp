// src/services/message-parser.service.ts
import OpenAI from "openai";
import { getSupabaseServer } from "@/lib/supabase";
import { DatabaseService } from "./database.service";
import { CanonicalizationService } from "./canonicalization";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

export class MessageParserService {
  private databaseService = new DatabaseService();
  private canonicalizationService = new CanonicalizationService();

  async extractBasicInfo(message: string, userId: string): Promise<{ content: string } | void> {
    try {
      // Включить AI для лучшей нормализации при парсинге
      this.canonicalizationService.enableAI();
      
      const supabase = getSupabaseServer();
      const nowIso = new Date().toISOString();

      // 1️⃣ Получаем профиль или создаём, если его ещё нет
      let profile: any = null;
      const { data: profileData, error: profileError } = await supabase
        .from("profiles")
        .select("id, budget, goals, family_data")
        .eq("user_id", userId)
        .maybeSingle();
      
      if (profileError) {
        console.error("❌ Ошибка чтения профиля:", profileError);
        return;
      }
      
      if (profileData) {
        profile = profileData;
      } else {
        const { data: insertedProfile, error: insertProfileError } = await supabase
          .from("profiles")
          .insert({ user_id: userId })
          .select("id, budget, goals, family_data")
          .maybeSingle();
        
        if (insertProfileError || !insertedProfile) {
          console.error("❌ Не удалось создать профиль пользователя:", insertProfileError);
          return;
        }
        profile = insertedProfile;
      }

      if (!profile) {
        console.error("❌ Профиль пользователя остался неинициализированным");
        return;
      }

      let profileRecord = profile;
      const clarificationNotes: string[] = [];
      const unknownMembers = new Set<string>();

      const { data: existingMembersRaw, error: existingMembersError } = await supabase
        .from("family_members")
        .select("id, name, age, weight, allergies, dislikes, likes")
        .eq("profile_id", profileRecord.id);
      
      if (existingMembersError) {
        console.error("⚠️ Ошибка загрузки текущих членов семьи:", existingMembersError);
      }

      const trimName = (value: string | null | undefined) =>
        typeof value === "string" ? value.trim() : "";

      const memberMap = new Map<string, any>();
      const memberIdMap = new Map<number, any>();
      
      for (const member of existingMembersRaw || []) {
        const trimmed = trimName(member?.name);
        if (trimmed) {
          memberMap.set(trimmed.toLowerCase(), member);
        }
        if (typeof member?.id === "number") {
          memberIdMap.set(member.id, member);
        }
      }

      const existingMemberNames = Array.from(memberMap.values())
        .map((member) => trimName(member?.name))
        .filter((name) => name.length > 0);

      const profileFamilyData = profileRecord.family_data && typeof profileRecord.family_data === "object"
        ? { ...profileRecord.family_data }
        : {};

      let storedPrimaryMemberId: number | null = typeof (profileFamilyData?.primary_member_id as number | undefined) === "number"
        ? (profileFamilyData.primary_member_id as number)
        : null;

      let storedPrimaryMemberName: string = typeof profileFamilyData?.primary_member_name === "string"
        ? profileFamilyData.primary_member_name.trim()
        : "";

      let primaryMemberRecord: any | null = null;
      if (storedPrimaryMemberId != null) {
        primaryMemberRecord = memberIdMap.get(storedPrimaryMemberId) ?? null;
        if (!primaryMemberRecord) {
          storedPrimaryMemberId = null;
        }
      }

      if (!primaryMemberRecord && storedPrimaryMemberName) {
        const lookup = memberMap.get(storedPrimaryMemberName.toLowerCase()) ?? null;
        if (lookup) {
          primaryMemberRecord = lookup;
          if (typeof lookup?.id === "number") {
            storedPrimaryMemberId = lookup.id;
          }
        } else {
          storedPrimaryMemberName = "";
        }
      }

      if (!primaryMemberRecord && Array.isArray(existingMembersRaw) && existingMembersRaw.length === 1) {
        primaryMemberRecord = existingMembersRaw[0] ?? null;
        if (typeof primaryMemberRecord?.id === "number") {
          storedPrimaryMemberId = primaryMemberRecord.id;
        }
        if (typeof primaryMemberRecord?.name === "string") {
          storedPrimaryMemberName = primaryMemberRecord.name.trim();
        }
      }

      const parserKnownMembersSegment = existingMemberNames.length > 0
        ? `Известные члены семьи (используй точные имена при совпадении): ${JSON.stringify(existingMemberNames)}.`
        : "Нет известных членов семьи, любые имена уточняй у пользователя.";

      const parserPrimaryMemberSegment = primaryMemberRecord && storedPrimaryMemberName
        ? `Основной участник (первое лицо): ${storedPrimaryMemberName}. Если сообщение звучит от первого лица («я», «мне», «у меня»), используй именно это имя в resolved_names и укажи target_scope=\"self\".`
        : "Основной участник, говорящий от первого лица, пока не определён. Если встречаются местоимения «я», «мне», «у меня», попроси пользователя назвать конкретного члена семьи и верни target_scope=\"unknown\" до уточнения.";

      let pendingPrimaryMemberId = storedPrimaryMemberId;
      let pendingPrimaryMemberName = storedPrimaryMemberName;

      // 2️⃣ Анализируем сообщение через AI
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `Ты — парсер сообщений пользователя для AI-ассистента питания.
            ${parserKnownMembersSegment}
            ${parserPrimaryMemberSegment}
            Верни СТРОГО JSON:
            {
              "family_members": [
                {
                  "name": string,
                  "age": number | null,
                  "weight": number | null,
                  "likes": string[] | [],
                  "dislikes": string[] | [],
                  "allergies": string[] | [],
                  "is_primary": boolean | null
                }
              ],
              "budget": number | null,
              "goals": string[] | [],
              "updates_per_person": [
                {
                  "name": string,
                  "resolved_names": string[] | [],
                  "applies_to_family": boolean,
                  "target_scope": "self" | "family" | "named" | "unknown",
                  "add_allergies": string[] | [],
                  "remove_allergies": string[] | [],
                  "add_dislikes": string[] | [],
                  "remove_dislikes": string[] | [],
                  "add_likes": string[] | [],
                  "remove_likes": string[] | []
                }
              ]
            }
            
            Если предпочтения индивидуальные (только для одного человека), 
            НЕ используй target_scope='family' и applies_to_family=true.
            Используй target_scope='named' и указывай конкретные имена в resolved_names.
            
            Если изменение касается всей семьи или всех существующих участников, установи applies_to_family=true и оставь resolved_names пустым, даже если в сообщении есть обобщенные выражения.
            При target_scope="family" обязательно ставь applies_to_family=true. При target_scope="self" используй имя основного участника из подсказки, если оно известно. Для target_scope="named" перечисляй конкретных людей в resolved_names. Если нельзя однозначно определить адресата, установи target_scope="unknown" и оставь resolved_names пустым.
            Если в сообщении становится понятно, кто именно говорит от первого лица, добавь is_primary=true для соответствующей записи в family_members.
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

      console.log('🔍 RAW AI RESPONSE:', raw);
            
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

      const registerMemberRecord = (record: any) => {
        if (!record) return;
        if (typeof record?.id === "number") {
          memberIdMap.set(record.id, record);
        }
        const key = normalizeName(record?.name).toLowerCase();
        if (key) {
          memberMap.set(key, record);
        }
      };

      const setPrimaryMemberCandidate = (record: any) => {
        if (!record) return;
        if (typeof record?.id === "number") {
          pendingPrimaryMemberId = record.id;
        }
        const trimmed = normalizeName(record?.name);
        if (trimmed) {
          pendingPrimaryMemberName = trimmed;
        }
      };

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

      const ambiguousNamePlaceholders = new Set([""]);
      
      const isAmbiguousName = (rawName: unknown) => {
        const trimmed = normalizeName(typeof rawName === "string" ? rawName : String(rawName ?? ""));
        if (!trimmed) return true;
        const lower = trimmed.toLowerCase();
        return ambiguousNamePlaceholders.has(lower) || isGroupPlaceholder(lower);
      };

      const getExistingMemberRecord = (rawName: string | undefined | null, options: { quiet?: boolean } = {}) => {
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

      const applySnapshotToMember = async (snapshot: any, options: { allowPreferenceChanges: boolean }) => {
        const trimmedName = normalizeName(snapshot?.name);
        if (!trimmedName) return;
        if (isGroupPlaceholder(trimmedName)) return;
        
        const key = trimmedName.toLowerCase();
        const existing = memberMap.get(key);
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
        const snapshotObject = (snapshot && typeof snapshot === "object") ? snapshot : {};
        const hasLikesField = Object.prototype.hasOwnProperty.call(snapshotObject, "likes");
        const hasDislikesField = Object.prototype.hasOwnProperty.call(snapshotObject, "dislikes");
        const hasAllergiesField = Object.prototype.hasOwnProperty.call(snapshotObject, "allergies");

        // 🔄 ИНТЕГРАЦИЯ CANONICALIZATION SERVICE - НОРМАЛИЗАЦИЯ ПРЕДПОЧТЕНИЙ
        const updatePayload: Record<string, any> = {};
        if ((existing?.name || "").trim() !== trimmedName) updatePayload.name = trimmedName;
        if (age !== null) updatePayload.age = age;
        if (weight !== null) updatePayload.weight = weight;

        if (allowPreferences) {
          if (hasLikesField) {
            updatePayload.likes = likesRaw && likesRaw.length > 0
              ? await this.canonicalizationService.canonicalizeListAsync(likesRaw)
              : (!existing || !Array.isArray(existing.likes) || existing.likes.length === 0 ? [] : null);
          }
          if (hasDislikesField) {
            updatePayload.dislikes = dislikesRaw && dislikesRaw.length > 0
              ? await this.canonicalizationService.canonicalizeListAsync(dislikesRaw)
              : (!existing || !Array.isArray(existing.dislikes) || existing.dislikes.length === 0 ? [] : null);
          }
          if (hasAllergiesField) {
            updatePayload.allergies = allergiesRaw && allergiesRaw.length > 0
              ? await this.canonicalizationService.canonicalizeListAsync(allergiesRaw)
              : (!existing || !Array.isArray(existing.allergies) || existing.allergies.length === 0 ? [] : null);
          }
        }

        if (!allowPreferences && wantsPreferenceChanges) {
          clarificationNotes.push(
            `Я услышал про изменения вкусов, но не понял, кого именно касается фраза «${message}». Уточните имя участника, пожалуйста.`
          );
        }

        if (existing) {
          const previousKey = normalizeName(existing?.name).toLowerCase();
          
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
              if (previousKey && previousKey !== key) {
                memberMap.delete(previousKey);
              }
              registerMemberRecord(updated);
              if (snapshot?.is_primary && typeof updated?.id === "number") {
                setPrimaryMemberCandidate(updated);
              }
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
          if (updatePayload.likes !== null) insertPayload.likes = updatePayload.likes;
          if (updatePayload.dislikes !== null) insertPayload.dislikes = updatePayload.dislikes;
          if (updatePayload.allergies !== null) insertPayload.allergies = updatePayload.allergies;
          
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
            registerMemberRecord(inserted);
            if (snapshot?.is_primary && typeof inserted?.id === "number") {
              setPrimaryMemberCandidate(inserted);
            }
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
          profileRecord = { ...profileRecord, budget: normalizedBudget };
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
          profileRecord = { ...profileRecord, goals: goalsString };
        }
      }

      const toProductList = (value: unknown): string[] => normalizeArray(value) || [];
      
      const normalizeTargetScope = (value: unknown): "self" | "family" | "named" | "unknown" => {
        if (typeof value !== "string") return "named";
        const normalized = value.trim().toLowerCase();
        if (normalized === "self" || normalized === "primary" || normalized === "owner") {
          return "self";
        }
        if (normalized === "family" || normalized === "household" || normalized === "all") {
          return "family";
        }
        if (normalized === "unknown" || normalized === "clarify" || normalized === "unsure") {
          return "unknown";
        }
        if (normalized === "named" || normalized === "specific") {
          return "named";
        }
        return "named";
      };

      const updatesPerPerson: any[] = Array.isArray(data?.updates_per_person)
        ? data.updates_per_person.map((rawUpdate: any) => {
            const trimmedName = normalizeName(rawUpdate?.name);
            const originalName = typeof rawUpdate?.name === "string" ? rawUpdate.name : trimmedName;
            return {
              name: trimmedName,
              original_name: originalName,
              resolved_names: normalizeArray(rawUpdate?.resolved_names) || [],
              applies_to_family: Boolean(rawUpdate?.applies_to_family),
              target_scope: normalizeTargetScope(rawUpdate?.target_scope),
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
        if ((update.target_scope === "family" || update.applies_to_family) && memberMap.size > 0) {
          return true;
        }
        if (update.target_scope === "self") {
          if (pendingPrimaryMemberId != null && memberIdMap.has(pendingPrimaryMemberId)) {
            return true;
          }
          if (pendingPrimaryMemberName && memberMap.has(pendingPrimaryMemberName.toLowerCase())) {
            return true;
          }
          if (Array.isArray(update.resolved_names)) {
            for (const resolved of update.resolved_names) {
              if (getExistingMemberRecord(resolved, { quiet: true })) {
                return true;
              }
            }
          }
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

      const forbidPreferenceSnapshots = updatesPerPerson.length > 0;
      const shouldSkipPreferenceSnapshots = updatesPerPerson.length > 0 && !hasResolvedTargets;
      
      const rawSnapshots: any[] = Array.isArray(data?.family_members) ? data.family_members : [];
      for (const snapshot of rawSnapshots) {
        await applySnapshotToMember(snapshot, { 
            allowPreferenceChanges: !shouldSkipPreferenceSnapshots 
        });
        console.log('📝 AFTER SNAPSHOT PROCESSING - memberMap:', 
            Array.from(memberMap.entries()).map(([k, v]) => ({ 
                key: k, 
                name: v.name, 
                likes: v.likes, 
                dislikes: v.dislikes 
            }))
        );
      }

      if (shouldSkipPreferenceSnapshots) {
        console.log('🤔 Не удалось точно определить, кто из членов семьи упомянут — пропускаем сохранение до уточнения пользователя');
        clarificationNotes.push(
          'Пока не понял, для кого в семье нужно обновить данные. Уточните, пожалуйста, имя или роль человека, чтобы я мог сохранить изменения.'
        );
        if (!hasResolvedTargets) {
          updatesPerPerson.length = 0;
        }
      }

      // 🔄 ИНТЕГРАЦИЯ CANONICALIZATION SERVICE - ОБРАБОТКА UPDATES_PER_PERSON
      if (updatesPerPerson.length > 0) {
        for (const update of updatesPerPerson) {
          const targetMap = new Map<number, any>();
          const {
            name,
            original_name,
            resolved_names = [],
            applies_to_family = false,
            target_scope = "named",
            add_allergies = [],
            remove_allergies = [],
            add_dislikes = [],
            remove_dislikes = [],
            add_likes = [],
            remove_likes = [],
          } = update;

        console.log('🔄 STARTING UPDATES_PERSON PROCESSING, count:', updatesPerPerson.length);
        console.log('🔧 PROCESSING UPDATE FOR:', update.name, 'target_scope:', update.target_scope);
          
          // НОРМАЛИЗАЦИЯ ПРОДУКТОВ В ОБНОВЛЕНИЯХ
          const normalizedAddAllergies = await this.canonicalizationService.canonicalizeListAsync(add_allergies);
          const normalizedRemoveAllergies = await this.canonicalizationService.canonicalizeListAsync(remove_allergies);
          const normalizedAddDislikes = await this.canonicalizationService.canonicalizeListAsync(add_dislikes);
          const normalizedRemoveDislikes = await this.canonicalizationService.canonicalizeListAsync(remove_dislikes);
          const normalizedAddLikes = await this.canonicalizationService.canonicalizeListAsync(add_likes);
          const normalizedRemoveLikes = await this.canonicalizationService.canonicalizeListAsync(remove_likes);
          
          const mention = original_name || name;
          let effectiveScope: "self" | "family" | "named" | "unknown" = target_scope;
          
          if (applies_to_family && effectiveScope !== "self") {
            effectiveScope = "family";
          }
          
          if (effectiveScope === "family") {
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
          
          if (effectiveScope === "unknown") {
            console.log('⚠️ Контекст неоднозначен — запрошено уточнение перед изменением данных.');
            clarificationNotes.push(
              mention
                ? `Не уверена, кого касается изменение «${mention}». Подскажите, пожалуйста, имя человека или уточните, что речь обо всей семье.`
                : 'Пока не поняла, кого касается это изменение. Укажите, пожалуйста, конкретного участника или скажите, что это для всей семьи.'
            );
            continue;
          }
          
          let primaryCandidate: any | null = null;
          if (effectiveScope === "self") {
            for (const resolved of resolved_names) {
              const candidate = getExistingMemberRecord(resolved, { quiet: true });
              if (candidate) {
                primaryCandidate = candidate;
                break;
              }
            }
            if (!primaryCandidate && pendingPrimaryMemberId != null) {
              primaryCandidate = memberIdMap.get(pendingPrimaryMemberId) ?? null;
            }
            if (!primaryCandidate && pendingPrimaryMemberName) {
              primaryCandidate = memberMap.get(pendingPrimaryMemberName.toLowerCase()) ?? null;
            }
            if (!primaryCandidate && name) {
              primaryCandidate = getExistingMemberRecord(name, { quiet: true });
            }
            if (primaryCandidate?.id != null) {
              targetMap.set(primaryCandidate.id, primaryCandidate);
              setPrimaryMemberCandidate(primaryCandidate);
            } else {
              console.log('⚠️ Контекст неоднозначен — запрошено уточнение перед изменением данных.');
              clarificationNotes.push(
                'Похоже, речь о вас, но я не нашла вашей записи в семье. Подскажите, пожалуйста, как вы записаны, чтобы обновить данные.'
              );
              continue;
            }
          }
          
          const resolvedTargets = effectiveScope === "self" ? [] : resolved_names;
          for (const resolved of resolvedTargets) {
            const memberRecord = getExistingMemberRecord(resolved);
            if (memberRecord?.id != null) {
              targetMap.set(memberRecord.id, memberRecord);
            }
          }
          
          if (effectiveScope !== "family" && targetMap.size === 0 && name) {
            const memberRecord = getExistingMemberRecord(name);
            if (memberRecord?.id != null) {
              targetMap.set(memberRecord.id, memberRecord);
            }
          }
          
          if (targetMap.size === 0) {
            clarificationNotes.push(
              mention
                ? `Пока не понял, кого касается изменение «${mention}». Укажите, пожалуйста, конкретного участника семьи.`
                : 'Пока не понял, кого касается это изменение. Назовите конкретного человека или скажите, что речь о всей семье.'
            );
            continue;
          }
          
          for (const memberRecord of targetMap.values()) {
            console.log('   APPLYING TO MEMBER:', memberRecord.name); 
            const updated = {
              allergies: [...(Array.isArray(memberRecord.allergies) ? memberRecord.allergies : [])],
              dislikes: [...(Array.isArray(memberRecord.dislikes) ? memberRecord.dislikes : [])],
              likes: [...(Array.isArray(memberRecord.likes) ? memberRecord.likes : [])],
            };
            
            const __userText = String(message || '').toLowerCase();
            let addLikes = normalizedAddLikes;
            let removeLikes = normalizedRemoveLikes;
            
            if (/замен/i.test(__userText) && Array.isArray(addLikes) && addLikes.length > 0 && Array.isArray(removeLikes) && removeLikes.length === 0) {
              const inferred: string[] = [];
              for (const likeItem of updated.likes) {
                const low = String(likeItem || '').toLowerCase();
                if (low && __userText.includes(low) && !addLikes.includes(likeItem)) {
                  inferred.push(likeItem);
                }
              }
              if (inferred.length) {
                removeLikes = Array.from(new Set([...(removeLikes || []), ...inferred]));
              }
            }
            
            // Добавления и удаления с автоматическим контролем взаимных связей
            // ✅ Аллергии
            if (normalizedAddAllergies.length) {
              for (const a of normalizedAddAllergies) {
                if (!updated.allergies.includes(a)) updated.allergies.push(a);
                // Удаляем из likes и dislikes, если есть пересечение
                updated.likes = updated.likes.filter(l => l !== a);
                updated.dislikes = updated.dislikes.filter(d => d !== a);
              }
            }
            
            if (normalizedRemoveAllergies.length) {
              if (normalizedRemoveAllergies.includes('все')) {
                // 🧹 Полное очищение аллергий
                console.log(`🧹 Полностью очищаем аллергии у ${memberRecord.name}`);
                updated.allergies = [];
              } else {
                // Точечное удаление указанных аллергий
                updated.allergies = updated.allergies.filter(a => !normalizedRemoveAllergies.includes(a));
                console.log(`❌ Удаляем конкретные аллергии у ${memberRecord.name}: ${normalizedRemoveAllergies.join(', ')}`);
              }
            }
            
            // ✅ Нелюбимые продукты
            if (normalizedAddDislikes.length) {
              for (const d of normalizedAddDislikes) {
                if (!updated.dislikes.includes(d)) updated.dislikes.push(d);
                // Удаляем из likes, если продукт туда попадал
                updated.likes = updated.likes.filter(l => l !== d);
              }
            }
            
            if (normalizedRemoveDislikes.length) {
              updated.dislikes = updated.dislikes.filter(d => !normalizedRemoveDislikes.includes(d));
            }
            
            // ✅ Любимые продукты
            if (addLikes.length) {
              for (const l of addLikes) {
                if (!updated.likes.includes(l)) updated.likes.push(l);
                // Удаляем из dislikes и allergies, если продукт был там
                updated.dislikes = updated.dislikes.filter(d => d !== l);
                updated.allergies = updated.allergies.filter(a => a !== l);
              }
            }
            
            if (removeLikes.length) {
              updated.likes = updated.likes.filter(l => !removeLikes.includes(l));
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
        .select('id, name, age, weight, allergies, dislikes, likes')
        .eq('profile_id', profileRecord.id);
      
      let resolvedPrimaryId = pendingPrimaryMemberId;
      let resolvedPrimaryName = pendingPrimaryMemberName;
      
      if (resolvedPrimaryId != null) {
        const recordById = memberIdMap.get(resolvedPrimaryId) ?? null;
        if (recordById) {
          resolvedPrimaryName = normalizeName(recordById?.name) || resolvedPrimaryName;
        } else {
          resolvedPrimaryId = null;
        }
      }
      
      if (resolvedPrimaryId == null && resolvedPrimaryName) {
        const recordByName = memberMap.get(resolvedPrimaryName.toLowerCase()) ?? null;
        if (recordByName && typeof recordByName?.id === "number") {
          resolvedPrimaryId = recordByName.id;
          resolvedPrimaryName = normalizeName(recordByName?.name) || resolvedPrimaryName;
        }
      }
      
      const normalizedResolvedPrimaryName = resolvedPrimaryName ? resolvedPrimaryName : null;
      const normalizedStoredPrimaryName = storedPrimaryMemberName ? storedPrimaryMemberName : null;
      const shouldPersistPrimary =
        (resolvedPrimaryId ?? null) !== (storedPrimaryMemberId ?? null) ||
        (normalizedResolvedPrimaryName || null) !== (normalizedStoredPrimaryName || null);
      
      if (shouldPersistPrimary) {
        const nextFamilyData: Record<string, any> = { ...profileFamilyData };
        nextFamilyData.primary_member_id = resolvedPrimaryId ?? null;
        nextFamilyData.primary_member_name = normalizedResolvedPrimaryName;
        
        const { error: primaryUpdateError } = await supabase
          .from('profiles')
          .update({ family_data: nextFamilyData })
          .eq('id', profileRecord.id);
        
        if (primaryUpdateError) {
          console.error('⚠️ Не удалось сохранить основного участника семьи:', primaryUpdateError);
        } else {
          profileRecord = { ...profileRecord, family_data: nextFamilyData };
        }
      }

      // 5️⃣ Формируем финальный ответ исключительно из БД
      let text = `Вот актуальная информация о вашей семье:\n\n`;
      for (const m of familyMembers || []) {
        text += `**${m.name}**\n`;
        text += `- Возраст: ${typeof m.age === 'number' ? `${m.age} лет` : 'не указан'}\n`;
        text += `- Вес: ${typeof m.weight === 'number' ? `${m.weight} кг` : 'не указан'}\n`;
        
        // 🔄 ИНТЕГРАЦИЯ CANONICALIZATION SERVICE - НОРМАЛИЗАЦИЯ ПРИ ОТОБРАЖЕНИИ
        const normalizedLikes = this.canonicalizationService.canonicalizeList(m.likes || []);
        const normalizedDislikes = this.canonicalizationService.canonicalizeList(m.dislikes || []);
        const normalizedAllergies = this.canonicalizationService.canonicalizeList(m.allergies || []);
        
        text += `- Любимые продукты: ${normalizedLikes.join(', ') || 'нет'}\n`;
        text += `- Нелюбимые продукты: ${normalizedDislikes.join(', ') || 'нет'}\n`;
        text += `- Аллергии: ${normalizedAllergies.join(', ') || 'нет'}\n\n`;
      }
      
      if (profileRecord.budget) text += `**Бюджет:** ${profileRecord.budget} руб.\n`;
      if (profileRecord.goals) text += `**Цели:** ${profileRecord.goals}\n`;
      
      if (clarificationNotes.length > 0) {
        const uniqueNotes = Array.from(new Set(clarificationNotes));
        text = `${uniqueNotes.join('\n\n')}\n\n${text}`;
      }
      
      return { content: text };
    } catch (err) {
      console.error("Ошибка в extractBasicInfo:", err);
    }
  }
}