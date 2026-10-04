"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { getHostSession } from "@/lib/session";
import { HostConsole } from "@/components/HostConsole";

export default function PartyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [token, setToken] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const stored = getHostSession(id);
      if (!alive) return;
      setToken(stored);
      setChecked(true);
    })();
    return () => {
      alive = false;
    };
  }, [id]);

  if (!checked) {
    return (
      <main className="grid min-h-screen place-items-center bg-neutral-950 text-white/50">
        Cargando…
      </main>
    );
  }

  if (!token) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-3 bg-neutral-950 p-6 text-center text-white">
        <p className="text-4xl">🔒</p>
        <h1 className="text-xl font-bold">Esta consola no está abierta en este navegador</h1>
        <p className="text-sm text-white/50">
          La consola del anfitrión se abre desde el mismo navegador donde creaste la fiesta
          (guardamos el acceso ahí, sin cuentas).
        </p>
        <Link
          href="/host"
          className="rounded-lg bg-fuchsia-600 px-4 py-2 text-sm font-medium hover:bg-fuchsia-500"
        >
          Crear otra fiesta
        </Link>
      </main>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-950">
      <HostConsole partyId={id} hostToken={token} />
    </div>
  );
}
