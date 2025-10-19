// src\app\api\chat\route.ts

// стабильный фикс

import { NextRequest } from "next/server";
import OpenAI from "openai";
import { getSupabaseServer } from "@/lib/supabase";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

// 🔹 Функция получения актуальных данных из Supabase
async function getUserDataFromDB(user_id: string) {
  const supabase = getSupabaseServer();

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, budget, goals")
    .eq("user_id", user_id)
    .single();

  if (profileError || !profile) {
    console.error("❌ Не удалось найти профиль пользователя:", profileError);
    return null;
  }

  const { data: familyMembers, error: familyError } = await supabase
    .from("family_members")
    .select("name, age, weight, allergies, dislikes, likes")
    .eq("profile_id", profile.id);

  if (familyError) {
    console.error("❌ Ошибка получения family_members:", familyError);
  }

  return {
    profile,
    family: familyMembers || [],
  };
}

// 🔧 Функция синхронизированного анализа и возврата данных
async function extractBasicInfo(message: string, userId: string) {
  try {
    const supabase = getSupabaseServer();

    // 1️⃣ Получаем профиль
    const { data: profile } = await supabase
      .from('profiles')
      .select('id, budget, goals')
      .eq('user_id', userId)
      .single();

    if (!profile) {
      console.log('❌ Профиль не найден для user_id:', userId);
      return;
    }

    // 2️⃣ Анализируем сообщение через AI
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Ты — парсер сообщений пользователя для AI-ассистента питания. 
          Верни СТРОГО JSON:
          {
            "budget": number | null,
            "goals": string[] | [],
            "updates_per_person": [
              {
                "name": string,
                "add_allergies": string[] | [],
                "remove_allergies": string[] | [],
                "add_dislikes": string[] | [],
                "remove_dislikes": string[] | [],
                "add_likes": string[] | [],
                "remove_likes": string[] | []
              }
            ]
          }
          Никакого текста вне JSON.`
        },
        { role: "user", content: message }
      ],
      temperature: 0.1,
      response_format: { type: "json_object" },
    });

    const raw = response.choices[0]?.message?.content;
    if (!raw) return console.log("AI не вернул данные");

    const data = JSON.parse(raw);

    // 🧠 AI-driven интерпретация смысла "прошла аллергия"
    const intentPrompt = `
    Ты — логический парсер сообщений о питании.
    Определи, выражает ли сообщение пользователя факт, что аллергия прошла (то есть нужно удалить данные о ней).
    Ответь строго в JSON-формате:
    { "allergyGone": true | false }

    Сообщение: "${message}"
    `;

    try {
      const intentResp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: intentPrompt }],
        temperature: 0,
        response_format: { type: "json_object" }
      });

      const parsedIntent = JSON.parse(intentResp.choices[0]?.message?.content || "{}");
      const allergyGoneFlag = !!parsedIntent.allergyGone;

      if (allergyGoneFlag) {
        console.log('🧠 AI определил, что речь о прошедших аллергиях — добавляем remove_allergies=["все"]');
        if (!data.updates_per_person || data.updates_per_person.length === 0) {
          data.updates_per_person = [{ name: 'все', remove_allergies: ['все'] }];
        } else {
          data.updates_per_person = data.updates_per_person.map((u: any) => ({
            ...u,
            remove_allergies: ['все']
          }));
        }
      }
    } catch (intentError) {
      console.error('⚠️ Ошибка при анализе смысла intentPrompt:', intentError);
    }


    

    // console.log("🧠 AI-структура:", data);

    // 🧠 Эвристика: если AI вернул "у нас / оба / мы" или имена-плейсхолдеры — применяем ко всем членам семьи

    const mentionsGroup =
    (data.updates_per_person?.some((u: { name: any; }) =>
      ['пользователь', 'партнер', 'я', 'мы', 'оба'].includes(String(u.name || '').toLowerCase())
    )) || /у нас|оба|вместе|мы/i.test(message);

    if (mentionsGroup) {
      const { data: allMembersRaw, error: listErr } = await supabase
        .from('family_members')
        .select('name')
        .eq('profile_id', profile.id);

      // Нормализуем в массив, даже если null/undefined
      const allMembers = Array.isArray(allMembersRaw) ? allMembersRaw : [];

      if (allMembers.length > 0) {
        const memberNames = allMembers.map(m => m.name);
        console.log(`🔁 Распознано групповое выражение ("у нас/оба/мы") — применяем ко всем: ${memberNames.join(', ')}`);

        const expandedUpdates: any[] = [];
        const source = Array.isArray(data.updates_per_person) && data.updates_per_person.length > 0
          ? data.updates_per_person
          : [{}]; // если AI не прислал блок — просто размножим пустые операции (на случай других полей)

        for (const u of source) {
          for (const name of memberNames) {
            expandedUpdates.push({ ...u, name });
          }
        }

        data.updates_per_person = expandedUpdates;
      } else {
        console.log('⚠️ Семейные участники не найдены — невозможно применить групповое обновление');
      }
    }

    // 🧩 Если после этого в updates_per_person остались только "пользователь"/"партнер", без имён из БД
    // 🧩 Если после этого в updates_per_person остались только плейсхолдеры — ничего не меняем (лучше запросить уточнение в ответе чата)
    if (
      data.updates_per_person?.length > 0 &&
      data.updates_per_person.every((u: { name: any; }) =>
        ['пользователь', 'партнер', 'я', 'мы', 'оба'].includes(String(u.name || '').toLowerCase())
      )
    ) {
      console.log('🤔 Не удалось точно определить, кто из членов семьи упомянут — пропускаем сохранение до уточнения пользователя');
      // Ничего не сохраняем и продолжаем — текстовый ответ сформирует сам чат-бот.
    }

    // 3️⃣ Применяем обновления из updates_per_person
    if (data.updates_per_person?.length > 0) {
      for (const update of data.updates_per_person) {
        const { name, add_allergies = [], remove_allergies = [], add_dislikes = [], remove_dislikes = [], add_likes = [], remove_likes = [] } = update;

        const { data: member } = await supabase
          .from('family_members')
          .select('id, allergies, dislikes, likes')
          .eq('profile_id', profile.id)
          .eq('name', name)
          .single();

        if (!member) {
          console.log(`❌ Член семьи ${name} не найден`);
          continue;
        }

        const updated = {
          allergies: [...(member.allergies || [])],
          dislikes: [...(member.dislikes || [])],
          likes: [...(member.likes || [])],
        };

        // Добавления и удаления с автоматическим контролем взаимных связей

        // ✅ Аллергии
        if (add_allergies.length) {
          for (const a of add_allergies) {
            if (!updated.allergies.includes(a)) updated.allergies.push(a);
            // Удаляем из likes и dislikes, если есть пересечение
            updated.likes = updated.likes.filter(l => l !== a);
            updated.dislikes = updated.dislikes.filter(d => d !== a);
          }
        }
        if (remove_allergies.length) {
          if (remove_allergies.includes('все')) {
            // 🧹 Полное очищение аллергий
            console.log(`🧹 Полностью очищаем аллергии у ${update.name}`);
            updated.allergies = [];
          } else {
            // Точечное удаление указанных аллергий
            updated.allergies = updated.allergies.filter(a => !remove_allergies.includes(a));
            console.log(`❌ Удаляем конкретные аллергии у ${update.name}: ${remove_allergies.join(', ')}`);
          }
        }

        // ✅ Нелюбимые продукты
        if (add_dislikes.length) {
          for (const d of add_dislikes) {
            if (!updated.dislikes.includes(d)) updated.dislikes.push(d);
            // Удаляем из likes, если продукт туда попадал
            updated.likes = updated.likes.filter(l => l !== d);
          }
        }
        if (remove_dislikes.length) {
          updated.dislikes = updated.dislikes.filter(d => !remove_dislikes.includes(d));
        }

        // ✅ Любимые продукты
        if (add_likes.length) {
          for (const l of add_likes) {
            if (!updated.likes.includes(l)) updated.likes.push(l);
            // Удаляем из dislikes и allergies, если продукт был там
            updated.dislikes = updated.dislikes.filter(d => d !== l);
            updated.allergies = updated.allergies.filter(a => a !== l);
          }
        }
        if (remove_likes.length) {
          updated.likes = updated.likes.filter(l => !remove_likes.includes(l));
        }


        // Убираем пересечения
        updated.allergies = [...new Set(updated.allergies.filter(a => !updated.likes.includes(a) && !updated.dislikes.includes(a)))];
        updated.dislikes = [...new Set(updated.dislikes.filter(d => !updated.likes.includes(d) && !updated.allergies.includes(d)))];
        updated.likes = [...new Set(updated.likes.filter(l => !updated.dislikes.includes(l) && !updated.allergies.includes(l)))];

        const { error } = await supabase
          .from('family_members')
          .update({
            allergies: updated.allergies,
            dislikes: updated.dislikes,
            likes: updated.likes
          })
          .eq('id', member.id);

        if (error) console.error(`Ошибка обновления ${name}:`, error);
        else console.log(`✅ Обновлены данные для ${name}:`, updated);
      }
    }

    // 4️⃣ Подтягиваем актуальные данные из БД
    const { data: familyMembers } = await supabase
      .from('family_members')
      .select('name, age, weight, allergies, dislikes, likes')
      .eq('profile_id', profile.id);

    // 5️⃣ Формируем финальный ответ исключительно из БД
    let text = `Вот актуальная информация о вашей семье:\n\n`;

    for (const m of familyMembers || []) {
      text += `**${m.name}**\n`;
      text += `- Любимые продукты: ${m.likes?.join(', ') || 'нет'}\n`;
      text += `- Нелюбимые продукты: ${m.dislikes?.join(', ') || 'нет'}\n`;
      text += `- Аллергии: ${m.allergies?.join(', ') || 'нет'}\n\n`;
    }

    if (profile.budget) text += `**Бюджет:** ${profile.budget} руб.\n`;
    if (profile.goals) text += `**Цели:** ${profile.goals}\n`;

    // console.log("💬 Итоговый ответ сформирован из БД:", text);

    return { content: text };
  } catch (err) {
    console.error("Ошибка в extractBasicInfo:", err);
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

// 🔹 ОБРАБОТКА ИНФОРМАЦИОННЫХ ЗАПРОСОВ (например: "Покажи мне информацию о семье")
async function handleInfoRequest(userId: string) {
  const supabase = getSupabaseServer();

  // Получаем профиль
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, budget, goals')
    .eq('user_id', userId)
    .single();

  if (!profile) {
    console.log('Профиль не найден для user_id:', userId);
    return { content: "Профиль не найден" };
  }

  // Получаем членов семьи
  const { data: familyMembers } = await supabase
    .from('family_members')
    .select('name, age, weight, likes, dislikes, allergies')
    .eq('profile_id', profile.id);

  // Формируем текстовый ответ для чата
  let familyText = '';
  if (familyMembers && familyMembers.length > 0) {
    familyMembers.forEach((member, index) => {
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

  // Возвращаем объект JSON для UI
  return {
    content,
    family: familyMembers || [],
    budget: profile.budget || null,
    goals: profile.goals ? profile.goals.split(',').map((g: string) => g.trim()) : []
  };
}


// ✅ Основной обработчик POST /api/chat
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const messages = body?.messages || [];
    const user_id = body?.user_id;

    console.log("Получен запрос chat:", {
      user_id,
      messagesCount: messages.length,
      lastMessage: messages[messages.length - 1]?.content,
    });

    const lastUserMessage = messages.filter((m: { role: string }) => m.role === "user").pop()?.content ?? "";

    // 🔹 Если запрос информационный — сразу отдаём из БД
    if (/покажи|информация|предпочтения|семья|профиль/i.test(lastUserMessage)) {
      console.log("🔹 Информационный запрос, подставляем данные из БД");
      const data = await extractBasicInfo(lastUserMessage, user_id);
      const text = data?.content || "Не удалось получить информацию";
      return new Response(text, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-cache",
        },
      });
    }

    // 🔹 Обычный сценарий — с обновлениями
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        try {
          const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "system", content: "Ты — AI-ассистент по питанию" }, ...messages],
            temperature: 0.7,
            stream: true,
          });

          for await (const part of completion) {
            const delta = part.choices[0]?.delta?.content || "";
            if (delta) {
              controller.enqueue(encoder.encode(delta));
            }
          }

          if (user_id && lastUserMessage) {
            extractBasicInfo(lastUserMessage, user_id).catch((err) =>
              console.error("Ошибка в extractBasicInfo:", err)
            );
          }
        } catch (error) {
          console.error("Ошибка генерации ответа:", error);
          controller.enqueue(encoder.encode("Ошибка обработки запроса к модели"));
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    });
  } catch (error) {
    console.error("Ошибка в API chat:", error);
    return new Response("Ошибка обработки запроса", { status: 500 });
  }
}
