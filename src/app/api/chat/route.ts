// src/app/api/chat/route.ts
// Назначение: Главный API endpoint для чата

// TODO: 
// 
// 1. Оптимизация запросов к БД
// 3. Ответ от AI на основе данных из БД
//      Понял! Обновляю информацию: ты любишь лосось => Аллергии: на курт, апельсины, мандарины, сёмгу.
//      "Не ем семгу" => "...Любимые продукты: гречка, овощи, яйца, шпинат, огурцы, лосось."
//                       "Нелюбимые: брокколи, минтай, картофель, рис, томаты"
//       "Обожаю красную рыбу" => "Любимые продукты: гречка, овощи, яйца, шпинат, огурцы, лосось (красная рыба).", в БД likes "рыба", из dislikes не удален лосось
//       "Красные яблоки" => "Яблоко", нужно поработать над этим
//       "Люблю апельсины, но аллергия на цитрусовые" => из likes не удаляется "апельсин"
//       "Не переношу сливочное масло" => в dislike "масло сливочное", при этом в likes "масло"
// 4. Тестирование семейных предпочтений:
// ✅ "Вся семья любит картошку" 
//    → household likes: ["картофель"]

// ✅ "У всех аллергия на апельсины"
//    → household allergies: ["апельсин"]

// ✅ "Мы не едим грибы"
//    → household dislikes: ["грибы"]
// 5. Запрос "Что мне нельзя есть?"- выводит нелюбимые продукты и аллергии (из контекста AI, а не из БД), в БД аллергий нет
// 6. Запрос "Какие продукты я люблю?" - выводит любимые продукты из контекста AI, а не из БД
// 7. Убрать каноникализацию 
// 8. Тест на "рыба" (разная) и "капуста" (белокочанная, брокколи, пекинская)
// 9. Несколько членов семьи - не работает


import { NextRequest } from "next/server";
import OpenAI from "openai";
import { MessageParserService } from "@/services/message-parser.service";
import { ContextBuilderService } from "@/services/context-builder.service";
import { InfoHandlerService } from "@/services/info-handler.service";
import { DatabaseService } from "@/services/database.service";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

function getLastUserMessage(messages: any[]): string {
  const userMessages = messages.filter((m: { role: string }) => m.role === "user");
  return userMessages.pop()?.content ?? "";
}

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

    const lastUserMessage = getLastUserMessage(messages);

    // Инициализация сервисов
    const messageParser = new MessageParserService();
    const contextBuilder = new ContextBuilderService();
    const infoHandler = new InfoHandlerService();

    // 🔹 Обработка информационных запросов
    if (/покажи|информация|предпочтения|семья|профиль/i.test(lastUserMessage)) {
      console.log("🔹 Информационный запрос, подставляем данные из БД");
      const data = await messageParser.extractBasicInfo(lastUserMessage, user_id);
      const text = data?.content || "Не удалось получить информацию";
      
      return new Response(text, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-cache",
        },
      });
    }

    // 🔹 Предварительная синхронизация данных
    if (user_id && lastUserMessage) {
      try {
        await messageParser.extractBasicInfo(lastUserMessage, user_id);
      } catch (err) {
        console.error("❌ Ошибка предварительной синхронизации профиля:", err);
      }
    }

    // 🔹 Построение контекста для AI
    const systemContext = await contextBuilder.buildSystemContext(user_id);

    // 🔹 Генерация ответа через OpenAI
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        try {
          const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "system", content: systemContext }, ...messages],
            temperature: 0.7,
            stream: true,
          });

          for await (const part of completion) {
            const delta = part.choices[0]?.delta?.content || "";
            if (delta) {
              controller.enqueue(encoder.encode(delta));
            }
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