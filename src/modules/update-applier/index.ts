import { getSupabaseServiceRoleClient } from "@/lib/supabase";
import { markFamilyStepComplete } from "@/modules/step-controller";
import type { ResolvedIntent } from "@/modules/parser/types";
import type { FamilyMemberRow, ProfileRow } from "@/types/database";

type ApplyUpdatesParams = {
  intent: ResolvedIntent;
};

type MemberSummary = {
  addedAllergies: string[];
  removedAllergies: string[];
  addedLikes: string[];
  removedLikes: string[];
  addedDislikes: string[];
  removedDislikes: string[];
};

function canon(value: string): string {
  return value.trim().toLowerCase();
}

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(Array.from(values))).sort();
}

function applyListOps(
  current: string[] | null,
  toAdd: string[],
  toRemove: string[],
): string[] {
  const set = new Set((current ?? []).map(canon));

  for (const item of toAdd) {
    set.add(canon(item));
  }

  for (const item of toRemove) {
    set.delete(canon(item));
  }

  return uniqueSorted(Array.from(set));
}

function summariseMember(name: string, summary: MemberSummary): string | null {
  const parts: string[] = [];

  if (summary.addedAllergies.length) {
    parts.push(`added allergies: ${summary.addedAllergies.join(", ")}`);
  }
  if (summary.removedAllergies.length) {
    parts.push(`removed allergies: ${summary.removedAllergies.join(", ")}`);
  }
  if (summary.addedLikes.length) {
    parts.push(`added likes: ${summary.addedLikes.join(", ")}`);
  }
  if (summary.removedLikes.length) {
    parts.push(`removed likes: ${summary.removedLikes.join(", ")}`);
  }
  if (summary.addedDislikes.length) {
    parts.push(`added dislikes: ${summary.addedDislikes.join(", ")}`);
  }
  if (summary.removedDislikes.length) {
    parts.push(`removed dislikes: ${summary.removedDislikes.join(", ")}`);
  }

  if (!parts.length) {
    return null;
  }

  return `${name}: ${parts.join("; ")}`;
}

function arraysEqual(a: string[] | null, b: string[] | null): boolean {
  const aList = (a ?? []).map(canon);
  const bList = (b ?? []).map(canon);

  if (aList.length !== bList.length) {
    return false;
  }

  return aList.every((value, index) => value === bList[index]);
}

