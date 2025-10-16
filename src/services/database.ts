// src\services\database.ts

import { getSupabaseServer } from "@/lib/supabase";

type Category = "like" | "dislike" | "allergy";

export class DatabaseService {
  async upsertDietFacts(profileId: number, facts: any): Promise<void> {
    const supabase = getSupabaseServer();
    const nowIso = new Date().toISOString();

    const upsertHousehold = async (category: Category, canonical: string, confidence: number) => {
      const { data } = await supabase
        .from("diet_facts")
        .select("id,confidence,evidence_count,status")
        .eq("profile_id", profileId)
        .eq("subject_scope", "household")
        .eq("category", category)
        .eq("canonical", canonical)
        .limit(1);
      const existing = (Array.isArray(data) && data.length > 0) ? data[0] : null;
      if (existing) {
        await supabase
          .from("diet_facts")
          .update({
            confidence: Math.max(Number(existing.confidence) || 0, confidence),
            evidence_count: Number(existing.evidence_count || 0) + 1,
            status: "confirmed",
            last_seen: nowIso,
          })
          .eq("id", existing.id);
      } else {
        await supabase.from("diet_facts").insert({
          profile_id: profileId,
          member_id: null,
          subject_scope: "household",
          category,
          item: canonical,
          canonical,
          confidence,
          evidence_count: 1,
          status: "unconfirmed",
          first_seen: nowIso,
          last_seen: nowIso,
        });
      }
    };

    const ensureMemberId = async (name: string | undefined): Promise<number | undefined> => {
      const n = (name || "").trim();
      if (!n) return undefined;
      const { data } = await supabase
        .from("family_members")
        .select("id,name")
        .eq("profile_id", profileId);
      const found = (data || []).find((m: any) => (m?.name || "").trim().toLowerCase() === n.toLowerCase());
      if (found) return Number(found.id);
      const { data: ins } = await supabase
        .from("family_members")
        .insert({ profile_id: profileId, name: n })
        .select("id")
        .limit(1);
      const created = (Array.isArray(ins) && ins.length > 0) ? ins[0] : null;
      return created ? Number(created.id) : undefined;
    };

    const upsertMember = async (memberId: number, category: Category, canonical: string, confidence: number) => {
      const { data } = await supabase
        .from("diet_facts")
        .select("id,confidence,evidence_count,status")
        .eq("profile_id", profileId)
        .eq("subject_scope", "member")
        .eq("member_id", memberId)
        .eq("category", category)
        .eq("canonical", canonical)
        .limit(1);
      const existing = (Array.isArray(data) && data.length > 0) ? data[0] : null;
      if (existing) {
        await supabase
          .from("diet_facts")
          .update({
            confidence: Math.max(Number(existing.confidence) || 0, confidence),
            evidence_count: Number(existing.evidence_count || 0) + 1,
            status: "confirmed",
            last_seen: nowIso,
          })
          .eq("id", existing.id);
      } else {
        await supabase.from("diet_facts").insert({
          profile_id: profileId,
          member_id: memberId,
          subject_scope: "member",
          category,
          item: canonical,
          canonical,
          confidence,
          evidence_count: 1,
          status: "unconfirmed",
          first_seen: nowIso,
          last_seen: nowIso,
        });
      }
    };

    // Household-level facts
    const hLikes: string[] = Array.isArray(facts?.householdLikes) ? facts.householdLikes : [];
    const hDislikes: string[] = Array.isArray(facts?.householdDislikes) ? facts.householdDislikes : [];
    const hAllergies: string[] = Array.isArray(facts?.householdAllergies) ? facts.householdAllergies : [];
    for (const it of hLikes) await upsertHousehold("like", it, 0.8);
    for (const it of hDislikes) await upsertHousehold("dislike", it, 0.8);
    for (const it of hAllergies) await upsertHousehold("allergy", it, 0.9);

    // Member-level facts
    const members: Array<{ name?: string; likes?: string[]; dislikes?: string[]; allergies?: string[] }>
      = Array.isArray(facts?.members) ? facts.members : [];
    for (const m of members) {
      const memberId = await ensureMemberId(m?.name);
      if (!memberId) continue;
      const likes = Array.isArray(m?.likes) ? m.likes : [];
      const dislikes = Array.isArray(m?.dislikes) ? m.dislikes : [];
      const allergies = Array.isArray(m?.allergies) ? m.allergies : [];
      for (const it of likes) await upsertMember(memberId, "like", it, 0.8);
      for (const it of dislikes) await upsertMember(memberId, "dislike", it, 0.8);
      for (const it of allergies) await upsertMember(memberId, "allergy", it, 0.9);
    }
  }

