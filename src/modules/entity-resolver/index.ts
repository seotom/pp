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

  let ensuredProfile = profile;

  if (profileError && profileError.code !== "PGRST116") {
    throw profileError;
  }

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

    if (createError || !createdProfile) {
      throw createError ?? new Error("Failed to create user profile.");
    }

    ensuredProfile = createdProfile;
  }

  const { data: members, error: membersError } = await supabase
    .from("family_members")
    .select("*")
    .eq("profile_id", ensuredProfile.id);

  if (membersError) {
    throw membersError;
  }

  const familyData =
    (ensuredProfile.family_data as ClarificationState | null) ?? {};

  return {
    profile: ensuredProfile,
    familyMembers: members ?? [],
    familyData,
  };
}

function normaliseName(name: string): string {
  return name.trim().toLowerCase();
}

function describeOperations(operations: IntentUpdateOperation): string {
  const fragments: string[] = [];

  if (operations.add_allergies.length) {
    fragments.push(`add allergies: ${operations.add_allergies.join(", ")}`);
  }
  if (operations.remove_allergies.length) {
    fragments.push(
      `remove allergies: ${operations.remove_allergies.join(", ")}`,
    );
  }
  if (operations.add_likes.length) {
    fragments.push(`add likes: ${operations.add_likes.join(", ")}`);
  }
  if (operations.remove_likes.length) {
    fragments.push(`remove likes: ${operations.remove_likes.join(", ")}`);
  }
  if (operations.add_dislikes.length) {
    fragments.push(
      `add dislikes: ${operations.add_dislikes.join(", ")}`,
    );
  }
  if (operations.remove_dislikes.length) {
    fragments.push(
      `remove dislikes: ${operations.remove_dislikes.join(", ")}`,
    );
  }

  return fragments.join("; ");
}

export async function resolveEntities({
  userId,
  intent,
}: ResolveEntitiesParams): Promise<ResolvedIntent> {
  const { profile, familyMembers, familyData } =
    await loadProfileAndMembers(userId);

  const primaryMemberId =
    typeof familyData.primary_member_id === "number"
      ? familyData.primary_member_id
      : undefined;

  const memberIndex = new Map<string, FamilyMemberRow>();
  for (const member of familyMembers) {
    memberIndex.set(normaliseName(member.name), member);
  }

  const newMembers = intent.family_members.filter((member) => {
    return !memberIndex.has(normaliseName(member.name));
  });

  const updates: ResolvedIntent["updates"] = [];
  const clarifications: PendingClarification[] = [];

  for (const update of intent.updates_per_person) {
    const operations = {
      add_allergies: update.add_allergies,
      add_dislikes: update.add_dislikes,
      add_likes: update.add_likes,
      remove_allergies: update.remove_allergies,
      remove_dislikes: update.remove_dislikes,
      remove_likes: update.remove_likes,
    };

    const operationSummary = describeOperations(update);
    const clarificationBase: PendingClarification = {
      message: operationSummary || "Need additional details to apply this update.",
      requestedName: update.name,
      target_scope: update.target_scope,
      operations,
    };

    if (update.target_scope === "family" || update.applies_to_family) {
      if (!familyMembers.length) {
        clarifications.push({
          ...clarificationBase,
          message:
            "No family members are registered yet. Please add someone before applying a family-wide change.",
        });
        continue;
      }

      updates.push({
        memberIds: familyMembers.map((member) => member.id),
        scope: "family",
        operations,
        requestedName: update.name,
      });
      continue;
    }

    if (update.target_scope === "self") {
      if (!primaryMemberId) {
        clarifications.push({
          ...clarificationBase,
          message:
            "The primary family member is not set. Please specify who is represented by \"I\".",
        });
        continue;
      }
      updates.push({
        memberIds: [primaryMemberId],
        scope: "member",
        operations,
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
          message: `Could not find a family member named \"${
            candidateNames[0] ?? "?"
          }".`,
        });
        continue;
      }

      updates.push({
        memberIds: [matchedMember.id],
        scope: "member",
        operations,
        requestedName: matchedMember.name,
      });
      continue;
    }

    clarifications.push({
      ...clarificationBase,
      message:
        operationSummary ||
        "Unable to determine the target of the update. Please clarify who this applies to.",
    });
  }

  return {
    profile,
    familyMembers,
    newMembers,
    updates,
    clarifications,
    budget: intent.budget,
    goals: intent.goals,
  };
}

export type { ResolveEntitiesParams, ResolvedIntent };

