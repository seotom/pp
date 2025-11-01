"use client";

import {
  useRef,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
  type FormEvent,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { User } from "@supabase/supabase-js";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

export default function HomePage() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const [showConfirm, setShowConfirm] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isAuthLoading, setIsAuthLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // 🔹 автопрокрутка
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isTyping]);

  // 🔹 загрузка сессии + профиль + история
  useEffect(() => {
    if (!supabase) return;
    let isMounted = true;

    async function loadSessionAndHistory() {
      try {
        const { data } = supabase
          ? await supabase.auth.getSession()
          : { data: { session: null } };

        // Вариант 1 — клиент уже знает пользователя
        if (data.session?.user && isMounted) {
          setUser(data.session.user);
          try {
            await fetch("/api/auth/ensure-profile", {
              method: "POST",
              credentials: "include",
            });

            setIsLoadingMessages(true);
            const res = await fetch("/api/messages");
            if (res.ok) {
              const payload = await res.json();
              if (Array.isArray(payload.messages)) {
                setMessages(payload.messages);
              }
            }
          } catch (err) {
            console.warn(
              "Не удалось убедиться в наличии профиля (session):",
              err,
            );
          } finally {
            setIsLoadingMessages(false);
          }
          return;
        }

        // Вариант 2 — серверная сессия
        const response = await fetch("/api/auth/session", {
          method: "GET",
          credentials: "include",
        });

        if (response.ok && isMounted) {
          const payload = (await response.json()) as { user: User | null };
          if (payload.user) {
            setUser(payload.user);
            try {
              await fetch("/api/auth/ensure-profile", {
                method: "POST",
                credentials: "include",
              });

              setIsLoadingMessages(true);
              const res = await fetch("/api/messages");
              if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data.messages)) {
                  setMessages(data.messages);
                }
              }
            } catch (err) {
              console.warn(
                "Не удалось убедиться в наличии профиля (api):",
                err,
              );
            } finally {
              setIsLoadingMessages(false);
            }
          } else {
            setUser(null);
          }
        }
      } catch (e) {
        console.error("Ошибка при загрузке сессии или истории:", e);
      }
    }

    loadSessionAndHistory();

    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        if (isMounted) setUser(session?.user ?? null);
      },
    );

    return () => {
      isMounted = false;
      listener.subscription.unsubscribe();
    };
  }, [supabase]);

  // 🔹 вход
  const handleSignIn = useCallback(async () => {
    if (!supabase) return;
    try {
      setIsAuthLoading(true);
      setError(null);
      const redirectTo = `${window.location.origin}/auth/callback`;
      const { data, error: signInError } =
        await supabase.auth.signInWithOAuth({
          provider: "google",
          options: { redirectTo },
        });
      if (signInError) throw signInError;
      if (data?.url) window.location.href = data.url;
      else throw new Error("Не удалось получить ссылку для входа.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsAuthLoading(false);
    }
  }, [supabase]);

  // 🔹 выход
  const handleSignOut = useCallback(async () => {
    if (!supabase || !user) return;
    setIsAuthLoading(true);
    try {
      await fetch("/api/auth/sign-out", {
        method: "POST",
        credentials: "include",
      });
      await supabase.auth.signOut();
      setUser(null);
      setMessages([]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsAuthLoading(false);
    }
  }, [supabase, user]);

  // 🔹 очистка истории
  const handleClearHistory = useCallback(async () => {
    if (!user) return;
    setIsClearing(true);
    try {
      const res = await fetch("/api/messages/clear", { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error ?? "Ошибка при очистке истории.");
      }
      setMessages([]);
      setShowConfirm(false); // ← вернули закрытие модалки
    } catch (e) {
      console.error(e);
      setError("Не удалось очистить историю. Попробуйте позже.");
    } finally {
      setIsClearing(false);
    }
  }, [user]);

  // 🔹 общая функция отправки (чтобы клик по кнопке тоже её использовал)
  const sendMessage = useCallback(
    async (content: string) => {
      if (!user) return;
      setIsSending(true);
      setError(null);

      // добавляем сообщение пользователя
      const userMessage: ChatMessage = {
        id: `${Date.now()}-user`,
        role: "user",
        content,
      };
      setMessages((prev) => [...prev, userMessage]);

      try {
        setIsTyping(true);
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ message: content }),
        });

        const data = await res.json().catch(() => ({ content: "Ошибка." }));

        const assistantMessage: ChatMessage = {
          id: `${Date.now()}-assistant`,
          role: "assistant",
          content: data.content,
        };

        setMessages((prev) => [...prev, assistantMessage]);
      } catch (e) {
        setError("Ошибка при получении ответа.");
      } finally {
        setIsSending(false);
        setIsTyping(false); // ← вот из-за этого у тебя пропало
      }
    },
    [user],
  );

  // 🔹 отправка из формы
  const handleSendMessage = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!input.trim() || !user || isSending) return;
      const content = input.trim();
      setInput("");
      await sendMessage(content);
    },
    [input, user, isSending, sendMessage],
  );

  // 🔹 Enter / Shift+Enter
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const form = e.currentTarget.closest("form");
        if (form) form.requestSubmit();
      }
    },
    [],
  );

  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 px-4 py-8 text-zinc-900">
      <header className="mx-auto flex w-full max-w-4xl flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Семейный помощник по питанию</h1>
          <p className="text-sm text-zinc-600">
            Войдите через Google, чтобы общаться с помощником и сохранять данные.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {user ? (
            <>
              <span className="text-sm text-zinc-700">
                {user.email ?? user.id}
              </span>
              <button
                type="button"
                onClick={() => setShowConfirm(true)}
                disabled={isAuthLoading}
                className="rounded-full bg-amber-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-amber-400 disabled:opacity-60"
              >
                Очистить историю
              </button>
              <button
                type="button"
                onClick={handleSignOut}
                disabled={isAuthLoading}
                className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white transition hover:bg-zinc-800 disabled:opacity-60"
              >
                Выйти
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={handleSignIn}
              disabled={isAuthLoading}
              className="rounded-full bg-emerald-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-emerald-500 disabled:opacity-60"
            >
              Войти через Google
            </button>
          )}
        </div>
      </header>

      <main className="mx-auto mt-8 flex w-full max-w-4xl flex-1 flex-col gap-6">
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            {error}
          </div>
        )}

        <section className="flex flex-1 flex-col gap-4 rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
          <div className="flex-1 space-y-3 overflow-y-auto rounded-lg border border-zinc-100 p-4">
            {isLoadingMessages ? (
              // 🔹 скелет
              <div className="space-y-3 animate-pulse">
                <div className="h-6 w-1/2 rounded bg-zinc-200"></div>
                <div className="h-6 w-2/3 rounded bg-zinc-200"></div>
                <div className="h-6 w-1/3 rounded bg-zinc-200"></div>
              </div>
            ) : (
              <AnimatePresence>
                {messages.length === 0 ? (
                  <p className="text-sm text-zinc-500">
                    После входа напишите, например: «Наша семья из четырёх человек, у двоих аллергия на орехи».
                  </p>
                ) : (
                  messages.map((msg) => (
                    <motion.article
                      key={msg.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -10 }}
                      transition={{ duration: 0.2 }}
                      className={`rounded-lg px-4 py-3 text-sm leading-6 ${
                        msg.role === "user"
                          ? "bg-emerald-50 text-emerald-900"
                          : "bg-zinc-100 text-zinc-900"
                      }`}
                    >
                      <header className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                        {msg.role === "user" ? "Вы" : "AI-помощник"}
                      </header>
                      <MessageContent
                        msg={msg}
                        onSelectPrimary={(name) =>
                          sendMessage(`primary_member:${name}`)
                        }
                      />
                    </motion.article>
                  ))
                )}
              </AnimatePresence>
            )}

            {/* 🔹 индикатор "помощник печатает" */}
            <AnimatePresence>
              {isTyping && !isLoadingMessages && (
                <motion.div
                  key="typing-indicator"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.3 }}
                  className="flex items-center gap-2 rounded-lg bg-zinc-100 px-4 py-3 text-sm text-zinc-600"
                >
                  <span className="inline-flex h-2 w-2 animate-pulse rounded-full bg-zinc-400"></span>
                  <span>Помощник печатает…</span>
                </motion.div>
              )}
            </AnimatePresence>

            {/* 🔹 модалка подтверждения очистки */}
            <AnimatePresence>
              {showConfirm && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
                >
                  <motion.div
                    initial={{ scale: 0.9, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.9, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"
                  >
                    <h2 className="text-lg font-semibold text-zinc-900">
                      Подтвердите очистку данных
                    </h2>
                    <p className="mt-2 text-sm text-zinc-600">
                      Все сообщения и данные о семье будут удалены. Это действие нельзя отменить.
                    </p>
                    <div className="mt-6 flex justify-end gap-3">
                      <button
                        onClick={() => setShowConfirm(false)}
                        className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100"
                      >
                        Отменить
                      </button>
                      <button
                        onClick={handleClearHistory}
                        disabled={isClearing}
                        className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-amber-500 disabled:opacity-60"
                      >
                        {isClearing ? "Очищаю…" : "Очистить"}
                      </button>
                    </div>
                  </motion.div>
                </motion.div>
              )}
            </AnimatePresence>

            <div ref={messagesEndRef} />
          </div>

          <form
            onSubmit={handleSendMessage}
            className="flex flex-col gap-3 sm:flex-row"
          >
            <label className="flex-1">
              <span className="sr-only">Сообщение</span>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={!user || isSending}
                placeholder={
                  user
                    ? "Введите сообщение и нажмите Enter..."
                    : "Войдите, чтобы начать диалог."
                }
                className="h-24 w-full resize-none rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-emerald-500 focus:ring focus:ring-emerald-100 disabled:cursor-not-allowed disabled:bg-zinc-50"
              />
            </label>
            <button
              type="submit"
              disabled={!user || isSending || !input.trim()}
              className="h-12 rounded-lg bg-emerald-600 px-6 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-60"
            >
              Отправить
            </button>
          </form>
        </section>
      </main>
    </div>
  );
}

// 🔹 компонент для специальных сообщений
function MessageContent({
  msg,
  onSelectPrimary,
}: {
  msg: { content: string };
  onSelectPrimary: (name: string) => void;
}) {
  let parsed: any = null;
  try {
    parsed = JSON.parse(msg.content);
  } catch {
    return <p>{msg.content}</p>;
  }

  if (parsed && parsed.type === "choose_primary_member") {
    return (
      <div>
        <p>{parsed.message}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {parsed.members.map((m: any) => (
            <button
              key={m.id}
              type="button"
              onClick={() => onSelectPrimary(m.name)}
              className="rounded-lg bg-emerald-600 px-3 py-1 text-sm text-white transition hover:bg-emerald-500"
            >
              {m.name}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return <p>{msg.content}</p>;
}