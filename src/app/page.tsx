export default function Home() {
  return (
    <main className="flex-1 flex items-center justify-center p-6">
      <div className="w-full max-w-xl rounded-2xl border border-black/10 dark:border-white/15 p-8 shadow-sm">
        <p className="text-xs font-medium uppercase tracking-widest text-fuchsia-600 dark:text-fuchsia-400">
          MVP Fiesta
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">
          🎉 Base lista
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-black/60 dark:text-white/60">
          Este es el esqueleto del proyecto: Next.js + Tailwind, deployado con
          preview automático en cada PR. Falta conectar las features del plan
          para que la fiesta empiece.
        </p>
        <ul className="mt-6 space-y-2 text-sm text-black/70 dark:text-white/70">
          <li>✅ Next.js (App Router) + TypeScript + Tailwind</li>
          <li>✅ Lint y build corriendo en CI en cada PR</li>
          <li>⏳ Preview deploy de Vercel por PR</li>
          <li>⏳ Pantallas y flujo de la app</li>
        </ul>
      </div>
    </main>
  );
}
