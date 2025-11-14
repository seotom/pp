// src/modules/entity-resolver/index.ts

import { getSupabaseServiceRoleClient } from "@/lib/supabase";
import type {
  ParsedIntent,
  ResolvedIntent,
  PendingClarification,
  ClarificationState,
} from "@/modules/parser/types";
import type { FamilyMemberRow, ProfileRow, Json } from "@/types/database";


type ResolveEntitiesParams = {
  userId: string;
  intent: ParsedIntent;
};

type LoadResult = {
  profile: ProfileRow;
  familyMembers: FamilyMemberRow[];
};

async function loadProfileAndMembers({ userId }: { userId: string }): Promise<LoadResult> {
  const supabase = getSupabaseServiceRoleClient();
  let { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("*")
    .eq("user_id", userId)
    .returns<ProfileRow[]>() // Возвращаем массив
    .maybeSingle();

  if (profileError) throw profileError;

  if (!profile) {
    const { data: createdProfile, error: createError } = await supabase
      .from("profiles")
      .insert({ user_id: userId })
      .select()
      .single<ProfileRow>(); // Указываем тип для single
    if (createError || !createdProfile) throw createError ?? new Error("Failed to create profile");
    profile = createdProfile;
  }

  const { data: familyMembers, error: membersError } = await supabase
    .from("family_members")
    .select("*")
    .eq("profile_id", profile.id) // Теперь profile.id доступен
    .returns<FamilyMemberRow[]>();

  if (membersError) throw membersError;

  return { profile, familyMembers: familyMembers || [] };
}

function normaliseName(name: string): string {
  return name.trim().toLowerCase();
}

function isSelfReference(name?: string | null): boolean {
  if (!name) return false;
  const n = name.trim().toLowerCase();
  return ["я", "мне", "меня", "мой", "моя", "мои", "пользователь"].includes(n);
}

export async function resolveEntities({
  userId,
  intent,
}: ResolveEntitiesParams): Promise<ResolvedIntent> {
  const { profile, familyMembers } = await loadProfileAndMembers({ userId });
  let familyData: ClarificationState = (profile.family_data as ClarificationState | null) ?? {};

  console.log("🔍 ===== ENTITY-RESOLVER DEBUG START =====");
  console.log("🔍 intent:", JSON.stringify(intent, null, 2));
  console.log("🔍 existingFamilyMembers:", familyMembers.map(m => m.name));
  console.log("🔍 ===== ENTITY-RESOLVER DEBUG END =====\n");
  
  const memberIndex = new Map<number, FamilyMemberRow>();
  const nameToIdIndex = new Map<string, number>();
  familyMembers.forEach(m => {
    memberIndex.set(m.id, m);
    nameToIdIndex.set(normaliseName(m.name), m.id);
  });

  let primaryMemberId = typeof familyData.primary_member_id === 'number' ? familyData.primary_member_id : undefined;

  const updates: ResolvedIntent["updates"] = [];
  const clarifications: PendingClarification[] = [];
  const newMembers: Partial<FamilyMemberRow>[] = [];
  const membersToDelete: FamilyMemberRow[] = [];

  const allUpdates: any[] = [...(intent.updates_per_person || [])];

  if (intent.action_type === 'read') {
    console.log("ℹ️ Обнаружена 'read' операция. Изменения не применяются, возвращаем актуальные данные из БД.");
    return {
        profile,
        familyMembers,
        newMembers: [],
        membersToDelete: [],
        updates: [],
        clarifications: [],
        budget: profile.budget ?? undefined,
        mentioned_salary: intent.mentioned_salary ?? undefined,
        goals: intent.goals ?? undefined,
    };
  }

  if (intent.family_members) {
    for (const fm of intent.family_members) {
        // Приводим FamilyMember к типу IntentUpdate
        const updateFromMember = {
            name: fm.name,
            age: fm.age,
            weight: fm.weight,
            add_likes: fm.likes,
            add_dislikes: fm.dislikes,
            add_allergies: fm.allergies,
            target_scope: 'named',
        };
        allUpdates.push(updateFromMember);
    }
  }
  
  if (intent.members_to_delete) {
    for (const name of intent.members_to_delete) {
      const id = nameToIdIndex.get(normaliseName(name));
      if (id) {
        const member = memberIndex.get(id);
        if (member) membersToDelete.push(member);
      } else {
        clarifications.push({ message: `Не удалось найти члена семьи "${name}" для удаления.`, target_scope: 'unknown', operations: {
          remove_allergies: [],
          remove_dislikes: [],
          remove_likes: [],
          add_allergies: [],
          add_likes: [],
          add_dislikes: []
        }, requestedName: name });
      }
    }
  }
  
  for (const update of allUpdates) {
    const operations = {
      add_allergies: update.add_allergies ?? [],
      add_dislikes: update.add_dislikes ?? [],
      add_likes: update.add_likes ?? [],
      remove_allergies: update.remove_allergies ?? [],
      remove_dislikes: update.remove_dislikes ?? [],
      remove_likes: update.remove_likes ?? [],
      age: update.age,
      weight: update.weight,
    };
    
    let targetMemberIds: number[] = [];

    let scope = update.target_scope;
    if (update.applies_to_family) {
        scope = 'family';
    }
    // "Чиним" ошибку модели: если scope='self', но имя указано явно и это не "я"
    else if (scope === 'self' && update.name && !isSelfReference(update.name)) {
        scope = 'named';
    }

    if (scope === 'family') {
      targetMemberIds = Array.from(memberIndex.keys());
    } else if (scope === 'self' || isSelfReference(update.name)) {
      if (primaryMemberId) {
        targetMemberIds = [primaryMemberId];
      } else {
        const candidateId = nameToIdIndex.get(normaliseName(update.name || ''));
        if (candidateId) {
          primaryMemberId = candidateId;
          familyData = { ...familyData, primary_member_id: primaryMemberId };
          targetMemberIds = [primaryMemberId];
        } else {
          clarifications.push({ message: "Основной представитель семьи не установлен. Укажите, кто это.", target_scope: 'self', operations, requestedName: 'я' });
          continue;
        }
      }
    } else if (update.name) {
      const id = nameToIdIndex.get(normaliseName(update.name));
      if (id) {
        targetMemberIds = [id];
      } else {
        newMembers.push({ profile_id: profile.id, name: update.name, ...operations });
        continue;
      }
    }

    if (targetMemberIds.length > 0) {
      updates.push({
        memberIds: targetMemberIds,
        scope: update.applies_to_family ? 'family' : 'member',
        operations,
        requestedName: update.name,
        target_scope: ""
      });
    } else if (!update.name) {
        clarifications.push({ message: "Не удалось определить, к кому относится это изменение.", target_scope: 'unknown', operations, requestedName: null });
    }
  }

  const supabase = getSupabaseServiceRoleClient();
  if (JSON.stringify(familyData) !== JSON.stringify((profile.family_data as ClarificationState | null) ?? {})) {
      await supabase.from("profiles").update({ family_data: familyData as Json }).eq("id", profile.id);
  }

  return {
    profile: { ...profile, family_data: familyData as Json },
    familyMembers,
    newMembers,
    membersToDelete,
    updates,
    clarifications,
    budget: intent.budget ?? undefined,
    mentioned_salary: intent.mentioned_salary ?? undefined,
    goals: intent.goals ?? undefined,
  };
}

export type { ResolveEntitiesParams, ResolvedIntent };
