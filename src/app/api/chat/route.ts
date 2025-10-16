import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { getSupabaseServer } from "@/lib/supabase";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

// Простое извлечение структурированных данных
async function extractBasicInfo(message: string, userId: string) {
  try {
    const supabase = getSupabaseServer();
    
    // Ищем профиль пользователя
    const { data: profile } = await supabase
      .from('profiles')
      .select('id')
      .eq('user_id', userId)
      .single();

    if (!profile) {
      console.log('Профиль не найден для user_id:', userId);
      return;
    }

    const prompt = `
      Извлеки информацию из сообщения пользователя. Верни ТОЛЬКО JSON:
      {
        "budget": число или null,
        "goals": массив строк или [],
        "family": [
          {"name": строка, "age": число, "allergies": [], "dislikes": [], "likes": []}
        ],
        "remove": {
          "allergies": [],    // Аллергии для удаления
          "dislikes": [],     // Нелюбимые для удаления  
          "likes": []         // Любимые для удаления
        },
        "clear_all": boolean, // TRUE для "забудь всё", "очисти все предпочтения" - очищает ВСЕ предпочтения и аллергии
        "clear_scope": "allergies" | "dislikes" | "likes" | null // для удаления конкретного типа
      }
      
      Сообщение: "${message}"
      
      КРИТИЧЕСКИ ВАЖНЫЕ ПРАВИЛА ДЛЯ МАССОВЫХ ОПЕРАЦИЙ:
      1. "clear_all": true → ТОЛЬКО для "забудь всё", "очисти все предпочтения", "вычеркни всё" - очищает ВСЕ аллергии и предпочтения, но НЕ удаляет членов семьи
      2. "clear_scope" → для конкретных типов: "удали все аллергии", "вычеркни все нелюбимые"
      3. "clear_all" НИКОГДА не удаляет членов семьи, только их предпочтения

      Примеры:
      - "Вычеркни все наши аллергии и нелюбимые продукты. Оставьте только то, что я люблю: картофель, морковь, говядину" → 
        {
          "clear_all": true,  // очистить все предпочтения
          "family": [
            {"name": "муж", "likes": ["картофель", "морковь", "говядина"]}
          ]
        }
      - "Удали все аллергии" → 
        {
          "clear_scope": "allergies"
        }
      - "Забудь всё, что было раньше" → 
        {
          "clear_all": true
        }
      - "Очисти все мои предпочтения" → 
        {
          "clear_scope": "dislikes",
          "remove": {"likes": []}
        }
    `;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      response_format: { type: "json_object" }
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      console.log('AI не вернул контент');
      return;
    }

    console.log('AI ответил:', content);

    let data;
    try {
      data = JSON.parse(content);
    } catch (parseError) {
      console.error('Ошибка парсинга JSON:', parseError);
      return;
    }

    // 🔄 ОБРАБОТКА ПОЛНОГО СБРОСА ДАННЫХ - ТОЛЬКО ПРЕДПОЧТЕНИЙ, НЕ ЧЛЕНОВ СЕМЬИ
    if (data.clear_all) {
      console.log('🔄 Полный сброс предпочтений и аллергий по команде пользователя');
      
      // НЕ удаляем членов семьи, только очищаем их предпочтения и аллергии
      const { data: familyMembers } = await supabase
        .from('family_members')
        .select('id, name, allergies, dislikes, likes')
        .eq('profile_id', profile.id);

      if (familyMembers) {
        for (const member of familyMembers) {
          const { error } = await supabase
            .from('family_members')
            .update({
              allergies: [],
              dislikes: [], 
              likes: []
            })
            .eq('id', member.id);
            
          if (error) {
            console.error(`Ошибка очистки данных у ${member.name}:`, error);
          } else {
            console.log(`Данные очищены у ${member.name}`);
          }
        }
      }

      // Сбрасываем бюджет и цели? НЕТ - только если явно указано
      // Оставляем бюджет и цели без изменений
      console.log('Предпочтения и аллергии очищены, члены семьи сохранены');
    }

    // 🔄 ОБРАБОТКА МАССОВОГО УДАЛЕНИЯ - ТОЛЬКО ДЛЯ ЯВНЫХ КОМАНД
    if (data.clear_scope) {
      // ЗАЩИТА: проверяем, что это действительно команда массового удаления
      const messageLower = message.toLowerCase();
      const massDeleteKeywords = [
        'все аллергии', 'все нелюбимые', 'все любимые', 
        'вычеркни все', 'удали все', 'очисти все',
        'никаких аллергий', 'никаких нелюбимых'
      ];
      
      const isExplicitMassDelete = massDeleteKeywords.some(keyword => 
        messageLower.includes(keyword)
      );
      
      if (!isExplicitMassDelete) {
        console.log('❌ Защита: неявная команда массового удаления, пропускаем');
      } else {
        console.log(`🔄 Массовое удаление: ${data.clear_scope}`);
        
        const { data: familyMembers } = await supabase
          .from('family_members')
          .select('id, name, allergies, dislikes, likes')
          .eq('profile_id', profile.id);

        if (familyMembers) {
          for (const member of familyMembers) {
            const updateData: any = {};
            
            if (data.clear_scope === 'allergies') {
              updateData.allergies = [];
              console.log(`Очищаем аллергии у ${member.name}`);
            }
            
            if (data.clear_scope === 'dislikes') {
              updateData.dislikes = [];
              console.log(`Очищаем dislikes у ${member.name}`);
            }
            
            if (data.clear_scope === 'likes') {
              updateData.likes = [];
              console.log(`Очищаем likes у ${member.name}`);
            }
            
            const { error } = await supabase
              .from('family_members')
              .update(updateData)
              .eq('id', member.id);
              
            if (error) {
              console.error(`Ошибка массового удаления у ${member.name}:`, error);
            }
          }
        }
      }
    }

    // 🔄 СПЕЦИАЛЬНАЯ ОБРАБОТКА ДЛЯ СЦЕНАРИЯ 5: Массовое удаление + установка likes
    const messageLower = message.toLowerCase();
    if ((messageLower.includes('вычеркни все') || messageLower.includes('очисти все')) && 
        (messageLower.includes('оставьте только') || messageLower.includes('оставь только'))) {
      
      console.log('🔄 Специальная обработка: массовое удаление + установка likes');
      
      // Очищаем ВСЕ предпочтения у всех членов семьи
      const { data: allMembers } = await supabase
        .from('family_members')
        .select('id, name')
        .eq('profile_id', profile.id);

      if (allMembers) {
        for (const member of allMembers) {
          const { error } = await supabase
            .from('family_members')
            .update({
              allergies: [],
              dislikes: [],
              likes: []
            })
            .eq('id', member.id);
            
          if (error) {
            console.error(`Ошибка очистки данных у ${member.name}:`, error);
          } else {
            console.log(`Данные очищены у ${member.name}`);
          }
        }
        console.log('Все предпочтения очищены у всех членов семьи');
      }

      // Извлекаем продукты для добавления в likes
      const likesMatch = message.match(/люблю:\s*([^.]*)/) || 
                         message.match(/оставь только[^:]*:\s*([^.]*)/) ||
                         message.match(/оставьте только[^:]*:\s*([^.]*)/);
      
      if (likesMatch && likesMatch[1]) {
        const products = likesMatch[1].split(',').map(p => p.trim()).filter(p => p.length > 0);
        console.log('Найдены продукты для likes:', products);
        
        if (products.length > 0) {
          // Определяем, кому добавлять (по контексту)
          let targetMembers = ['муж']; // по умолчанию
          if (messageLower.includes(' у жены ') || messageLower.includes(' жена ')) {
            targetMembers = ['жена'];
          } else if (messageLower.includes(' у нас ') || messageLower.includes(' мы ')) {
            targetMembers = allMembers ? allMembers.map(m => m.name) : ['муж', 'жена'];
          }

          console.log('Добавляем продукты членам:', targetMembers);

          // Добавляем продукты указанным членам семьи
          for (const memberName of targetMembers) {
            const { data: targetMember } = await supabase
              .from('family_members')
              .select('id, likes')
              .eq('profile_id', profile.id)
              .eq('name', memberName)
              .single();

            if (targetMember) {
              const { error } = await supabase
                .from('family_members')
                .update({ 
                  likes: Array.from(new Set([...products])) 
                })
                .eq('id', targetMember.id);

              if (error) {
                console.error(`Ошибка добавления likes ${memberName}:`, error);
              } else {
                console.log(`Продукты добавлены в likes ${memberName}:`, products);
                
                // Сохраняем в diet_facts
                await saveToDietFacts(profile.id, targetMember.id, {
                  name: memberName,
                  likes: products,
                  allergies: [],
                  dislikes: []
                });
              }
            }
          }
        }
      }
      
      // После специальной обработки выходим из функции, чтобы не выполнять стандартную логику
      return;
    }

    // Сохраняем бюджет и цели
    if (data.budget || data.goals?.length > 0) {
      const updateData: any = {};
      if (data.budget) updateData.budget = data.budget;
      if (data.goals?.length > 0) updateData.goals = data.goals.join(', ');
      
      const { error: updateError } = await supabase
        .from('profiles')
        .update(updateData)
        .eq('id', profile.id);

      if (updateError) {
        console.error('Ошибка обновления профиля:', updateError);
      } else {
        console.log('Профиль обновлен:', updateData);
      }
    }

    // 🔄 ОБРАБОТКА УДАЛЕНИЯ ДАННЫХ
    if (data.remove && (data.remove.allergies?.length > 0 || data.remove.dislikes?.length > 0 || data.remove.likes?.length > 0)) {
      console.log('Найдены данные для удаления:', data.remove);
      
      // УЛУЧШЕННЫЙ анализ контекста
      let targetMembers: string[] = [];
      const messageLower = message.toLowerCase();
      
      if (messageLower.includes(' у жены ') || messageLower.includes(' жена ') || 
          messageLower.includes(' у неё ') || messageLower.includes(' у супруги ') ||
          messageLower.match(/(?:у|нет)\s+жены/)) {
        targetMembers = ['жена'];
        console.log('Определен контекст: жена');
      } 
      else if (messageLower.includes(' у меня ') || messageLower.includes(' я ') || 
               messageLower.includes(' мне ') || messageLower.match(/(?:у|нет)\s+меня/) ||
               messageLower.includes(' у мужа ') || messageLower.includes(' муж ') || 
               messageLower.includes(' у него ')) {
        targetMembers = ['муж'];
        console.log('Определен контекст: муж');
      }
      else if (messageLower.includes(' у нас ') || messageLower.includes(' мы ') || 
               messageLower.includes(' нам ') || messageLower.match(/(?:у|нет)\s+нас/) ||
               messageLower.match(/мы\s+.*(?:не\s+)?любим/) ||
               messageLower.match(/мы\s+.*(?:не\s+)?едим/) ||
               messageLower.match(/мы\s+.*(?:не\s+)?употребляем/) ||
               messageLower.match(/мы\s+.*больше\s+не/) ||
               messageLower.match(/мы\s+.*не\s+не\s+любим/) ||
               messageLower.includes(' наши ') || messageLower.includes(' нам ') ||
               // Добавляем поддержку массовых операций
               messageLower.includes(' все ') || messageLower.includes(' никакой ') ||
               messageLower.includes(' вычеркните ') || messageLower.includes(' удали ')) {
        targetMembers = ['муж', 'жена'];
        console.log('Определен контекст: оба');
      }
      else {
        // Если контекст не ясен - используем эвристику
        if (messageLower.includes(' мы ') || messageLower.startsWith('мы ') || 
            messageLower.includes(' наш') || messageLower.includes(' нам ')) {
          targetMembers = ['муж', 'жена'];
          console.log('Эвристика: найдены слова "мы/наш/нам", применяем к обоим');
        } else {
          console.log('❌ Контекст не ясен, пропускаем удаление');
          // НЕ выходим - возможно есть данные для добавления
        }
      }

      // Если определили контекст - выполняем удаление
      if (targetMembers.length > 0) {
        const { data: targetFamilyMembers } = await supabase
          .from('family_members')
          .select('id, name, allergies, dislikes, likes')
          .eq('profile_id', profile.id)
          .in('name', targetMembers);

        if (targetFamilyMembers) {
          for (const member of targetFamilyMembers) {
            const updatedData: any = {};
            
            // Удаляем аллергии
            if (data.remove.allergies?.length > 0) {
              const newAllergies = member.allergies.filter((item: string) => 
                !data.remove.allergies.includes(item)
              );
              if (JSON.stringify(newAllergies) !== JSON.stringify(member.allergies)) {
                updatedData.allergies = newAllergies;
                console.log(`Удаляем аллергии у ${member.name}:`, data.remove.allergies);
              }
            }
            
            // Удаляем dislikes
            if (data.remove.dislikes?.length > 0) {
              const newDislikes = member.dislikes.filter((item: string) => 
                !data.remove.dislikes.includes(item)
              );
              if (JSON.stringify(newDislikes) !== JSON.stringify(member.dislikes)) {
                updatedData.dislikes = newDislikes;
                console.log(`Удаляем dislikes у ${member.name}:`, data.remove.dislikes);
              }
            }
            
            // Удаляем likes
            if (data.remove.likes?.length > 0) {
              const newLikes = member.likes.filter((item: string) => 
                !data.remove.likes.includes(item)
              );
              if (JSON.stringify(newLikes) !== JSON.stringify(member.likes)) {
                updatedData.likes = newLikes;
                console.log(`Удаляем likes у ${member.name}:`, data.remove.likes);
              }
            }
            
            // Сохраняем обновленные данные
            if (Object.keys(updatedData).length > 0) {
              const { error } = await supabase
                .from('family_members')
                .update(updatedData)
                .eq('id', member.id);
                
              if (error) {
                console.error(`Ошибка удаления данных у ${member.name}:`, error);
              } else {
                console.log(`Данные удалены у ${member.name}`);
              }
            } else {
              console.log(`Нет изменений для удаления у ${member.name}`);
            }
          }
        }
      }
    }

    // 🔄 СОХРАНЕНИЕ НОВЫХ ДАННЫХ (как раньше)
    if (data.family?.length > 0) {
      for (const member of data.family) {
        if (!member.name) {
          console.log('❌ Пропускаем члена семьи без имени');
          continue;
        }

        // ПРОВЕРКА: пропускаем пустые объекты (только имя без данных)
        const hasData = member.age || 
                       (member.allergies && member.allergies.length > 0) ||
                       (member.dislikes && member.dislikes.length > 0) || 
                       (member.likes && member.likes.length > 0);
        
        if (!hasData) {
          console.log(`❌ Пропускаем пустой объект для ${member.name}`);
          continue;
        }

        const { data: existing } = await supabase
          .from('family_members')
          .select('id, allergies, dislikes, likes, age, name')
          .eq('profile_id', profile.id)
          .eq('name', member.name)
          .single();

        // Подготовка данных с мерджем
        const mergedData = {
          profile_id: profile.id,
          name: member.name,
          age: member.age || (existing?.age || null),
          allergies: Array.from(new Set([
            ...(existing?.allergies || []),
            ...(member.allergies || [])
          ])),
          dislikes: Array.from(new Set([
            ...(existing?.dislikes || []),
            ...(member.dislikes || [])
          ])),
          likes: Array.from(new Set([
            ...(existing?.likes || []),
            ...(member.likes || [])
          ]))
        };

        if (existing) {
          const { error: updateError } = await supabase
            .from('family_members')
            .update(mergedData)
            .eq('id', existing.id);

          if (updateError) {
            console.error('Ошибка обновления члена семьи:', updateError);
          } else {
            console.log('Обновлен член семьи с мерджем:', member.name);
            await saveToDietFacts(profile.id, existing.id, mergedData);
          }
        } else {
          const { data: newMember, error: insertError } = await supabase
            .from('family_members')
            .insert(mergedData)
            .select()
            .single();

          if (insertError) {
            console.error('Ошибка создания члена семьи:', insertError);
          } else if (newMember) {
            console.log('Создан член семьи:', member.name);
            await saveToDietFacts(profile.id, newMember.id, mergedData);
          }
        }
      }
    }

  } catch (error) {
    console.error('Ошибка сохранения данных:', error);
  }
}

