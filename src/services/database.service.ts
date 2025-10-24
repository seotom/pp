// src/services/database.service.ts
// Назначение: Абстракция для работы с базой данных Supabase

import { getSupabaseServer } from "@/lib/supabase";
import { SupabaseProfile, SupabaseFamilyMember, UserData } from "@/types/chat.types";

export class DatabaseService {
  private supabase = getSupabaseServer();

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
    const now = new Date().toISOString();
    
    // Сохраняем аллергии
    for (const allergy of member.allergies || []) {
      if (!allergy) continue;
      
      const { error } = await this.supabase
        .from('diet_facts')
        .upsert({
          profile_id: profileId,
          member_id: memberId,
          subject_scope: 'member',
          category: 'allergy',
          item: allergy,
          canonical: allergy.toLowerCase().trim(),
          confidence: 0.9,
          evidence_count: 1,
          status: 'unconfirmed',
          first_seen: now,
          last_seen: now
        }, {
          onConflict: 'profile_id,member_id,subject_scope,category,canonical'
        });
      
      if (error) console.error('Ошибка сохранения аллергии в diet_facts:', error);
    }

    // Сохраняем dislikes
    for (const dislike of member.dislikes || []) {
      if (!dislike) continue;
      
      const { error } = await this.supabase
        .from('diet_facts')
        .upsert({
          profile_id: profileId,
          member_id: memberId,
          subject_scope: 'member',
          category: 'dislike',
          item: dislike,
          canonical: dislike.toLowerCase().trim(),
          confidence: 0.8,
          evidence_count: 1,
          status: 'unconfirmed',
          first_seen: now,
          last_seen: now
        }, {
          onConflict: 'profile_id,member_id,subject_scope,category,canonical'
        });
      
      if (error) console.error('Ошибка сохранения dislike в diet_facts:', error);
    }

    // Сохраняем likes
    for (const like of member.likes || []) {
      if (!like) continue;
      
      const { error } = await this.supabase
        .from('diet_facts')
        .upsert({
          profile_id: profileId,
          member_id: memberId,
          subject_scope: 'member',
          category: 'like',
          item: like,
          canonical: like.toLowerCase().trim(),
          confidence: 0.8,
          evidence_count: 1,
          status: 'unconfirmed',
          first_seen: now,
          last_seen: now
        }, {
          onConflict: 'profile_id,member_id,subject_scope,category,canonical'
        });
      
      if (error) console.error('Ошибка сохранения like в diet_facts:', error);
    }

    console.log('Данные сохранены в diet_facts для member_id:', memberId);
  }
}