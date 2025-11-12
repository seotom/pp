// src\modules\update-applier\index.ts

import { getSupabaseServiceRoleClient } from "@/lib/supabase";
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
  ageUpdated?: number | null;
  weightUpdated?: number | null;
  nameUpdated?: string;
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
  toRemove: string[]
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

  if (summary.ageUpdated !== undefined) {
    parts.push(`обновлён возраст: ${summary.ageUpdated}`);
  }
  if (summary.weightUpdated !== undefined) {
    parts.push(`обновлён вес: ${summary.weightUpdated} кг`);
  }
  if (summary.nameUpdated) {
    parts.push(`обновлено имя: ${summary.nameUpdated}`);
  }

  if (summary.addedAllergies.length) {
    parts.push(`добавлены аллергии: ${summary.addedAllergies.join(", ")}`);
  }
  if (summary.removedAllergies.length) {
    parts.push(`удалены аллергии: ${summary.removedAllergies.join(", ")}`);
  }
  if (summary.addedLikes.length) {
    parts.push(`добавлены любимые: ${summary.addedLikes.join(", ")}`);
  }
  if (summary.removedLikes.length) {
    parts.push(`удалены любимые: ${summary.removedLikes.join(", ")}`);
  }
  if (summary.addedDislikes.length) {
    parts.push(`добавлены нелюбимые: ${summary.addedDislikes.join(", ")}`);
  }
  if (summary.removedDislikes.length) {
    parts.push(`удалены нелюбимые: ${summary.removedDislikes.join(", ")}`);
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

  // ✅ НОВОЕ: Удаляем членов семьи, если нужно
  if (intent.membersToDelete && intent.membersToDelete.length > 0) {
    const memberIdsToDelete = intent.membersToDelete.map((m) => m.id);

    const { error: deleteError } = await supabase
      .from("family_members")
      .delete()
      .in("id", memberIdsToDelete);

    if (deleteError) {
      console.error("❌ Ошибка при удалении членов семьи:", deleteError);
    } else {
      const memberNames = intent.membersToDelete.map((m) => m.name).join(", ");
      summaryLines.push(`✅ Удалены члены семьи: ${memberNames}.`);
    }
  }

  // ✅ НОВОЕ: Создаём новых членов семьи, если они есть
  if (intent.newMembers && intent.newMembers.length > 0) {
    // ✅ Фильтруем только членов с именем
    const validNewMembers = intent.newMembers.filter(
      (member) => member.name && typeof member.name === "string"
    );

    if (validNewMembers.length > 0) {
      const newMembersToInsert = validNewMembers.map((member) => ({
        profile_id: intent.profile.id,
        name: member.name!,  // ✅ Гарантированно string
        age: member.age ?? null,
        weight: member.weight ?? null,
        likes: member.likes ?? [],
        dislikes: member.dislikes ?? [],
        allergies: member.allergies ?? [],
      }));

      const { error: insertError } = await supabase
        .from("family_members")
        .insert(newMembersToInsert);

      if (insertError) {
        console.error("❌ Ошибка при создании новых членов семьи:", insertError);
      } else {
        const memberNames = newMembersToInsert.map((m) => m.name).join(", ");
        summaryLines.push(`✅ Добавлены новые члены семьи: ${memberNames}.`);
      }
    }
  }

  const profileUpdates: Partial<ProfileRow> = {};

  if (intent.budget !== undefined && intent.budget !== null) {
    console.log("💾 Updating budget:", intent.budget);
    profileUpdates.budget = intent.budget;
  } else if (intent.budget === null && intent.profile.budget !== null) {
    console.log("🛡️ PROTECTED: Not clearing budget (intent.budget is null)");
  }

  if (intent.goals !== undefined && intent.goals !== null) {
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
          ? "Семейный бюджет очищен."
          : `Обновлён семейный бюджет: ${profileUpdates.budget} ₽.`
      );
    }

    if (profileUpdates.goals !== undefined) {
      summaryLines.push(
        profileUpdates.goals && profileUpdates.goals.length
          ? `Обновлены цели: ${profileUpdates.goals}.`
          : "Цели очищены."
      );
    }
  }

  const memberMap = new Map<number, FamilyMemberRow>();

  if (
    intent.profile.family_data &&
    (intent.profile.family_data as any).primary_member_id
  ) {
    const primaryId = (intent.profile.family_data as any).primary_member_id;

    const { data: primaryMember } = await supabase
      .from("family_members")
      .select("*")
      .eq("id", primaryId)
      .maybeSingle() as unknown as {
        data: FamilyMemberRow | null;
        error: any;
      };

    if (primaryMember) {
      memberMap.set(primaryId, primaryMember);
    }
  }

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

  if (
    intent.familyMembers &&
    intent.familyMembers.length > 0 &&
    intent.profile.family_data &&
    (intent.profile.family_data as any).primary_member_id
  ) {
    const primaryId = (intent.profile.family_data as any).primary_member_id;

    const directMember = intent.familyMembers.find(
      (m) =>
        ["я", "мне", "меня", "мой", "моя", "мои", "пользователь"].includes(
          m.name.trim().toLowerCase()
        )
    );

    if (directMember) {
      const updates = {
        age: directMember.age ?? null,
        weight: directMember.weight ?? null,
      };

      const { error } = await supabase
        .from("family_members")
        .update(updates)
        .eq("id", primaryId);

      if (error) {
        console.error("Ошибка при прямом обновлении primary_member:", error);
      } else {
        if (updates.age !== null)
          summaryLines.push(`Обновлён возраст: ${updates.age} лет.`);
        if (updates.weight !== null)
          summaryLines.push(`Обновлён вес: ${updates.weight} кг.`);
      }
    }
  }

  for (const update of intent.updates) {
    for (const memberId of update.memberIds) {
      const state = ensureMemberState(memberId);
      if (!state) {
        continue;
      }

      const { after, summary } = state;

      // ✅ НОВОЕ: Обновляем имя, если оно указано в nameUpdate
      if ((update as any).nameUpdate) {
        after.name = (update as any).nameUpdate;
        summary.nameUpdated = (update as any).nameUpdate;
        console.log("📝 Updated name to:", after.name);
      }

      const currentAllergies = applyListOps(after.allergies ?? [], [], []);
      const currentLikes = applyListOps(after.likes ?? [], [], []);
      const currentDislikes = applyListOps(after.dislikes ?? [], [], []);

      const nextAllergies = applyListOps(
        currentAllergies,
        update.operations.add_allergies,
        update.operations.remove_allergies
      );
      const nextLikes = applyListOps(
        currentLikes,
        update.operations.add_likes,
        update.operations.remove_likes
      );
      const nextDislikes = applyListOps(
        currentDislikes,
        update.operations.add_dislikes,
        update.operations.remove_dislikes
      );

      const addedAllergies = nextAllergies.filter(
        (item) => !currentAllergies.includes(item)
      );
      const removedAllergies = currentAllergies.filter(
        (item) => !nextAllergies.includes(item)
      );
      const addedLikes = nextLikes.filter(
        (item) => !currentLikes.includes(item)
      );
      const removedLikes = currentLikes.filter(
        (item) => !nextLikes.includes(item)
      );
      const addedDislikes = nextDislikes.filter(
        (item) => !currentDislikes.includes(item)
      );
      const removedDislikes = currentDislikes.filter(
        (item) => !nextDislikes.includes(item)
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

      if (
        update.operations.age !== undefined &&
        update.operations.age !== null
      ) {
        after.age = update.operations.age;
        summary.ageUpdated = update.operations.age;
      }
      if (
        update.operations.weight !== undefined &&
        update.operations.weight !== null
      ) {
        after.weight = update.operations.weight;
        summary.weightUpdated = update.operations.weight;
      }
    }
  }

  const memberUpdates: {
    id: number;
    profile_id: number;
    name: string;
    allergies: string[];
    likes: string[];
    dislikes: string[];
    age: number | null;
    weight: number | null;
  }[] = [];

  for (const [memberId, state] of memberStates.entries()) {
    const changedAllergies = !arraysEqual(
      state.before.allergies,
      state.after.allergies
    );
    const changedLikes = !arraysEqual(state.before.likes, state.after.likes);
    const changedDislikes = !arraysEqual(
      state.before.dislikes,
      state.after.dislikes
    );
    const changedAge = state.before.age !== state.after.age;
    const changedWeight = state.before.weight !== state.after.weight;
    const changedName = state.before.name !== state.after.name;

    if (
      !changedAllergies &&
      !changedLikes &&
      !changedDislikes &&
      !changedAge &&
      !changedWeight &&
      !changedName
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
      age: state.after.age ?? null,
      weight: state.after.weight ?? null,
    });

    const line = summariseMember(state.after.name, {
      addedAllergies: uniqueSorted(state.summary.addedAllergies),
      removedAllergies: uniqueSorted(state.summary.removedAllergies),
      addedLikes: uniqueSorted(state.summary.addedLikes),
      removedLikes: uniqueSorted(state.summary.removedLikes),
      addedDislikes: uniqueSorted(state.summary.addedDislikes),
      removedDislikes: uniqueSorted(state.summary.removedDislikes),
      ageUpdated: state.summary.ageUpdated,
      weightUpdated: state.summary.weightUpdated,
      nameUpdated: state.summary.nameUpdated,
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

  if (summaryLines.length === 0) {
    summaryLines.push("Изменений не обнаружено.");
  }

  return summaryLines.join("\n");
}

export type { ApplyUpdatesParams };
