// src\modules\entity-resolver\index.ts

import { getSupabaseServiceRoleClient } from "@/lib/supabase";
import type { ParsedIntent, ResolvedIntent } from "@/modules/parser/types";
import type { IntentUpdateOperation } from "@/modules/intent-analyzer/types";
import type {
  ClarificationState,
  PendingClarification,
} from "@/modules/parser/types";
import type { FamilyMemberRow, ProfileRow } from "@/types/database";

type ResolveEntitiesParams = {
  userId: string;
  intent: ParsedIntent;
};

type LoadResult = {
  profile: ProfileRow;
  familyMembers: FamilyMemberRow[];
  familyData: ClarificationState;
};

async function loadProfileAndMembers(userId: string): Promise<LoadResult> {
  const supabase = getSupabaseServiceRoleClient();

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (profileError && profileError.code !== "PGRST116") throw profileError;

  // ✅ Приведение типа СРАЗУ
  let ensuredProfile = profile as ProfileRow | null;

  if (!ensuredProfile) {
    const { data: createdProfile, error: createError } = await supabase
      .from("profiles")
      .insert({
        user_id: userId,
        budget: null,
        goals: null,
        family_data: null,
      })
      .select()
      .single();

    if (createError || !createdProfile)
      throw createError ?? new Error("Failed to create user profile.");

    // ✅ Приведение типа
    ensuredProfile = createdProfile as ProfileRow;
  }

  const { data: members, error: membersError } = await supabase
    .from("family_members")
    .select("*")
    .eq("profile_id", ensuredProfile.id);  // ✅ Теперь работает!

  if (membersError) throw membersError;

  // ✅ Теперь работает БЕЗ дополнительного приведения типа!
  const familyData =
    (ensuredProfile.family_data as ClarificationState | null) ?? {};

  return {
    profile: ensuredProfile,
    familyMembers: (members ?? []) as FamilyMemberRow[],
    familyData,
  };
}


function normaliseName(name: string): string {
  return name.trim().toLowerCase();
}

function isSelfReference(name?: string | null): boolean {
  if (!name) return false;
  const n = name.trim().toLowerCase();
  return ["я", "мне", "меня", "мой", "моя", "мои", "пользователь"].includes(
    n
  );
}

function describeOperations(operations: IntentUpdateOperation): string {
  const fragments: string[] = [];

  if (operations.add_allergies.length)
    fragments.push(`add allergies: ${operations.add_allergies.join(", ")}`);
  if (operations.remove_allergies.length)
    fragments.push(
      `remove allergies: ${operations.remove_allergies.join(", ")}`
    );
  if (operations.add_likes.length)
    fragments.push(`add likes: ${operations.add_likes.join(", ")}`);
  if (operations.remove_likes.length)
    fragments.push(`remove likes: ${operations.remove_likes.join(", ")}`);
  if (operations.add_dislikes.length)
    fragments.push(`add dislikes: ${operations.add_dislikes.join(", ")}`);
  if (operations.remove_dislikes.length)
    fragments.push(`remove dislikes: ${operations.remove_dislikes.join(", ")}`);

  return fragments.join("; ");
}

function convertUnknownNamesToFamilyMembers(
  update: any,
  existingNames: Set<string>
): { isNewMember: boolean; familyMember?: Partial<FamilyMemberRow> } {
  if (!update.name) return { isNewMember: false };

  const normalizedName = normaliseName(update.name);
  const exists = existingNames.has(normalizedName);

  if (!exists && update.age && update.weight) {
    console.log(
      "🔄 CONVERTING to family_member: unknown name '%s' with age=%d weight=%d",
      update.name,
      update.age,
      update.weight
    );
    return {
      isNewMember: true,
      familyMember: {
        name: update.name,
        age: update.age,
        weight: update.weight,
        likes: update.add_likes || [],
        dislikes: update.add_dislikes || [],
        allergies: update.add_allergies || [],
      } as Partial<FamilyMemberRow>,
    };
  }

  return { isNewMember: false };
}

