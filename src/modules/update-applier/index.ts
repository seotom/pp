// src/modules/update-applier/index.ts

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
  toAdd.forEach(item => set.add(canon(item)));
  toRemove.forEach(item => set.delete(canon(item)));
  return uniqueSorted(Array.from(set));
}

function summariseMember(name: string, summary: MemberSummary): string | null {
  const parts: string[] = [];
  if (summary.ageUpdated !== undefined && summary.ageUpdated !== null) parts.push(`обновлён возраст: ${summary.ageUpdated}`);
  if (summary.weightUpdated !== undefined && summary.weightUpdated !== null) parts.push(`обновлён вес: ${summary.weightUpdated} кг`);
  if (summary.nameUpdated) parts.push(`обновлено имя: ${summary.nameUpdated}`);
  if (summary.addedAllergies.length) parts.push(`добавлены аллергии: ${summary.addedAllergies.join(", ")}`);
  if (summary.removedAllergies.length) parts.push(`удалены аллергии: ${summary.removedAllergies.join(", ")}`);
  if (summary.addedLikes.length) parts.push(`добавлены любимые продукты: ${summary.addedLikes.join(", ")}`);
  if (summary.removedLikes.length) parts.push(`удалены любимые продукты: ${summary.removedLikes.join(", ")}`);
  if (summary.addedDislikes.length) parts.push(`добавлены нелюбимые продукты: ${summary.addedDislikes.join(", ")}`);
  if (summary.removedDislikes.length) parts.push(`удалены нелюбимые продукты: ${summary.removedDislikes.join(", ")}`);
  if (!parts.length) return null;
  return `${name}: ${parts.join("; ")}`;
}

function arraysEqual(a: string[] | null, b: string[] | null): boolean {
  const aList = uniqueSorted((a ?? []).map(canon));
  const bList = uniqueSorted((b ?? []).map(canon));
  if (aList.length !== bList.length) return false;
  return aList.every((value, index) => value === bList[index]);
}