export async function applyUpdates({
  intent,
}: ApplyUpdatesParams): Promise<string> {
  const supabase = getSupabaseServiceRoleClient();

  const summaryLines: string[] = [];

  const profileUpdates: Partial<ProfileRow> = {};

  if (intent.budget !== undefined) {
    profileUpdates.budget = intent.budget;
  }

  if (intent.goals !== undefined) {
    profileUpdates.goals =
      intent.goals.length > 0 ? intent.goals.join(", ") : null;
  }

  if (Object.keys(profileUpdates).length > 0) {
    const { data: updatedProfile, error } = await supabase
      .from("profiles")
      .update(profileUpdates)
      .eq("id", intent.profile.id)
      .select()
      .single();

    if (error || !updatedProfile) {
      throw error ?? new Error("Failed to update user profile.");
    }

    if (profileUpdates.budget !== undefined) {
      summaryLines.push(
        profileUpdates.budget === null
          ? "Family budget cleared."
          : `Updated family budget: ${profileUpdates.budget}.`,
      );
    }

    if (intent.goals !== undefined) {
      summaryLines.push(
        intent.goals.length
          ? `Updated goals: ${intent.goals.join(", ")}.`
          : "Goals cleared.",
      );
    }
  }

  const memberMap = new Map<number, FamilyMemberRow>();
  for (const member of intent.familyMembers) {
    memberMap.set(member.id, member);
  }

  const memberStates = new Map<
    number,
    {
      before: FamilyMemberRow;
      after: FamilyMemberRow;
      summary: MemberSummary;
    }
  >();

  const ensureMemberState = (memberId: number) => {
    let state = memberStates.get(memberId);
    if (state) {
      return state;
    }

    const base = memberMap.get(memberId);
    if (!base) {
      return null;
    }

    state = {
      before: base,
      after: { ...base },
      summary: {
        addedAllergies: [],
        removedAllergies: [],
        addedLikes: [],
        removedLikes: [],
        addedDislikes: [],
        removedDislikes: [],
      },
    };

    memberStates.set(memberId, state);
    return state;
  };

  for (const update of intent.updates) {
    for (const memberId of update.memberIds) {
      const state = ensureMemberState(memberId);
      if (!state) {
        continue;
      }

      const { after, summary } = state;

      const currentAllergies = applyListOps(after.allergies ?? [], [], []);
      const currentLikes = applyListOps(after.likes ?? [], [], []);
      const currentDislikes = applyListOps(after.dislikes ?? [], [], []);

      const nextAllergies = applyListOps(
        currentAllergies,
        update.operations.add_allergies,
        update.operations.remove_allergies,
      );
      const nextLikes = applyListOps(
        currentLikes,
        update.operations.add_likes,
        update.operations.remove_likes,
      );
      const nextDislikes = applyListOps(
        currentDislikes,
        update.operations.add_dislikes,
        update.operations.remove_dislikes,
      );

      const addedAllergies = nextAllergies.filter(
        (item) => !currentAllergies.includes(item),
      );
      const removedAllergies = currentAllergies.filter(
        (item) => !nextAllergies.includes(item),
      );
      const addedLikes = nextLikes.filter(
        (item) => !currentLikes.includes(item),
      );
      const removedLikes = currentLikes.filter(
        (item) => !nextLikes.includes(item),
      );
      const addedDislikes = nextDislikes.filter(
        (item) => !currentDislikes.includes(item),
      );
      const removedDislikes = currentDislikes.filter(
        (item) => !nextDislikes.includes(item),
      );

      summary.addedAllergies.push(...addedAllergies);
      summary.removedAllergies.push(...removedAllergies);
      summary.addedLikes.push(...addedLikes);
      summary.removedLikes.push(...removedLikes);
      summary.addedDislikes.push(...addedDislikes);
      summary.removedDislikes.push(...removedDislikes);

      after.allergies = nextAllergies;
      after.likes = nextLikes;
      after.dislikes = nextDislikes;
    }
  }

  const memberUpdates: {
    id: number;
    profile_id: number;
    name: string;
    allergies: string[];
    likes: string[];
    dislikes: string[];
  }[] = [];

  for (const [memberId, state] of memberStates.entries()) {
    if (
      arraysEqual(state.before.allergies, state.after.allergies) &&
      arraysEqual(state.before.likes, state.after.likes) &&
      arraysEqual(state.before.dislikes, state.after.dislikes)
    ) {
      continue;
    }

    memberUpdates.push({
      id: memberId,
      profile_id: state.after.profile_id,
      name: state.after.name,
      allergies: state.after.allergies ?? [],
      likes: state.after.likes ?? [],
      dislikes: state.after.dislikes ?? [],
    });

    const line = summariseMember(state.after.name, {
      addedAllergies: uniqueSorted(state.summary.addedAllergies),
      removedAllergies: uniqueSorted(state.summary.removedAllergies),
      addedLikes: uniqueSorted(state.summary.addedLikes),
      removedLikes: uniqueSorted(state.summary.removedLikes),
      addedDislikes: uniqueSorted(state.summary.addedDislikes),
      removedDislikes: uniqueSorted(state.summary.removedDislikes),
    });

    if (line) {
      summaryLines.push(line);
    }
  }

  if (memberUpdates.length > 0) {
    const { error: memberUpdateError } = await supabase
      .from("family_members")
      .upsert(memberUpdates, { onConflict: "id" });

    if (memberUpdateError) {
      throw memberUpdateError;
    }
  }

  let insertedMembers: FamilyMemberRow[] = [];
  if (intent.newMembers.length > 0) {
    const insertPayload = intent.newMembers.map((member) => ({
      profile_id: intent.profile.id,
      name: member.name,
      age: member.age ?? null,
      weight: member.weight ?? null,
      likes: member.likes ?? [],
      dislikes: member.dislikes ?? [],
      allergies: member.allergies ?? [],
    }));

    const { data, error } = await supabase
      .from("family_members")
      .insert(insertPayload)
      .select();

    if (error || !data) {
      throw error ?? new Error("Failed to add new family members.");
    }

    insertedMembers = data;
    summaryLines.push(
      `Добавляем новых членов семьи: ${insertedMembers
        .map((member) => member.name)
        .join(", ")}.`,
    );

    // 🔹 Отмечаем шаг "семья" как завершённый
    await markFamilyStepComplete(intent.profile.id);
  }

  if (summaryLines.length === 0) {
    summaryLines.push("No changes detected.");
  }

  return summaryLines.join("\n");
}

export type { ApplyUpdatesParams };
