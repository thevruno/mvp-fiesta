"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createParty } from "@/server/actions";
import { getHostSession, lastHostParty, saveHostSession } from "@/lib/session";
import { Button, Card, Input, Notice } from "@/components/ui";

export default function HostPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [previous, setPrevious] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const last = lastHostParty();
      if (alive && last && getHostSession(last)) setPrevious(last);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const create = async () => {
    setBusy(true);
    const result = await createParty({ name });
    setBusy(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }

    saveHostSession(result.partyId, result.hostToken);
    router.push(`/party/${result.partyId}`);
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-lg flex-col justify-center gap-4 bg-neutral-950 p-6 text-white">
      <div>
        <p className="text-xs uppercase tracking-widest text-white/40">Anfitrión</p>
        <h1 className="text-3xl font-bold">Creá tu fiesta</h1>
        <p className="mt-1 text-sm text-white/50">
          Después vas a poder pegar las playlists y compartir el QR con tus invitados.
        </p>
      </div>

      <Card>
        <div className="space-y-3">
          <label className="block text-xs uppercase tracking-widest text-white/40">
            Nombre de la fiesta
          </label>
          <Input
            value={name}
            onChange={setName}
            placeholder="Cumple de Vero"
            onEnter={() => name.trim() && create()}
          />
          {error && <Notice tone="error">{error}</Notice>}
          <Button onClick={create} disabled={busy || !name.trim()} size="lg" className="w-full">
            Crear fiesta
          </Button>
        </div>
      </Card>

      {previous && (
        <Card title="Volver a la última fiesta">
          <Button variant="ghost" onClick={() => router.push(`/party/${previous}`)} className="w-full">
            Abrir consola
          </Button>
        </Card>
      )}

      <p className="text-center text-xs text-white/30">
        Los ajustes (duración de los bloques, ventana de votación, cartas) se cambian desde la
        consola.
      </p>
    </main>
  );
}
