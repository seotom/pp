// src/services/database.service.ts
import { getSupabaseServer } from "@/lib/supabase";
import { SupabaseProfile, SupabaseFamilyMember, UserData } from "@/types/chat.types";
import { CanonicalizationService } from "./canonicalization";

export class DatabaseService {
  private supabase = getSupabaseServer();
  private canonicalizationService = new CanonicalizationService();

  async getUserData(user_id: string): Promise<UserData | null> {
    const { data: profile, error: profileError } = await this.supabase
      .from("profiles")
      .select("id, budget, goals, family_data")
      .eq("user_id", user_id)
      .single();

    if (profileError || !profile) {
      console.error("❌ Не удалось найти профиль пользователя:", profileError);
      return null;
    }

    const { data: familyMembers, error: familyError } = await this.supabase
      .from("family_members")
      .select("name, age, weight, allergies, dislikes, likes")
      .eq("profile_id", profile.id);

    if (familyError) {
      console.error("❌ Ошибка получения family_members:", familyError);
    }

    return {
      profile: profile as SupabaseProfile,
      family: (familyMembers as SupabaseFamilyMember[]) || [],
    };
  }

  async updateProfile(profileId: number, updates: any): Promise<void> {
    const { error } = await this.supabase
      .from("profiles")
      .update(updates)
      .eq("id", profileId);
    
    if (error) throw error;
  }

  async upsertFamilyMember(profileId: number, memberData: any): Promise<any> {
    const { data, error } = await this.supabase
      .from("family_members")
      .upsert({
        profile_id: profileId,
        ...memberData
      })
      .select()
      .single();
    
    if (error) throw error;
    return data;
  }

