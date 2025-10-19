// src\app\dashboard\page.tsx

"use client";
import { useSession, signIn, signOut } from "next-auth/react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export default function DashboardPage() {
  const { data: session, status } = useSession();
  const [messages, setMessages] = useState<Array<{ id: string; role: "user" | "assistant"; content: string }>>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [budget, setBudget] = useState<number | null>(null);
  const [goals, setGoals] = useState("");
  
  // автопрокрутка вниз
  const bottomRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);
  // управление остановкой ответа: AbortController для запроса
  const abortControllerRef = useRef<AbortController | null>(null);

  // приветствие при пустой истории после восстановления
  const restoredRef = useRef(false);

  // restore from Supabase per user
  useEffect(() => {
    const userId = session?.user?.email;
    if (!userId) return;
    (async () => {
      try {
        const res = await fetch(`/api/profile?user_id=${encodeURIComponent(userId)}`);
        const data = await res.json();
        const chat = data?.profile?.family_data?.chat_history;
        setMessages(Array.isArray(chat) ? chat : []);
        setBudget(typeof data?.profile?.budget === "number" ? data.profile.budget : null);
        setGoals(typeof data?.profile?.goals === "string" ? data.profile.goals : "");
      } catch {
        setMessages([]);
        setBudget(null);
        setGoals("");
      }
      setInput("");
      setIsLoading(false);
      restoredRef.current = true;
    })();
  }, [session?.user?.email]);

  // временно убраны нижние поля профиля; автосохранение и серверный парсинг остаются
  // save messages to Supabase on change (debounced, after typing complete)
  useEffect(() => {
    const userId = session?.user?.email;
    // не сохраняем пока: нет пользователя, не восстановлено, или ассистент печатает
    if (!userId || !restoredRef.current || isLoading) return;

    const timer = setTimeout(async () => {
      try {
        await fetch(`/api/profile`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_id: userId, family_data: { chat_history: messages } }),
        });
      } catch {}
    }, 800); // дебаунс сохранения

    return () => clearTimeout(timer);
  }, [messages, session?.user?.email, isLoading]);

  // если после восстановления история пуста — начать диалог
  useEffect(() => {
    if (restoredRef.current && messages.length === 0) {
      const assistantMsg = {
        id: crypto.randomUUID(),
        role: "assistant" as const,
        content:
          "Привет! Я ваш помощник по планированию семейного питания.\nПомогу составить вкусное и полезное меню под ваш бюджет 😊\n\nНачнем со знакомства с семьей: расскажите, сколько человек в семье, какой у каждого возраст и вес?",
      };
      setMessages([assistantMsg]);
    }
  }, [messages]);

  // кнопка остановки текущего ответа
  const handleStop = () => {
    if (abortControllerRef.current) {
      try {
        abortControllerRef.current.abort();
      } catch {}
    }
    setIsLoading(false);
  };

  // очистка истории с подтверждением
  const handleClearHistory = () => {
    const confirmed = window.confirm(
      "Вы уверены, что хотите удалить историю чата?\nВсе данные удаляются без возможности восстановления."
    );
    if (!confirmed) return;
    const userId = session?.user?.email;
    if (userId) {
      // Полное удаление профиля и связанных данных (family_members)
      fetch(`/api/profile?user_id=${encodeURIComponent(userId)}`, {
        method: "DELETE",
      }).catch(() => {});
    }
    setMessages([]);
    setInput("");
  };

  if (status === "loading") {
    return <p className="p-6">Загрузка...</p>;
  }

  if (!session) {
    return (
      <main className="min-h-screen grid place-items-center p-6">
        <div className="text-center space-y-3">
          <p>Доступно только после входа.</p>
          <button
            onClick={() => signIn("google")}
            className="rounded-md bg-blue-600 text-white px-4 py-2 hover:bg-blue-700"
          >
            Войти через Google
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gradient-to-b from-white to-gray-100">
      <header className="sticky top-0 z-10 backdrop-blur bg-white/70 border-b">
        <div className="max-w-4xl mx-auto flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-full bg-blue-600 text-white grid place-items-center">AI</div>
            <div>
              <div className="font-semibold">Чат-бот</div>
              <div className="text-xs text-gray-500">Простой локальный чат без AI SDK</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-sm text-gray-600 hidden sm:block">
              {session.user?.name}
            </div>
            <button
              onClick={handleClearHistory}
              disabled={messages.length === 0}
              className="rounded-md border px-3 py-1.5 hover:bg-gray-50 text-red-600 disabled:opacity-50"
              title="Очистить историю чата"
            >
              Очистить историю
            </button>
            <button
              onClick={() => signOut()}
              className="rounded-md border px-3 py-1.5 hover:bg-gray-50"
            >
              Выйти
            </button>
          </div>
        </div>
      </header>

          <section className="max-w-4xl mx-auto px-4 py-6">
            <div className="border rounded-2xl shadow-sm bg-white/70 backdrop-blur p-4 min-h-[60vh] flex flex-col">
              <div className="flex-1 overflow-y-auto space-y-3">
                {messages.length === 0 ? (
                  <div className="text-center text-gray-600 py-10">
                    Начните диалог — задайте вопрос внизу.
                  </div>
                ) : (
                  messages.map((m) => (
                    <div key={m.id} className="flex">
                      <div
                        className={
                          "max-w-[80%] rounded-2xl px-4 py-2 text-sm shadow " +
                          (m.role === "user"
                            ? "whitespace-pre-wrap bg-blue-600 text-white ml-auto"
                            : "bg-gray-100 text-gray-800 mr-auto")
                        }
                      >
                        {m.role === "assistant" ? (
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            components={{
                              p: ({ node, ...props }) => (
                                <p className="mt-1 mb-2 leading-relaxed" {...props} />
                              ),
                              ul: ({ node, ...props }) => (
                                <ul className="mt-1 mb-2 pl-5 list-disc" {...props} />
                              ),
                              ol: ({ node, ...props }) => (
                                <ol className="mt-1 mb-2 pl-5 list-decimal" {...props} />
                              ),
                              li: ({ node, ...props }) => <li className="mb-1" {...props} />,
                              strong: ({ node, ...props }) => (
                                <strong className="font-semibold" {...props} />
                              ),
                            }}
                          >
                            {m.content}
                          </ReactMarkdown>
                        ) : (
                          m.content
                        )}
                      </div>
                    </div>
                  ))
                )}
                <div ref={bottomRef} />
              </div>

          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const text = (input || "").trim();
              if (!text || isLoading) return;
              const userMsg = { id: crypto.randomUUID(), role: "user" as const, content: text };
              const assistantId = crypto.randomUUID();
              const historyForRequest = [...messages, userMsg].map(({ role, content }) => ({ role, content }));
              // добавить плейсхолдер сообщения ассистента
              setMessages((prev) => [...prev, userMsg, { id: assistantId, role: "assistant" as const, content: "" }]);
              setInput("");
              setIsLoading(true);
              // подготовить контроллер для возможной отмены
              abortControllerRef.current = new AbortController();
              try {
                const res = await fetch("/api/chat", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    messages: historyForRequest,
                    user_id: session?.user?.email,
                    profile: budget != null || goals
                      ? { budget: { currency: "RUB", weekly: budget ?? 0 }, goals: goals ? goals.split(",").map((s) => s.trim()) : [] }
                      : undefined,
                  }),
                  signal: abortControllerRef.current.signal,
                });
                if (!res.ok) {
                  const errorText = await res.text();
                  throw new Error(errorText || "Ошибка обработки запроса");
                }

                const reader = res.body?.getReader();
                if (!reader) {
                  throw new Error("Пустой ответ от сервера");
                }

                const decoder = new TextDecoder();
                let fullText = "";

                while (true) {
                  const { value, done } = await reader.read();
                  if (done) {
                    break;
                  }
                  const chunk = decoder.decode(value, { stream: true });
                  fullText += chunk;
                  const textSnapshot = fullText;
                  setMessages((prev) =>
                    prev.map((m) => (m.id === assistantId ? { ...m, content: textSnapshot } : m))
                  );
                }

                const remaining = decoder.decode();
                if (remaining) {
                  fullText += remaining;
                  setMessages((prev) =>
                    prev.map((m) => (m.id === assistantId ? { ...m, content: fullText } : m))
                  );
                }
                reader.releaseLock();
              } catch (err) {
                if ((err as any)?.name === "AbortError") {
                  setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: "(остановлено)" } : m)));
                } else {
                  setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: "Ошибка запроса к модели" } : m)));
                }
              } finally {
                abortControllerRef.current = null;
                setIsLoading(false);
                // подхватить возможное авто-сохранение профиля на сервере
                const userId = session?.user?.email;
                if (userId) {
                  try {
                    const resP = await fetch(`/api/profile?user_id=${encodeURIComponent(userId)}`);
                    const dataP = await resP.json();
                    setBudget(typeof dataP?.profile?.budget === "number" ? dataP.profile.budget : null);
                    setGoals(typeof dataP?.profile?.goals === "string" ? dataP.profile.goals : "");
                  } catch {}
                }
              }
            }}
            className="mt-4 flex gap-2 items-center border-t pt-4"
          >
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Сформулируйте свой запрос и нажмите Enter..."
              rows={3}
              className="flex-1 border rounded-xl px-4 py-2 resize-none"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey) {
                  e.preventDefault();
                  const form = e.currentTarget.form;
                  form?.requestSubmit();
                }
              }}
            />
            <button
              type={isLoading ? "button" : "submit"}
              onClick={isLoading ? handleStop : undefined}
              className={`rounded-full ${isLoading ? "bg-red-600 hover:bg-red-700" : "bg-blue-600 hover:bg-blue-700"} text-white px-4 py-2 disabled:opacity-60`}
            >
              {isLoading ? "Прервать ответ" : "Отправить"}
            </button>
            
          </form>
        </div>
      </section>
      {/* Нижние UI-поля профиля временно убраны */}
    </main>
  );
}