// src\app\dashboard\page.tsx

"use client";
import { useSession, signIn, signOut } from "next-auth/react";
import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ChangeEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type ChatMessage = { id: string; role: "user" | "assistant"; content: string };

const MessageBubble = memo(function MessageBubble({ message }: { message: ChatMessage }) {
  const isAssistant = message.role === "assistant";
  return (
    <div className="flex">
      <div
        className={
          "max-w-[80%] rounded-2xl px-4 py-2 text-sm shadow " +
          (isAssistant ? "bg-gray-100 text-gray-800 mr-auto" : "whitespace-pre-wrap bg-blue-600 text-white ml-auto")
        }
      >
        {isAssistant ? (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              p: ({ node: _node, ...props }) => <p className="mt-1 mb-2 leading-relaxed" {...props} />,
              ul: ({ node: _node, ...props }) => <ul className="mt-1 mb-2 pl-5 list-disc" {...props} />,
              ol: ({ node: _node, ...props }) => <ol className="mt-1 mb-2 pl-5 list-decimal" {...props} />,
              li: ({ node: _node, ...props }) => <li className="mb-1" {...props} />,
              strong: ({ node: _node, ...props }) => <strong className="font-semibold" {...props} />,
            }}
          >
            {message.content}
          </ReactMarkdown>
        ) : (
          message.content
        )}
      </div>
    </div>
  );
});

MessageBubble.displayName = "MessageBubble";