export async function resolveEntities({
  userId,
  intent,
}: ResolveEntitiesParams): Promise<ResolvedIntent> {
  const { profile, familyMembers, familyData } =
    await loadProfileAndMembers(userId);

  console.log("🔍 ===== ENTITY-RESOLVER DEBUG START =====");
  console.log(
    "🔍 intent.family_members:",
    JSON.stringify(intent.family_members, null, 2)
  );
  console.log(
    "🔍 intent.members_to_delete:",
    JSON.stringify(intent.members_to_delete, null, 2)
  );
  console.log(
    "🔍 intent.updates_per_person:",
    JSON.stringify(intent.updates_per_person, null, 2)
  );
  console.log("🔍 intent.budget:", intent.budget);
  console.log("🔍 intent.mentioned_salary:", intent.mentioned_salary);
  console.log(
    "🔍 existingFamilyMembers count:",
    familyMembers.length,
    familyMembers.map((m) => m.name)
  );
  console.log("🔍 ===== ENTITY-RESOLVER DEBUG END =====\n");

  const primaryMemberId =
    typeof familyData.primary_member_id === "number"
      ? familyData.primary_member_id
      : undefined;

  const memberIndex = new Map<string, FamilyMemberRow>();
  for (const member of familyMembers) {
    memberIndex.set(normaliseName(member.name), member);
  }

  const updates: ResolvedIntent["updates"] = [];
  const clarifications: PendingClarification[] = [];

  // ✅ НОВОЕ: Обрабатываем удаление членов
  const membersToDelete: FamilyMemberRow[] = [];

  if (
    Array.isArray(intent.members_to_delete) &&
    intent.members_to_delete.length > 0
  ) {
    console.log("🗑️ Processing members to delete:", intent.members_to_delete);

    for (const nameToDelete of intent.members_to_delete) {
      const norm = normaliseName(nameToDelete);
      const memberToDelete = familyMembers.find(
        (m) => normaliseName(m.name) === norm
      );

      if (memberToDelete) {
        console.log("✅ Member marked for deletion:", memberToDelete.name);
        membersToDelete.push(memberToDelete);
      } else {
        console.log("⚠️ Member not found for deletion:", nameToDelete);
        clarifications.push({
          message: `Не удалось найти члена семьи "${nameToDelete}" для удаления.`,
          requestedName: nameToDelete,
          target_scope: "unknown",
          operations: {
            add_allergies: [],
            add_dislikes: [],
            add_likes: [],
            remove_allergies: [],
            remove_dislikes: [],
            remove_likes: [],
          },
        });
      }
    }

    if (membersToDelete.length > 0) {
      console.log("🗑️ Found", membersToDelete.length, "members to delete");

      return {
        profile,
        familyMembers,
        newMembers: [],
        membersToDelete,
        updates,
        clarifications,
        budget: intent.budget ?? undefined,
        mentioned_salary: intent.mentioned_salary ?? undefined,
        goals: intent.goals ?? undefined,
      };
    }
  }

  // ✅ НОВОЕ: Проверка на обновление только имени primary_member
  if (
    Array.isArray(intent.family_members) &&
    intent.family_members.length === 1 &&
    familyData?.primary_member_id &&
    !isSelfReference(intent.family_members[0].name)
  ) {
    const member = intent.family_members[0];

    // Если указано ТОЛЬКО имя (без age и weight) → это обновление имени
    if (member.name && !member.age && !member.weight) {
      console.log(
        "✅ NAME UPDATE DETECTED for primary_member:",
        member.name
      );

      const primaryMember = familyMembers.find(
        (m) => m.id === familyData.primary_member_id
      );

      if (primaryMember) {
        updates.push({
          memberIds: [primaryMember.id],
          scope: "member",
          operations: {
            add_allergies: [],
            add_dislikes: [],
            add_likes: [],
            remove_allergies: [],
            remove_dislikes: [],
            remove_likes: [],
            age: null,
            weight: null,
          },
          requestedName: member.name,
          nameUpdate: member.name,
        } as any);

        return {
          profile,
          familyMembers,
          newMembers: [],
          membersToDelete: [],
          updates,
          clarifications,
          budget: intent.budget ?? undefined,
          mentioned_salary: intent.mentioned_salary ?? undefined,
          goals: intent.goals ?? undefined,
        };
      }
    }
  }

  // 1) сначала разбираем тех, кого модель прислала в family_members
  if (Array.isArray(intent.family_members) && intent.family_members.length > 0) {
    console.log(
      "✅ Processing",
      intent.family_members.length,
      "family_members from intent"
    );
    const unknownMembers: string[] = [];

    for (const fm of intent.family_members) {
      const norm = normaliseName(fm.name);
      console.log(
        "  📝 Processing member:",
        fm.name,
        "→ normalized:",
        norm,
        "age:",
        fm.age,
        "weight:",
        fm.weight
      );

      if (isSelfReference(fm.name)) {
        if (primaryMemberId) {
          updates.push({
            memberIds: [primaryMemberId],
            scope: "member",
            operations: {
              add_allergies: [],
              add_dislikes: [],
              add_likes: [],
              remove_allergies: [],
              remove_dislikes: [],
              remove_likes: [],
              age: fm.age ?? null,
              weight: fm.weight ?? null,
            },
            requestedName: fm.name,
          });
        } else {
          clarifications.push({
            message:
              "Вы указали данные о себе, но основной представитель семьи не выбран. Кто будет «я»?",
            requestedName: null,
            target_scope: "unknown",
            operations: {
              add_allergies: [],
              add_dislikes: [],
              add_likes: [],
              remove_allergies: [],
              remove_dislikes: [],
              remove_likes: [],
            },
          });
        }
        continue;
      }

      if (!memberIndex.has(norm)) {
        console.log("    ➕ UNKNOWN member, adding to list");
        unknownMembers.push(norm);
      } else {
        console.log("    ✓ Known member, updating");
        const existing = memberIndex.get(norm)!;
        updates.push({
          memberIds: [existing.id],
          scope: "member",
          operations: {
            add_allergies: [],
            add_dislikes: [],
            add_likes: [],
            remove_allergies: [],
            remove_dislikes: [],
            remove_likes: [],
            age: fm.age ?? null,
            weight: fm.weight ?? null,
          },
          requestedName: existing.name,
        });
      }
    }

    if (unknownMembers.length > 0) {
      console.log(
        "🎯 Found",
        unknownMembers.length,
        "unknown members, returning as newMembers"
      );
      const newMembersWithData = intent.family_members.filter((fm) => {
        const norm = normaliseName(fm.name);
        return unknownMembers.includes(norm);
      });

      console.log(
        "📦 Returning newMembers:",
        JSON.stringify(newMembersWithData, null, 2)
      );

      return {
        profile,
        familyMembers,
        newMembers: newMembersWithData as Partial<FamilyMemberRow>[],
        membersToDelete: [],
        updates,
        clarifications,
        budget: intent.budget ?? undefined,
        mentioned_salary: intent.mentioned_salary ?? undefined,
        goals: intent.goals ?? undefined,
      };
    }
  }

  // ✅ НОВОЕ: Конвертируем неизвестные имена из updates_per_person в family_members
  const existingFamilyNames = new Set(
    familyMembers.map((m) => normaliseName(m.name))
  );

  const newMembersFromUpdates: Partial<FamilyMemberRow>[] = [];
  const filteredUpdates: typeof intent.updates_per_person = [];

  for (const update of intent.updates_per_person) {
    const { isNewMember, familyMember } = convertUnknownNamesToFamilyMembers(
      update,
      existingFamilyNames
    );

    if (isNewMember && familyMember) {
      newMembersFromUpdates.push(familyMember);
      existingFamilyNames.add(normaliseName(familyMember.name!));
      console.log(
        "✅ Added new member from updates_per_person:",
        familyMember.name
      );
    } else {
      filteredUpdates.push(update);
    }
  }

  if (newMembersFromUpdates.length > 0) {
    console.log(
      "🎯 Found",
      newMembersFromUpdates.length,
      "new members in updates_per_person, converting to family_members"
    );

    return {
      profile,
      familyMembers,
      newMembers: newMembersFromUpdates,
      membersToDelete: [],
      updates: [],
      clarifications,
      budget: intent.budget ?? undefined,
      mentioned_salary: intent.mentioned_salary ?? undefined,
      goals: intent.goals ?? undefined,
    };
  }

  // 2) теперь обрабатываем ОСТАВШИЕСЯ updates_per_person
  for (const update of filteredUpdates) {
    if (isSelfReference(update.name)) {
      update.target_scope = "self";
    }

    const operations = {
      add_allergies: update.add_allergies,
      add_dislikes: update.add_dislikes,
      add_likes: update.add_likes,
      remove_allergies: update.remove_allergies,
      remove_dislikes: update.remove_dislikes,
      remove_likes: update.remove_likes,
      age: update.age ?? null,
      weight: update.weight ?? null,
    };

    const operationSummary = describeOperations(update);

    const clarificationBase: PendingClarification = {
      message:
        operationSummary || "Need additional details to apply this update.",
      requestedName: update.name,
      target_scope: update.target_scope,
      operations,
    };

    const mergedOps = {
      ...operations,
      age: update.age ?? operations.age ?? null,
      weight: update.weight ?? operations.weight ?? null,
    };

    if (update.target_scope === "self") {
      if (!primaryMemberId) {
        clarifications.push({
          ...clarificationBase,
          message:
            "Основной представитель семьи не установлен. Укажите, кто это.",
        });
        continue;
      }

      updates.push({
        memberIds: [primaryMemberId],
        scope: "member",
        operations: mergedOps,
        requestedName: update.name,
      });
      continue;
    }

    if (update.target_scope === "named") {
      const candidateNames = [
        update.name,
        ...(update.resolved_names ?? []),
      ].filter(Boolean) as string[];

      const matchedMember = candidateNames
        .map((name) => memberIndex.get(normaliseName(name)))
        .find((member): member is FamilyMemberRow => Boolean(member));

      if (!matchedMember) {
        clarifications.push({
          ...clarificationBase,
          message: `Не удалось найти члена семьи с именем "${candidateNames[0] ?? "?"}".`,
        });
        continue;
      }

      updates.push({
        memberIds: [matchedMember.id],
        scope: "member",
        operations: mergedOps,
        requestedName: matchedMember.name,
      });
      continue;
    }

    if (update.target_scope === "family" || update.applies_to_family) {
      updates.push({
        memberIds: familyMembers.map((m) => m.id),
        scope: "family",
        operations: mergedOps,
        requestedName: update.name,
      });
      continue;
    }

    clarifications.push({
      ...clarificationBase,
      message:
        operationSummary ||
        "Не удалось определить, к кому относится изменение. Поясните, пожалуйста.",
    });
  }

  // ✅ НОВОЕ: Обработка name update из updates_per_person
  for (const update of filteredUpdates) {
    // Если это self-update с ТОЛЬКО именем (без age/weight/аллергий/и т.д.)
    if (
      update.target_scope === "self" &&
      update.name &&
      !update.age &&
      !update.weight &&
      update.add_allergies?.length === 0 &&
      update.remove_allergies?.length === 0 &&
      update.add_likes?.length === 0 &&
      update.remove_likes?.length === 0 &&
      update.add_dislikes?.length === 0 &&
      update.remove_dislikes?.length === 0 &&
      primaryMemberId
    ) {
      console.log("✅ NAME UPDATE from updates_per_person:", update.name);

      const primaryMember = familyMembers.find((m) => m.id === primaryMemberId);

      if (primaryMember) {
        updates.push({
          memberIds: [primaryMemberId],
          scope: "member",
          operations: {
            add_allergies: [],
            add_dislikes: [],
            add_likes: [],
            remove_allergies: [],
            remove_dislikes: [],
            remove_likes: [],
            age: null,
            weight: null,
          },
          requestedName: update.name,
          nameUpdate: update.name,
        } as any);

        return {
          profile,
          familyMembers,
          newMembers: [],
          membersToDelete: [],
          updates,
          clarifications,
          budget: intent.budget ?? undefined,
          mentioned_salary: intent.mentioned_salary ?? undefined,
          goals: intent.goals ?? undefined,
        };
      }
    }
  }

  return {
    profile,
    familyMembers,
    newMembers: [],
    membersToDelete: [],
    updates,
    clarifications,
    budget: intent.budget ?? undefined,
    mentioned_salary: intent.mentioned_salary ?? undefined,
    goals: intent.goals ?? undefined,
  };
}

export type { ResolveEntitiesParams, ResolvedIntent };