// Сохранение в diet_facts
async function saveToDietFacts(profileId: number, memberId: number, member: any) {
  try {
    const supabase = getSupabaseServer();
    const now = new Date().toISOString();

    // Сохраняем аллергии
    for (const allergy of member.allergies || []) {
      if (!allergy) continue;
      
      const { error } = await supabase
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

      if (error) {
        console.error('Ошибка сохранения аллергии в diet_facts:', error);
      }
    }

    // Сохраняем dislikes
    for (const dislike of member.dislikes || []) {
      if (!dislike) continue;
      
      const { error } = await supabase
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

      if (error) {
        console.error('Ошибка сохранения dislike в diet_facts:', error);
      }
    }

    // Сохраняем likes
    for (const like of member.likes || []) {
      if (!like) continue;
      
      const { error } = await supabase
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

      if (error) {
        console.error('Ошибка сохранения like в diet_facts:', error);
      }
    }

    console.log('Данные сохранены в diet_facts для member_id:', memberId);

  } catch (error) {
    console.error('Ошибка в saveToDietFacts:', error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const messages = body?.messages || [];
    const user_id = body?.user_id;

    console.log('Получен запрос chat:', {
      user_id,
      messagesCount: messages.length,
      lastMessage: messages[messages.length - 1]?.content
    });

    // Получаем системный промпт
    const systemPrompt = `
      Ты - дружелюбный и умный AI-помощник по семейному питанию. 

      ОСНОВНЫЕ ПРАВИЛА:
      1. Когда пользователь дает полные данные (семья, бюджет, предпочтения, аллергии, цели) - ПРЕДЛАГАЙ генерацию плана питания
      2. Если данных не хватает - вежливо запроси недостающее
      3. Подтверждай изменения простыми словами
      4. Понимай сложные конструкции ("раньше не любил, теперь люблю")
      5. Отвечай ТОЛЬКО на вопросы по питанию, бюджету, шопинг-листам
      6. НЕ давай медицинских рекомендаций и диагнозов
      7. НЕ обсуждай политику, развлечения, технические детали
      8. При off-topic запросах вежливо возвращай к теме питания

      КОГДА ПРЕДЛАГАТЬ ПЛАН ПИТАНИЯ:
      - Есть информация о семье (количество, возраст)
      - Известен бюджет
      - Известны предпочтения (что не любят)
      - Известны аллергии
      - Известны цели

      ПРИМЕРЫ ЕСТЕСТВЕННЫХ ОТВЕТОВ:
      - На сложные конструкции: "Понял! Обновляю: добавляю свинину в любимые, убираю курицу из нелюбимых"
      - На массовые операции: "Хорошо, очищаю все ваши аллергии и предпочтения"
      - На полный сброс: "Отлично, начинаю с чистого листа!"

      Всегда будь краток, дружелюбен и точен.

      КЛЮЧЕВЫЕ СООБЩЕНИЯ:
      - Питаться правильно можно даже экономя
      - Продуманный список покупок - основа здоровья семьи
      - Покупайте с умом - не отказывайтесь от полезного

      ИСТОЧНИКИ:
      - Российские нормы питания (МР 2.3.1.0253-21)
      - Данные о составе продуктов
      - Усредненные цены российских магазинов
    `;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        ...messages,
      ],
      temperature: 0.7,
    });

    const content = completion.choices[0]?.message?.content || "Не удалось обработать запрос";

    console.log('AI сгенерировал ответ:', content);

    // Асинхронно сохраняем данные
    if (user_id && messages.length > 0) {
      const lastUserMessage = messages.filter((m: { role: string }) => m.role === 'user').pop()?.content;
      if (lastUserMessage) {
        console.log('Запускаем сохранение для сообщения:', lastUserMessage);
        extractBasicInfo(lastUserMessage, user_id).catch(error => {
          console.error('Ошибка в extractBasicInfo:', error);
        });
      }
    }

    return NextResponse.json({ content });

  } catch (error: any) {
    console.error('Ошибка в API chat:', error);
    return NextResponse.json(
      { error: "Извините, произошла ошибка. Попробуйте еще раз." },
      { status: 500 }
    );
  }
}