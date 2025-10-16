// src\app\page.tsx

"use client";
import { signIn, useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function Home() {
  const { data: session, status } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (status === "authenticated") {
      router.replace("/dashboard");
    }
  }, [status, router]);

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="max-w-md w-full text-center space-y-4">
        <h1 className="text-2xl font-semibold">MVP: Авторизация и чат-бот</h1>
        <p className="text-sm text-gray-600">Войдите через Google, чтобы продолжить</p>
        <button
          onClick={() => signIn("google")}
          className="inline-flex items-center justify-center rounded-md bg-blue-600 text-white px-4 py-2 hover:bg-blue-700"
        >
          Войти через Google
        </button>
      </div>
    </main>
  );
}
