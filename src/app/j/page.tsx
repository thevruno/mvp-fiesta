"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, Input } from "@/components/ui";

export default function JoinLanding() {
  const router = useRouter();
  const [code, setCode] = useState("");

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-4 bg-neutral-950 p-6 text-white">
      <div className="text-center">
        <p className="text-5xl">📱</p>
        <h1 className="mt-2 text-2xl font-bold">Entrá a la fiesta</h1>
        <p className="mt-1 text-sm text-white/50">
          Escaneá el QR del anfitrión o poné el código de 6 letras.
        </p>
      </div>

      <Card>
        <div className="space-y-3">
          <Input
            value={code}
            onChange={(value) => setCode(value.toUpperCase())}
            placeholder="ABC123"
            className="text-center text-2xl uppercase tracking-[0.3em]"
            onEnter={() => code.length >= 4 && router.push(`/j/${code}`)}
          />
          <Button
            size="lg"
            className="w-full"
            disabled={code.trim().length < 4}
            onClick={() => router.push(`/j/${code.trim()}`)}
          >
            Continuar
          </Button>
        </div>
      </Card>
    </main>
  );
}
