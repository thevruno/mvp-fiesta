# mvp-fiesta

**"Elegí tu propia fiesta"**: el anfitrión pega playlists de YouTube, los invitados votan desde el celular qué suena en cada bloque, y las cartas de acción (karaoke, brindis…) interrumpen la música entre tema y tema.

## Stack

- [Next.js](https://nextjs.org) 16 (App Router) + React 19 + TypeScript
- [Tailwind CSS](https://tailwindcss.com) v4
- [Vitest](https://vitest.dev) para el dominio puro
- Deploy en [Vercel](https://vercel.com): cada PR genera una URL de preview

## Correr en local

```bash
npm install
npm run dev
```

Abrí [http://localhost:3000](http://localhost:3000).

## Scripts

| Comando | Qué hace |
| --- | --- |
| `npm run dev` | Servidor de desarrollo |
| `npm run build` | Build de producción |
| `npm run start` | Sirve el build de producción |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript sin emitir |
| `npm test` | Tests del dominio (Vitest) |
| `npm run test:watch` | Tests en modo watch |
| `npm run coverage` | Coverage de `src/domain` |

## Arquitectura

La lógica de la fiesta vive en **`src/domain`**, TypeScript puro sin I/O:

- `machine.ts` — máquina de estados (`reduce(state, event, ctx) → { state, effects }`) con deadlines y compare-and-swap por `version`.
- `block.ts` — armado de bloques por tope de duración, salteando temas no reproducibles.
- `round.ts` — cuándo se abre la votación, composición de la ronda, conteo y desempate al azar con semilla auditable.
- `random.ts` — azar reproducible (mulberry32).

El reloj y el azar se inyectan, así que todo es testeable sin base de datos ni red. Ver `docs/decisions.md` y `AGENTS.md`.

## Deploy

- **Preview por PR:** Vercel crea una URL por cada pull request.
- **Producción:** se publica al mergear a `main`.