  async getAggregatedFacts(profileId: number): Promise<any> {
    const supabase = getSupabaseServer();
    const { data: facts } = await supabase
      .from("diet_facts")
      .select("member_id,subject_scope,category,canonical")
      .eq("profile_id", profileId);
    const household = { likes: [] as string[], dislikes: [] as string[], allergies: [] as string[] };
    const members: Record<number, { likes: string[]; dislikes: string[]; allergies: string[] }> = {};
    (facts || []).forEach((f: any) => {
      const canon = typeof f?.canonical === "string" ? f.canonical : "";
      if (!canon) return;
      if (f.subject_scope === "household") {
        if (f.category === "like") household.likes.push(canon);
        else if (f.category === "dislike") household.dislikes.push(canon);
        else if (f.category === "allergy") household.allergies.push(canon);
      } else if (f.subject_scope === "member" && typeof f.member_id === "number") {
        if (!members[f.member_id]) members[f.member_id] = { likes: [], dislikes: [], allergies: [] };
        if (f.category === "like") members[f.member_id].likes.push(canon);
        else if (f.category === "dislike") members[f.member_id].dislikes.push(canon);
        else if (f.category === "allergy") members[f.member_id].allergies.push(canon);
      }
    });
    return { household, members };
  }

  async upsertFamilyMembersDetails(
    profileId: number,
    members: Array<{ name?: string; age?: number; weight?: number; activity?: string; likes?: string[]; dislikes?: string[]; allergies?: string[] }>
  ): Promise<void> {
    const supabase = getSupabaseServer();

    const normName = (n?: string) => (n || "").trim().toLowerCase();

    const ensureMemberId = async (name: string | undefined): Promise<number | undefined> => {
      const n = normName(name);
      if (!n) return undefined;
      const { data } = await supabase
        .from("family_members")
        .select("id,name")
        .eq("profile_id", profileId);
      const found = (data || []).find((m: any) => normName(m?.name) === n);
      if (found) return Number(found.id);
      const { data: ins } = await supabase
        .from("family_members")
        .insert({ profile_id: profileId, name: n })
        .select("id")
        .limit(1);
      const created = (Array.isArray(ins) && ins.length > 0) ? ins[0] : null;
      return created ? Number(created.id) : undefined;
    };

    for (const m of (members || [])) {
      const memberId = await ensureMemberId(m?.name);
      if (!memberId) continue;
      const update: Record<string, any> = {};
      if (typeof m.age === "number") update.age = m.age;
      if (typeof m.weight === "number") update.weight = m.weight;
      if (typeof m.activity === "string") update.activity = m.activity;
      if (Array.isArray(m.likes)) update.likes = m.likes;
      if (Array.isArray(m.dislikes)) update.dislikes = m.dislikes;
      if (Array.isArray(m.allergies)) update.allergies = m.allergies;
      if (Object.keys(update).length === 0) continue;
      try {
        await supabase
          .from("family_members")
          .update(update)
          .eq("id", memberId)
          .eq("profile_id", profileId);
      } catch (e) {
        // мягко игнорируем ошибки, чтобы не ломать основной поток
        console.error("family_members update error", (e as any)?.message || e);
      }
    }
  }

  // Удаление аллергии у домохозяйства: чистим family_members и diet_facts
  async removeHouseholdAllergy(profileId: number, allergy: string): Promise<void> {
    const supabase = getSupabaseServer();
    const item = (allergy || "").trim();
    const itemLower = item.toLowerCase();
    if (!item) return;
    try {
      // Удаляем из всех членов семьи, если она там указана
      const { data: members } = await supabase
        .from("family_members")
        .select("id,allergies")
        .eq("profile_id", profileId);
      for (const m of (members || [])) {
        const arr = Array.isArray(m?.allergies) ? m!.allergies! : [];
        // Фуззи‑удаление: покрываем общие формулировки (например, "капуста") и варианты
        const filtered = arr.filter((x: string) => !String(x).toLowerCase().includes(itemLower));
        if (JSON.stringify(filtered) !== JSON.stringify(arr)) {
          await supabase
            .from("family_members")
            .update({ allergies: filtered })
            .eq("id", m.id)
            .eq("profile_id", profileId);
        }
      }
      // Удаляем из diet_facts household/allergy
      await supabase
        .from("diet_facts")
        .delete()
        .eq("profile_id", profileId)
        .eq("subject_scope", "household")
        .eq("category", "allergy")
        // Фуззи‑совпадение по канону: "%<item>%"
        .ilike("canonical", `%${itemLower}%`);
    } catch (e: any) {
      console.error("removeHouseholdAllergy error", e?.message || e);
    }
  }

  // Удаление аллергии у конкретного члена семьи
  async removeMemberAllergy(profileId: number, memberName: string, allergy: string): Promise<void> {
    const supabase = getSupabaseServer();
    const nameNorm = (memberName || "").trim().toLowerCase();
    const item = (allergy || "").trim();
    const itemLower = item.toLowerCase();
    if (!nameNorm || !item) return;
    try {
      const { data: members } = await supabase
        .from("family_members")
        .select("id,name,allergies")
        .eq("profile_id", profileId);
      const match = (members || []).find((m: any) => String(m?.name || "").trim().toLowerCase() === nameNorm);
      if (!match) return;
      const arr = Array.isArray(match?.allergies) ? match!.allergies! : [];
      // Фуззи‑удаление: удаляем все варианты, содержащие общий термин
      const filtered = arr.filter((x: string) => !String(x).toLowerCase().includes(itemLower));
      if (JSON.stringify(filtered) !== JSON.stringify(arr)) {
        await supabase
          .from("family_members")
          .update({ allergies: filtered })
          .eq("id", match.id)
          .eq("profile_id", profileId);
      }
      // Удаляем факты из diet_facts для этого участника
      await supabase
        .from("diet_facts")
        .delete()
        .eq("profile_id", profileId)
        .eq("member_id", match.id)
        .eq("subject_scope", "member")
        .eq("category", "allergy")
        .ilike("canonical", `%${itemLower}%`);
    } catch (e: any) {
      console.error("removeMemberAllergy error", e?.message || e);
    }
  }

