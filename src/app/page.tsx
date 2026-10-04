import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col justify-center gap-8 bg-neutral-950 p-6 text-white">
      <div className="text-center">
        <p className="text-6xl">🎉</p>
        <h1 className="mt-3 text-4xl font-black tracking-tight sm:text-5xl">
          Elegí tu propia fiesta
        </h1>
        <p className="mx-auto mt-3 max-w-xl text-sm text-white/60 sm:text-base">
          El anfitrión pone las playlists de YouTube, los invitados votan desde el celular qué
          suena en cada bloque, y las cartas de acción (karaoke, brindis…) aparecen entre tema y
          tema. Sin cuenta para los invitados: escanean un QR y eligen un apodo.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Link
          href="/host"
          className="group rounded-2xl border border-white/10 bg-white/5 p-6 transition hover:border-fuchsia-400/60 hover:bg-fuchsia-500/10"
        >
          <p className="text-3xl">🎧</p>
          <h2 className="mt-2 text-lg font-bold">Soy anfitrión</h2>
          <p className="mt-1 text-sm text-white/50">
            Creá la fiesta, pegá los links de YouTube y proyectá la consola en el notebook.
          </p>
        </Link>

        <Link
          href="/j"
          className="group rounded-2xl border border-white/10 bg-white/5 p-6 transition hover:border-emerald-400/60 hover:bg-emerald-500/10"
        >
          <p className="text-3xl">📱</p>
          <h2 className="mt-2 text-lg font-bold">Me invitaron</h2>
          <p className="mt-1 text-sm text-white/50">
            Entrá con el código o el QR de la fiesta y votá desde tu celular.
          </p>
        </Link>
      </div>

      <div className="rounded-2xl border border-white/10 bg-black/30 p-5 text-sm text-white/60">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-white/40">Cómo funciona</h3>
        <ol className="mt-3 space-y-2">
          <li>
            <strong className="text-white/80">1.</strong> El anfitrión crea la fiesta y pega las
            playlists. Cada bloque dura lo que él decida (30 o 60 min por defecto).
          </li>
          <li>
            <strong className="text-white/80">2.</strong> Cuando al bloque le quedan pocos temas o
            pocos minutos, se abre la votación: 2 o 3 opciones, una puede ser una carta de acción.
          </li>
          <li>
            <strong className="text-white/80">3.</strong> Gana la más votada. Si gana una lista,
            suena cuando termina el bloque; si gana una carta, aparece en todas las pantallas con
            cuenta regresiva y después vuelve la música.
          </li>
        </ol>
      </div>

      <p className="text-center text-xs text-white/30">
        Etapa MVP: sin pagos, para fiestas privadas entre amigos. El tope es de 40 invitados y 3
        fiestas a la vez.
      </p>
    </main>
  );
}