export default function DashboardPage() {
  const { data: session, status } = useSession();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [visibleCount, setVisibleCount] = useState(20);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [budget, setBudget] = useState<number | null>(null);
  const [goals, setGoals] = useState("");
  
  const deferredMessages = useDeferredValue(messages);
  const visibleMessages = useMemo(() => {
    const total = deferredMessages.length;
    if (total === 0) return [] as ChatMessage[];
    const count = Math.min(total, visibleCount);
    return deferredMessages.slice(total - count);
  }, [deferredMessages, visibleCount]);

  const renderedMessages = useMemo(
    () => visibleMessages.map((message) => <MessageBubble key={message.id} message={message} />),
    [visibleMessages]
  );

  const handleInputChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    setInput(event.target.value);
  }, []);

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const bottomAnchorRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollAdjustRef = useRef<{ prevHeight: number; prevScrollTop: number } | null>(null);
  const [loadMoreLocked, setLoadMoreLocked] = useState(false);
  const assistantIndexRef = useRef<number | null>(null);
  const initialScrollDoneRef = useRef(false);

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
        const restored = Array.isArray(chat) ? (chat as ChatMessage[]) : [];
        setMessages(restored);
        setVisibleCount(Math.min(restored.length, 20));
        setBudget(typeof data?.profile?.budget === "number" ? data.profile.budget : null);
        setGoals(typeof data?.profile?.goals === "string" ? data.profile.goals : "");
      } catch {
        setMessages([]);
        setVisibleCount(0);
        setBudget(null);
        setGoals("");
      }
      setInput("");
      setIsLoading(false);
      restoredRef.current = true;
      initialScrollDoneRef.current = false;
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
          "Привет! Я ваш помощник по планированию семейного питания.\nПомогу составить вкусное и полезное меню под ваш бюджет 😊\n\nНачнем со знакомства, перечислите: \n\n1. Сколько человек в семье (обязательно) и их имена;\n\n2. Возраст и вес каждого члена семьи.",
      };
      setMessages([assistantMsg]);
      setVisibleCount(1);
    }
  }, [messages]);

  useEffect(() => {
    setVisibleCount((prev) => {
      const total = messages.length;
      if (total === 0) {
        return 0;
      }
      const desiredMinimum = Math.min(20, total);
      if (prev < desiredMinimum) {
        return desiredMinimum;
      }
      if (prev > total) {
        return total;
      }
      return prev;
    });
  }, [messages.length]);

  const commitScrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      if (bottomAnchorRef.current) {
        bottomAnchorRef.current.scrollIntoView({ block: "end", behavior: "smooth" });
      } else if (scrollContainerRef.current) {
        const container = scrollContainerRef.current;
        container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
      }
      if (typeof window !== "undefined") {
        window.requestAnimationFrame(() => {
          window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
        });
      }
    });
  }, []);

  const loadMoreVisibleMessages = useCallback(() => {
    if (loadMoreLocked) return;
    if (visibleCount >= messages.length) return;
    setLoadMoreLocked(true);
    const container = scrollContainerRef.current;
    if (container) {
      pendingScrollAdjustRef.current = {
        prevHeight: container.scrollHeight,
        prevScrollTop: container.scrollTop,
      };
    }
    setVisibleCount((prev) => {
      const total = messages.length;
      if (prev >= total) return prev;
      return Math.min(total, prev + 20);
    });
  }, [loadMoreLocked, messages.length, visibleCount]);

  useEffect(() => {
    if (!restoredRef.current) return;
    if (initialScrollDoneRef.current) return;
    if (messages.length === 0) return;
    initialScrollDoneRef.current = true;
    commitScrollToBottom();
  }, [messages.length, commitScrollToBottom]);

  useLayoutEffect(() => {
    if (!pendingScrollAdjustRef.current) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    const { prevHeight, prevScrollTop } = pendingScrollAdjustRef.current;
    const heightDiff = container.scrollHeight - prevHeight;
    requestAnimationFrame(() => {
      if (!scrollContainerRef.current) return;
      scrollContainerRef.current.scrollTop = prevScrollTop + heightDiff;
    });
    pendingScrollAdjustRef.current = null;
  }, [visibleCount]);

  useEffect(() => {
    if (!loadMoreLocked) return;
    setLoadMoreLocked(false);
  }, [loadMoreLocked, visibleCount]);

  // кнопка остановки текущего ответа
  const handleStop = () => {
    if (abortControllerRef.current) {
      try {
        abortControllerRef.current.abort();
      } catch {}
    }
    setIsLoading(false);
    const idx = assistantIndexRef.current;
    if (typeof idx === "number") {
      setMessages((prev) => {
        if (idx < 0 || idx >= prev.length) return prev;
        const current = prev[idx];
        if (!current || current.role !== "assistant") return prev;
        const copy = [...prev];
        copy[idx] = { ...current, content: "(остановлено)" };
        return copy;
      });
    }
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
    setVisibleCount(0);
    initialScrollDoneRef.current = false;
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
              <div ref={scrollContainerRef} className="flex-1 overflow-y-auto space-y-3">
                {messages.length === 0 ? (
                  <div className="text-center text-gray-600 py-10">
                    Начните диалог — задайте вопрос внизу.
                  </div>
                ) : (
                  <>
                    <div className="h-px" aria-hidden />
                    {visibleCount < messages.length && (
                      <div className="flex flex-col items-center gap-2 py-2 text-xs text-gray-500">
                        <span>Для загрузки предыдущих сообщений нажмите на кнопку</span>
                        <button
                          type="button"
                          onClick={loadMoreVisibleMessages}
                          disabled={loadMoreLocked}
                          className="rounded-full border border-gray-300 px-4 py-1.5 text-[13px] font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          Загрузить предыдущие 20 сообщений
                        </button>
                      </div>
                    )}
                    {renderedMessages}
                    <div ref={bottomAnchorRef} aria-hidden />
                  </>
                )}
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
              setMessages((prev) => {
                const updated = [...prev, userMsg, { id: assistantId, role: "assistant" as const, content: "" }];
                assistantIndexRef.current = updated.length - 1;
                return updated;
              });
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
                let streamCompleted = false;
                const updateAssistantMessage = (content: string) => {
                  setMessages((prev) => {
                    if (prev.length === 0) return prev;
                    let targetIndex = assistantIndexRef.current ?? -1;
                    if (
                      targetIndex == null ||
                      targetIndex < 0 ||
                      targetIndex >= prev.length ||
                      prev[targetIndex]?.id !== assistantId
                    ) {
                      targetIndex = prev.findIndex((m) => m.id === assistantId);
                    }
                    if (targetIndex === -1) return prev;
                    const current = prev[targetIndex];
                    if (!current) return prev;
                    if (current.content === content) return prev;
                    const copy = [...prev];
                    copy[targetIndex] = { ...current, content };
                    assistantIndexRef.current = targetIndex;
                    return copy;
                  });
                };

                while (true) {
                  const { value, done } = await reader.read();
                  if (done) {
                    break;
                  }
                  const chunk = decoder.decode(value, { stream: true });
                  fullText += chunk;
                  updateAssistantMessage(fullText);
                }

                const remaining = decoder.decode();
                if (remaining) {
                  fullText += remaining;
                  updateAssistantMessage(fullText);
                }
                streamCompleted = true;
                reader.releaseLock();
                if (streamCompleted) {
                  commitScrollToBottom();
                }
              } catch (err) {
                const isAbortError =
                  err instanceof DOMException
                    ? err.name === "AbortError"
                    : typeof err === "object" &&
                      err !== null &&
                      "name" in err &&
                      typeof (err as { name?: unknown }).name === "string" &&
                      (err as { name: string }).name === "AbortError";
                if (isAbortError) {
                  setMessages((prev) => {
                    if (!prev.length) return prev;
                    const index = assistantIndexRef.current ?? prev.findIndex((m) => m.id === assistantId);
                    if (index === -1) return prev;
                    const target = prev[index];
                    if (!target) return prev;
                    const copy = [...prev];
                    copy[index] = { ...target, content: "(остановлено)" };
                    return copy;
                  });
                } else {
                  setMessages((prev) => {
                    if (!prev.length) return prev;
                    const index = assistantIndexRef.current ?? prev.findIndex((m) => m.id === assistantId);
                    if (index === -1) return prev;
                    const target = prev[index];
                    if (!target) return prev;
                    const copy = [...prev];
                    copy[index] = { ...target, content: "Ошибка запроса к модели" };
                    return copy;
                  });
                }
              } finally {
                abortControllerRef.current = null;
                setIsLoading(false);
                assistantIndexRef.current = null;
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
              onChange={handleInputChange}
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