  // Полная очистка аллергий у домохозяйства
  async clearHouseholdAllergies(profileId: number): Promise<void> {
    const supabase = getSupabaseServer();
    try {
      // Ставим пустой массив аллергий для всех членов семьи
      await supabase
        .from("family_members")
        .update({ allergies: [] })
        .eq("profile_id", profileId);
      // Удаляем все факты аллергий из diet_facts для профиля
      await supabase
        .from("diet_facts")
        .delete()
        .eq("profile_id", profileId)
        .eq("category", "allergy");
    } catch (e: any) {
      console.error("clearHouseholdAllergies error", e?.message || e);
    }
  }

  // Полная очистка аллергий у конкретного члена семьи
  async clearMemberAllergies(profileId: number, memberName: string): Promise<void> {
    const supabase = getSupabaseServer();
    const nameNorm = (memberName || "").trim().toLowerCase();
    if (!nameNorm) return;
    try {
      const { data: members } = await supabase
        .from("family_members")
        .select("id,name")
        .eq("profile_id", profileId);
      const match = (members || []).find((m: any) => String(m?.name || "").trim().toLowerCase() === nameNorm);
      if (!match) return;
      await supabase
        .from("family_members")
        .update({ allergies: [] })
        .eq("id", match.id)
        .eq("profile_id", profileId);
      await supabase
        .from("diet_facts")
        .delete()
        .eq("profile_id", profileId)
        .eq("member_id", match.id)
        .eq("subject_scope", "member")
        .eq("category", "allergy");
    } catch (e: any) {
      console.error("clearMemberAllergies error", e?.message || e);
    }
  }

  // Удаление «нелюбимого» продукта на уровне домохозяйства
  async removeHouseholdDislike(profileId: number, item: string): Promise<void> {
    const supabase = getSupabaseServer();
    const canon = (item || "").trim();
    const canonLower = canon.toLowerCase();
    if (!canon) return;
    try {
      // Удаляем из dislikes всех членов семьи при наличии
      const { data: members } = await supabase
        .from("family_members")
        .select("id,dislikes")
        .eq("profile_id", profileId);
      for (const m of (members || [])) {
        const arr = Array.isArray(m?.dislikes) ? m!.dislikes! : [];
        const filtered = arr.filter((x: string) => !String(x).toLowerCase().includes(canonLower));
        if (JSON.stringify(filtered) !== JSON.stringify(arr)) {
          await supabase
            .from("family_members")
            .update({ dislikes: filtered })
            .eq("id", m.id)
            .eq("profile_id", profileId);
        }
      }
      // Удаляем household‑факты "dislike" из diet_facts
      await supabase
        .from("diet_facts")
        .delete()
        .eq("profile_id", profileId)
        .eq("subject_scope", "household")
        .eq("category", "dislike")
        .ilike("canonical", `%${canonLower}%`);
    } catch (e: any) {
      console.error("removeHouseholdDislike error", e?.message || e);
    }
  }

  // Удаление «нелюбимого» продукта у конкретного члена семьи
  async removeMemberDislike(profileId: number, memberName: string, item: string): Promise<void> {
    const supabase = getSupabaseServer();
    const nameNorm = (memberName || "").trim().toLowerCase();
    const canon = (item || "").trim();
    const canonLower = canon.toLowerCase();
    if (!nameNorm || !canon) return;
    try {
      const { data: members } = await supabase
        .from("family_members")
        .select("id,name,dislikes")
        .eq("profile_id", profileId);
      const match = (members || []).find((m: any) => String(m?.name || "").trim().toLowerCase() === nameNorm);
      if (!match) return;
      const arr = Array.isArray(match?.dislikes) ? match!.dislikes! : [];
      const filtered = arr.filter((x: string) => !String(x).toLowerCase().includes(canonLower));
      if (JSON.stringify(filtered) !== JSON.stringify(arr)) {
        await supabase
          .from("family_members")
          .update({ dislikes: filtered })
          .eq("id", match.id)
          .eq("profile_id", profileId);
      }
      // Удаляем "dislike"‑факты участника из diet_facts
      await supabase
        .from("diet_facts")
        .delete()
        .eq("profile_id", profileId)
        .eq("member_id", match.id)
        .eq("subject_scope", "member")
        .eq("category", "dislike")
        .ilike("canonical", `%${canonLower}%`);
    } catch (e: any) {
      console.error("removeMemberDislike error", e?.message || e);
    }
  }
}