// src\modules\step-controller\index.ts

import { getSupabaseServiceRoleClient } from "@/lib/supabase";
import type { ProfileRow, FamilyMemberRow } from "@/types/database";

export type StepProgress = {
  family: boolean;
  primaryMember: boolean;
  budget: boolean;
  likes: boolean;
  allergies: boolean;
  goals: boolean;
};

type StepCheckResult = {
  nextStep:
    | "family"
    | "primary_member"
    | "budget"
    | "likes"
    | "allergies"
    | "goals"
    | "complete";
  profile: ProfileRow;
  members: FamilyMemberRow[];
};

export async function checkStepProgress(
  userId: string
): Promise<StepCheckResult> {
  const supabase = getSupabaseServiceRoleClient();

  // 1. грузим профиль
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (profileError || !profile) {
    throw new Error("Профиль не найден");
  }

  // ✅ Приведение типа для профиля
  const typedProfile = profile as ProfileRow;

  // 2. грузим членов семьи
  const { data: members, error: membersError } = await supabase
    .from("family_members")
    .select("*")
    .eq("profile_id", typedProfile.id);

  if (membersError) {
    throw membersError;
  }

  // ✅ Приведение типа и гарантируем, что это массив
  const typedMembers = (members ?? []) as FamilyMemberRow[];

  // 3. приводим family_data к нормальному виду
  const raw = (typedProfile.family_data as any) ?? {};
  const progress: StepProgress = {
    family: raw.progress?.family ?? false,
    primaryMember: raw.progress?.primaryMember ?? false,
    budget: raw.progress?.budget ?? false,
    likes: raw.progress?.likes ?? false,
    allergies: raw.progress?.allergies ?? false,
    goals: raw.progress?.goals ?? false,
  };

  // 4. логика шагов

  // шаг 1 — состав семьи
  if (!progress.family || typedMembers.length === 0) {
    return { nextStep: "family", profile: typedProfile, members: typedMembers };
  }

  // шаг 2 — выбор первичного лица
  const primaryMemberId =
    typeof raw.primary_member_id === "number"
      ? raw.primary_member_id
      : undefined;

  if (!progress.primaryMember || !primaryMemberId) {
    return {
      nextStep: "primary_member",
      profile: typedProfile,
      members: typedMembers,
    };
  }

  // шаг 3 — бюджет
  if (!progress.budget || !typedProfile.budget) {
    return { nextStep: "budget", profile: typedProfile, members: typedMembers };
  }

  // шаг 4 — предпочтения
  if (!progress.likes) {
    return { nextStep: "likes", profile: typedProfile, members: typedMembers };
  }

  // шаг 5 — аллергии
  if (!progress.allergies) {
    return {
      nextStep: "allergies",
      profile: typedProfile,
      members: typedMembers,
    };
  }

  // шаг 6 — цели
  if (!progress.goals || !typedProfile.goals) {
    return { nextStep: "goals", profile: typedProfile, members: typedMembers };
  }

  // всё собрано
  return {
    nextStep: "complete",
    profile: typedProfile,
    members: typedMembers,
  };
}

// ✅ отмечаем, что состав семьи собран
export async function markFamilyStepComplete(profileId: number) {
  const supabase = getSupabaseServiceRoleClient();
  const { error } = await (supabase.rpc as any)("update_family_progress", {
    p_profile_id: profileId,
  });
  if (error) {
    console.error("Failed to mark family step:", error);
    throw error;
  }
}

// ✅ отмечаем, кто первичный член семьи
export async function markPrimaryMemberStepComplete(
  profileId: number,
  memberId: number
) {
  const supabase = getSupabaseServiceRoleClient();
  const { error } = await (supabase.rpc as any)("update_primary_member", {
    p_profile_id: profileId,
    p_member_id: memberId,
  });
  if (error) {
    console.error("Failed to mark primary member step:", error);
    throw error;
  }
}

// ✅ отметить завершение шага "бюджет"
export async function markBudgetStepComplete(
  profileId: number,
  budget: number
) {
  const supabase = getSupabaseServiceRoleClient();
  const { error } = await (supabase.rpc as any)("update_budget_progress", {
    p_profile_id: profileId,
    p_budget: budget,
  });
  if (error) {
    console.error("Failed to update budget:", error);
    throw error;
  }
}
