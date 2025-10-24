// src/services/info-handler.service.ts
// Назначение: Обработка информационных запросов пользователя

import { getSupabaseServer } from "@/lib/supabase";

export class InfoHandlerService {
  async handleInfoRequest(userId: string): Promise<{ content: string; family?: any[]; budget?: number | null; goals?: string[] }> {
    const supabase = getSupabaseServer();
    
    const { data: profile } = await supabase
      .from('profiles')
      .select('id, budget, goals')
      .eq('user_id', userId)
      .single();

    if (!profile) {
      return { content: "Профиль не найден" };
    }

    const { data: familyMembers } = await supabase
      .from('family_members')
      .select('name, age, weight, likes, dislikes, allergies')
      .eq('profile_id', profile.id);

    let familyText = '';
    if (familyMembers && familyMembers.length > 0) {
      familyMembers.forEach((member: any, index: number) => {
        familyText += `${index + 1}. **${member.name}**\n`;
        familyText += member.age ? `   - Возраст: ${member.age} лет\n` : '';
        familyText += member.weight ? `   - Вес: ${member.weight} кг\n` : '';
        familyText += `   - Любимые продукты: ${member.likes?.join(', ') || 'нет данных'}\n`;
        familyText += `   - Нелюбимые продукты: ${member.dislikes?.join(', ') || 'нет данных'}\n`;
        familyText += `   - Аллергии: ${member.allergies?.join(', ') || 'нет аллергий'}\n\n`;
      });
    } else {
      familyText = 'Информация о членах семьи отсутствует.';
    }

    const budgetText = profile.budget ? `- **Бюджет на неделю:** ${profile.budget} рублей\n` : '';
    const goalsText = profile.goals ? `- **Цели:** ${profile.goals}\n` : '';

    const content = `Вот актуальная информация о вашей семье:\n\n### Состав семьи:\n${familyText}### Общая информация:\n${budgetText}${goalsText}`;

    return {
      content,
      family: familyMembers || [],
      budget: profile.budget || null,
      goals: profile.goals ? profile.goals.split(',').map((g: string) => g.trim()) : []
    };
  }
}