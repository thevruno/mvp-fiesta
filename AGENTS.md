# AGENTS.md — cómo trabajar en este repo

Proyecto: **"Elegí tu propia fiesta"** — el anfitrión pone playlists de YouTube, los invitados votan desde el celular qué suena en cada bloque, y las "cartas de acción" (karaoke, brindis…) interrumpen la música entre tema y tema.

El plan completo de producto, arquitectura y fases está en el documento de trabajo del MVP (resumen: Next.js + TypeScript + Supabase + YouTube IFrame, todo en tier free, sin pagos en esta etapa).

## Reglas del repo

1. **Toda la lógica de estados vive en `src/domain`** y se testea. `src/domain` es TypeScript puro: no importa Supabase, React, `fetch`, `Date.now()` ni `Math.random()`.
   - El reloj y el azar **se inyectan**: `reduce(state, event, { now, random })`.
   - `reduce` devuelve `{ state, effects }`: describe qué hay que hacer, no lo ejecuta.
   - Cualquier cambio de reglas entra con un test que lo demuestre (los tests están al lado del código: `block.test.ts`, `round.test.ts`, `machine.test.ts`).
2. **El servidor es la única autoridad** para cambiar de fase y registrar votos. El cliente no decide estado.
3. **Los deadlines son marcas de hora**, no timers del servidor. Las transiciones son idempotentes y con compare-and-swap (`version` + `expectedVersion`).
4. **Validación en todos los bordes** (server actions / route handlers) con Zod antes de tocar la base.
5. **La clave de YouTube Data API nunca va al cliente.** Nada de `search.list`.
6. **Migraciones versionadas** en `supabase/migrations`. Cada migración y cada política RLS se explica antes de aplicarse.
7. **Decisiones**: cada decisión nueva se agrega a `docs/decisions.md` con fecha y motivo.

## Estructura

```
src/
  app/                 rutas (host, invitados, pantalla de fiesta)
  domain/              TypeScript PURO y testeado: máquina de estados, bloques, votos, desempate
  server/              clientes Supabase/YouTube, server actions
  components/          UI
supabase/migrations/   esquema, RLS, seed del mazo preset
docs/decisions.md      registro de decisiones
```

## Comandos

```bash
npm run dev         # servidor de desarrollo
npm run lint        # ESLint
npm run typecheck   # tsc --noEmit
npm test            # Vitest (dominio)
npm run build       # build de producción
```

CI corre lint + typecheck + tests + build en cada push y PR.

## Estado actual

- ✅ Dominio puro con tests (bloques, rondas, votación, transiciones, host caído).
- ✅ CI y base Next.js + Tailwind.
- ⏳ Supabase, auth, UI, reproductor de YouTube, QR.