export async function applyUpdates({
  intent,
}: ApplyUpdatesParams): Promise<string> {
  const supabase = getSupabaseServiceRoleClient();
  const summaryLines: string[] = [];

  // 1. Удаление членов семьи
  if (intent.membersToDelete && intent.membersToDelete.length > 0) {
    const memberIdsToDelete = intent.membersToDelete.map((m) => m.id);
    const { error } = await supabase.from("family_members").delete().in("id", memberIdsToDelete);
    if (error) {
      console.error("❌ Ошибка при удалении членов семьи:", error);
    } else {
      summaryLines.push(`✅ Удалены члены семьи: ${intent.membersToDelete.map((m) => m.name).join(", ")}.`);
    }
  }

  // 2. Создание новых членов семьи
  if (intent.newMembers && intent.newMembers.length > 0) {
    const validNewMembers = intent.newMembers.filter(m => m.name && typeof m.name === "string");
    if (validNewMembers.length > 0) {
      const newMembersToInsert = validNewMembers.map((m) => ({
        profile_id: intent.profile.id,
        name: m.name!,
        age: m.age ?? null,
        weight: m.weight ?? null,
        likes: m.likes ?? [],
        dislikes: m.dislikes ?? [],
        allergies: m.allergies ?? [],
      }));
      const { error } = await supabase.from("family_members").insert(newMembersToInsert);
      if (error) {
        console.error("❌ Ошибка при создании новых членов семьи:", error);
      } else {
        summaryLines.push(`✅ Добавлены новые члены семьи: ${newMembersToInsert.map((m) => m.name).join(", ")}.`);
      }
    }
  }

  // 3. Обновление данных существующих членов семьи
  if (intent.updates && intent.updates.length > 0) {
    const memberIdsToUpdate = Array.from(new Set(intent.updates.flatMap(u => u.memberIds)));
    const memberMap = new Map<number, FamilyMemberRow>();

    if (memberIdsToUpdate.length > 0) {
        const { data: members, error } = await supabase
            .from("family_members")
            .select("*")
            .in("id", memberIdsToUpdate)
            .returns<FamilyMemberRow[]>();

        if (error) {
            console.error("❌ Ошибка при загрузке членов семьи для обновления:", error);
        } else {
            (members || []).forEach(member => memberMap.set(member.id, member));
        }
    }

    const memberStates = new Map<number, { before: FamilyMemberRow; after: FamilyMemberRow; summary: MemberSummary }>();

    const ensureMemberState = (memberId: number) => {
        if (memberStates.has(memberId)) return memberStates.get(memberId);
        const base = memberMap.get(memberId);
        if (!base) {
            console.warn(`⚠️ Не удалось найти состояние для memberId: ${memberId}`);
            return null;
        }
        const state = {
            before: base,
            after: { ...base },
            summary: { addedAllergies: [], removedAllergies: [], addedLikes: [], removedLikes: [], addedDislikes: [], removedDislikes: [] },
        };
        memberStates.set(memberId, state);
        return state;
    };

    for (const update of intent.updates) {
        for (const memberId of update.memberIds) {
            const state = ensureMemberState(memberId);
            if (!state) continue;

            const { after } = state;
            if ((update as any).nameUpdate) after.name = (update as any).nameUpdate;

            // 1. Применяем базовые операции
            const nextLikes = applyListOps(after.likes, update.operations.add_likes, update.operations.remove_likes);
            const nextDislikes = applyListOps(after.dislikes, update.operations.add_dislikes, update.operations.remove_dislikes);

            // 2. Обеспечиваем взаимоисключаемость
            // Если что-то добавили в likes, удаляем это из dislikes
            update.operations.add_likes.forEach(item => {
                const canonItem = canon(item);
                const index = nextDislikes.indexOf(canonItem);
                if (index > -1) {
                    nextDislikes.splice(index, 1);
                }
            });
            
            // Если что-то добавили в dislikes, удаляем это из likes
            update.operations.add_dislikes.forEach(item => {
                const canonItem = canon(item);
                const index = nextLikes.indexOf(canonItem);
                if (index > -1) {
                    nextLikes.splice(index, 1);
                }
            });
            
            after.likes = nextLikes;
            after.dislikes = nextDislikes;
            
            // Аллергии остаются без изменений в этой логике
            after.allergies = applyListOps(after.allergies, update.operations.add_allergies, update.operations.remove_allergies);
            
            if (update.operations.age !== undefined && update.operations.age !== null) after.age = update.operations.age;
            if (update.operations.weight !== undefined && update.operations.weight !== null) after.weight = update.operations.weight;
        }
    }

    for (const [memberId, state] of memberStates.entries()) {
        const { before, after } = state;
        const changed = !arraysEqual(before.allergies, after.allergies) || !arraysEqual(before.likes, after.likes) || !arraysEqual(before.dislikes, after.dislikes) || before.age !== after.age || before.weight !== after.weight || before.name !== after.name;

        if (changed) {
            const { error } = await supabase.from("family_members").update({ ...after }).eq("id", memberId);
            if (error) {
                console.error(`❌ Ошибка при обновлении memberId ${memberId}:`, error);
            } else {
                const summary: MemberSummary = {
                    ageUpdated: before.age !== after.age ? after.age : undefined,
                    weightUpdated: before.weight !== after.weight ? after.weight : undefined,
                    nameUpdated: before.name !== after.name ? after.name : undefined,
                    addedAllergies: (after.allergies ?? []).filter(item => !(before.allergies ?? []).map(canon).includes(canon(item))),
                    removedAllergies: (before.allergies ?? []).filter(item => !(after.allergies ?? []).map(canon).includes(canon(item))),
                    addedLikes: (after.likes ?? []).filter(item => !(before.likes ?? []).map(canon).includes(canon(item))),
                    removedLikes: (before.likes ?? []).filter(item => !(after.likes ?? []).map(canon).includes(canon(item))),
                    addedDislikes: (after.dislikes ?? []).filter(item => !(before.dislikes ?? []).map(canon).includes(canon(item))),
                    removedDislikes: (before.dislikes ?? []).filter(item => !(after.dislikes ?? []).map(canon).includes(canon(item))),
                };
                const line = summariseMember(after.name, summary);
                if (line) summaryLines.push(line);
            }
        }
    }
  }


  // 4. Обновление профиля (бюджет, цели)
  const profileUpdates: Partial<ProfileRow> = {};
  if (intent.budget !== undefined && intent.budget !== null) {
      profileUpdates.budget = intent.budget;
  }
  if (intent.goals !== undefined && intent.goals !== null) {
      profileUpdates.goals = intent.goals.length > 0 ? intent.goals.join(", ") : null;
  }
  
  if (Object.keys(profileUpdates).length > 0) {
      const { error } = await supabase.from("profiles").update(profileUpdates).eq("id", intent.profile.id);
      if (error) {
          console.error("❌ Ошибка при обновлении профиля:", error);
      } else {
          if (profileUpdates.budget !== undefined) summaryLines.push(profileUpdates.budget === null ? "Семейный бюджет очищен." : `Обновлён семейный бюджет: ${profileUpdates.budget} ₽.`);
          if (profileUpdates.goals !== undefined) summaryLines.push(profileUpdates.goals && profileUpdates.goals.length ? `Обновлены цели: ${profileUpdates.goals}.` : "Цели очищены.");
      }
  }

  if (summaryLines.length === 0) {
    return "Я всё понял, но, кажется, никаких изменений не потребовалось.";
  }

  return summaryLines.join("\n");
}

export type { ApplyUpdatesParams };