  async saveToDietFacts(profileId: number, memberId: number, member: any): Promise<void> {
    // Отключить AI для надежности при сохранении в БД
    this.canonicalizationService.disableAI();
    
    const now = new Date().toISOString();
    
    // 🔄 ИНТЕГРАЦИЯ CANONICALIZATION SERVICE - НОРМАЛИЗАЦИЯ ПЕРЕД СОХРАНЕНИЕМ
    
    // НОРМАЛИЗОВАННЫЕ аллергии
    const normalizedAllergies = this.canonicalizationService.canonicalizeList(member.allergies || []);
    for (const allergy of normalizedAllergies) {
      if (!allergy) continue;
      
      const canonicalAllergy = this.canonicalizationService.canonicalize(allergy);
      const { error } = await this.supabase
        .from('diet_facts')
        .upsert({
          profile_id: profileId,
          member_id: memberId,
          subject_scope: 'member',
          category: 'allergy',
          item: allergy,
          canonical: canonicalAllergy,
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
      } else {
        console.log(`✅ Сохранена аллергия в diet_facts: ${allergy} → ${canonicalAllergy}`);
      }
    }

    // НОРМАЛИЗОВАННЫЕ dislikes
    const normalizedDislikes = this.canonicalizationService.canonicalizeList(member.dislikes || []);
    for (const dislike of normalizedDislikes) {
      if (!dislike) continue;
      
      const canonicalDislike = this.canonicalizationService.canonicalize(dislike);
      const { error } = await this.supabase
        .from('diet_facts')
        .upsert({
          profile_id: profileId,
          member_id: memberId,
          subject_scope: 'member',
          category: 'dislike',
          item: dislike,
          canonical: canonicalDislike,
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
      } else {
        console.log(`✅ Сохранен dislike в diet_facts: ${dislike} → ${canonicalDislike}`);
      }
    }

    // НОРМАЛИЗОВАННЫЕ likes
    const normalizedLikes = this.canonicalizationService.canonicalizeList(member.likes || []);
    for (const like of normalizedLikes) {
      if (!like) continue;
      
      const canonicalLike = this.canonicalizationService.canonicalize(like);
      const { error } = await this.supabase
        .from('diet_facts')
        .upsert({
          profile_id: profileId,
          member_id: memberId,
          subject_scope: 'member',
          category: 'like',
          item: like,
          canonical: canonicalLike,
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
      } else {
        console.log(`✅ Сохранен like в diet_facts: ${like} → ${canonicalLike}`);
      }
    }

    console.log(`✅ Данные сохранены в diet_facts для member_id: ${memberId}`);
    console.log(`📊 Статистика: ${normalizedAllergies.length} аллергий, ${normalizedDislikes.length} dislikes, ${normalizedLikes.length} likes`);
  }

  async upsertDietFacts(profileId: number, facts: any): Promise<void> {
    // 🔄 ИНТЕГРАЦИЯ CANONICALIZATION SERVICE - В СУЩЕСТВУЮЩИХ МЕТОДАХ
    this.canonicalizationService.disableAI(); // Для надежности
    
    const supabase = getSupabaseServer();
    const nowIso = new Date().toISOString();

    const upsertHousehold = async (category: "like" | "dislike" | "allergy", canonical: string, confidence: number) => {
      // Нормализуем каноническое название
      const normalizedCanonical = this.canonicalizationService.canonicalize(canonical);
      
      const { data } = await supabase
        .from("diet_facts")
        .select("id,confidence,evidence_count,status")
        .eq("profile_id", profileId)
        .eq("subject_scope", "household")
        .eq("category", category)
        .eq("canonical", normalizedCanonical)
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
          canonical: normalizedCanonical,
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

    const upsertMember = async (memberId: number, category: "like" | "dislike" | "allergy", canonical: string, confidence: number) => {
      // Нормализуем каноническое название
      const normalizedCanonical = this.canonicalizationService.canonicalize(canonical);
      
      const { data } = await supabase
        .from("diet_facts")
        .select("id,confidence,evidence_count,status")
        .eq("profile_id", profileId)
        .eq("subject_scope", "member")
        .eq("member_id", memberId)
        .eq("category", category)
        .eq("canonical", normalizedCanonical)
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
          canonical: normalizedCanonical,
          confidence,
          evidence_count: 1,
          status: "unconfirmed",
          first_seen: nowIso,
          last_seen: nowIso,
        });
      }
    };

    // Household-level facts - нормализуем перед сохранением
    const hLikes: string[] = Array.isArray(facts?.householdLikes) ? facts.householdLikes : [];
    const hDislikes: string[] = Array.isArray(facts?.householdDislikes) ? facts.householdDislikes : [];
    const hAllergies: string[] = Array.isArray(facts?.householdAllergies) ? facts.householdAllergies : [];
    
    const normalizedHLikes = this.canonicalizationService.canonicalizeList(hLikes);
    const normalizedHDislikes = this.canonicalizationService.canonicalizeList(hDislikes);
    const normalizedHAllergies = this.canonicalizationService.canonicalizeList(hAllergies);
    
    for (const it of normalizedHLikes) await upsertHousehold("like", it, 0.8);
    for (const it of normalizedHDislikes) await upsertHousehold("dislike", it, 0.8);
    for (const it of normalizedHAllergies) await upsertHousehold("allergy", it, 0.9);

    // Member-level facts - нормализуем перед сохранением
    const members: Array<{ name?: string; likes?: string[]; dislikes?: string[]; allergies?: string[] }>
      = Array.isArray(facts?.members) ? facts.members : [];
    for (const m of members) {
      const memberId = await ensureMemberId(m?.name);
      if (!memberId) continue;
      
      const normalizedLikes = this.canonicalizationService.canonicalizeList(m.likes || []);
      const normalizedDislikes = this.canonicalizationService.canonicalizeList(m.dislikes || []);
      const normalizedAllergies = this.canonicalizationService.canonicalizeList(m.allergies || []);
      
      for (const it of normalizedLikes) await upsertMember(memberId, "like", it, 0.8);
      for (const it of normalizedDislikes) await upsertMember(memberId, "dislike", it, 0.8);
      for (const it of normalizedAllergies) await upsertMember(memberId, "allergy", it, 0.9);
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

  // ... остальные методы класса остаются без изменений ...
  // (upsertFamilyMembersDetails, removeHouseholdAllergy, removeMemberAllergy, etc.)
}