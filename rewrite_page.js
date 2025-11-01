const fs = require("fs");
const content = `"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import type { User } from "@supabase/supabase-js";

import { getSupabaseBrowserClient } from "@/lib/supabase-browser";

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
};

export default function HomePage() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const [user, setUser] = useState<User | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isAuthLoading, setIsAuthLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) {
      return;
    }

    let isMounted = true;

    async function bootstrapSession() {
      try {
        const { data } = await supabase.auth.getSession();
        if (isMounted && data.session?.user) {
          setUser(data.session.user);
          return;
        }

        const response = await fetch("/api/auth/session", {
          method: "GET",
          credentials: "include",
        });

        if (response.ok && isMounted) {
          const payload = (await response.json()) as { user: User | null };
          setUser(payload.user ?? null);
        }
      } catch (sessionError) {
        console.error("Failed to fetch session", sessionError);
      }
    }

    bootstrapSession();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (isMounted) {
        setUser(session?.user ?? null);
      }
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, [supabase]);

  const handleSignIn = useCallback(async () => {
    if (!supabase) {
      return;
    }

    try {
      setIsAuthLoading(true);
      setError(null);
      const redirectTo = `${window.location.origin}/auth/callback`;
      const { data, error: signInError } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo,
        },
      });

      if (signInError) {
        throw signInError;
      }

      if (data?.url) {
        window.location.href = data.url;
      } else {
        throw new Error("The server did not return a sign-in URL.");
      }
    } catch (authError) {
      setError((authError as Error).message);
    } finally {
      setIsAuthLoading(false);
    }
  }, [supabase]);

  const handleSignOut = useCallback(async () => {
    if (!supabase || !user) {
      return;
    }

    setIsAuthLoading(true);
    setError(null);

    try {
      await fetch("/api/auth/sign-out", {
        method: "POST",
        credentials: "include",
      });
      await supabase.auth.signOut();
      setUser(null);
      setMessages([]);
    } catch (signOutError) {
      setError((signOutError as Error).message);
    } finally {
      setIsAuthLoading(false);
    }
  }, [supabase, user]);

  const handleSendMessage = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!input.trim() || !user || isSending) {
        return;
      }

      setIsSending(true);
      setError(null);

      const userMessage: ChatMessage = {
        id: `${Date.now()}-user`,
        role: "user",
        content: input.trim(),
      };

      setMessages((prev) => [...prev, userMessage]);
      setInput("");

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          credentials: "include",
          body: JSON.stringify({
            message: userMessage.content,
          }),
        });

        if (!response.ok) {
          if (response.status === 401) {
            setError("Please sign in with Google first.");
            return;
          }
          const payload = await response.json().catch(() => ({}));
          throw new Error(
            payload?.error ?? "Failed to fetch assistant response.",
          );
        }

        const payload = (await response.json()) as { content: string };
        setMessages((prev) => [
          ...prev,
          {
            id: `${Date.now()}-assistant`,
            role: "assistant",
            content: payload.content,
          },
        ]);
      } catch (sendError) {
        setError((sendError as Error).message);
      } finally {
        setIsSending(false);
      }
    },
    [input, isSending, user],
  );

  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 px-4 py-8 text-zinc-900">
      <header className="mx-auto flex w-full max-w-4xl flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Family Nutrition Assistant</h1>
          <p className="text-sm text-zinc-600">
            Sign in with Google to update family preferences and chat with the assistant.
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
                onClick={handleSignOut}
                disabled={isAuthLoading}
                className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white transition hover:bg-zinc-800 disabled:opacity-60"
              >
                Sign out
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={handleSignIn}
              disabled={isAuthLoading}
              className="rounded-full bg-emerald-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-emerald-500 disabled:opacity-60"
            >
              Sign in with Google
            </button>
          )}
        </div>
      </header>

      <main className="mx-auto mt-8 flex w-full max-w-4xl flex-1 flex-col gap-6">
        {error ? (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            {error}
          </div>
        ) : null}

        <section className="flex flex-1 flex-col gap-4 rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
          <div className="flex-1 space-y-3 overflow-y-auto rounded-lg border border-zinc-100 p-4">
            {messages.length === 0 ? (
              <p className="text-sm text-zinc-500">
                After you sign in, try saying something like \"We all enjoy dairy, but I am allergic to cheese.\"
              </p>
            ) : (
              messages.map((message) => (
                <article
                  key={message.id}
                  className={`rounded-lg px-4 py-3 text-sm leading-6 ${
                    message.role === "user"
                      ? "bg-emerald-50 text-emerald-900"
                      : "bg-zinc-100 text-zinc-900"
                  }`}
                >
                  <header className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                    {message.role === "user" ? "You" : "Assistant"}
                  </header>
                  <p>{message.content}</p>
                </article>
              ))
            )}
          </div>

          <form onSubmit={handleSendMessage} className="flex flex-col gap-3 sm:flex-row">
            <label className="flex-1">
              <span className="sr-only">Message</span>
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                disabled={!user || isSending}
                placeholder={
                  user
                    ? "Type a message for the assistant..."
                    : "Sign in to start chatting."
                }
                className="h-24 w-full resize-none rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-emerald-500 focus:ring focus:ring-emerald-100 disabled:cursor-not-allowed disabled:bg-zinc-50"
              />
            </label>
            <button
              type="submit"
              disabled={!user || isSending || !input.trim()}
              className="h-12 rounded-lg bg-emerald-600 px-6 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-60"
            >
              Send
            </button>
          </form>
        </section>
      </main>
    </div>
  );
}
`;

fs.writeFileSync('src/app/page.tsx', content, { encoding: 'utf8' });
