# mvp-fiesta

**"Elegí tu propia fiesta"**: el anfitrión pega playlists de YouTube, los invitados votan desde el celular qué suena en cada bloque, y las cartas de acción (karaoke, brindis…) interrumpen la música entre tema y tema.

## Estado

Funciona de punta a punta y se puede jugar: crear fiesta → importar playlists → arrancar → los invitados entran con QR/código y votan → gana una lista o una carta de acción.

## Probar la app

```bash
npm install
npm run dev
```

- **Anfitrión:** [http://localhost:3000/host](http://localhost:3000/host) → creá la fiesta, pegá los links de YouTube y dejá la consola abierta (ahí vive el reproductor).
- **Invitados:** escanean el QR o entran a [`/j`](http://localhost:3000/j) con el código de 6 letras. Desde el celular, en la misma red, usando la IP de tu máquina (`http://192.168.x.x:3000/j`).

> El reproductor necesita que alguien toque "Tocá para arrancar el audio": los navegadores no dejan sonar sin una interacción.

### Importar playlists

Funciona mejor con una clave de YouTube Data API v3 en `YOUTUBE_API_KEY` (gratis, 10.000 unidades por día): así se leen títulos, duraciones y el permiso de embed, y se descartan de antemano los temas que no se pueden reproducir. Sin clave se intenta leer la página pública de la playlist (más frágil) y, si falla, la consola permite cargar temas a mano. Ver [`.env.example`](.env.example).

## Scripts

| Comando | Qué hace |
| --- | --- |
| `npm run dev` | Servidor de desarrollo |
| `npm run build` / `npm run start` | Build y servidor de producción |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript sin emitir |
| `npm test` | 84 tests: dominio puro + capa de servidor (Vitest) |
| `npm run smoke <url>` | Smoke test de punta a punta contra un servidor corriendo |

El smoke test llama a las server actions por HTTP como lo hace el navegador, así que sirve contra la URL de preview de Vercel:

```bash
npm run build && npm run start &
npm run smoke http://localhost:3000
```

## Arquitectura

```
src/
  domain/        TypeScript PURO y testeado: máquina de estados, bloques, votos, desempate
  server/        store (estado), actions (server actions validadas), views, youtube
  components/    consola del anfitrión, vista del invitado, reproductor, cartas
  app/           rutas: / (inicio), /host, /party/[id], /j/[code]
```

- El **dominio** decide todo (`reduce(state, event, ctx) → { state, effects }`), con deadlines y transiciones idempotentes por `version`. No sabe nada de HTTP ni de base de datos.
- Las **server actions** son la única puerta: validan con Zod, aplican el dominio y devuelven vistas.
- El **reloj del servidor** avanza la fiesta cuando un cliente consulta (o late el anfitrión); los invitados tienen un fallback para empujar transiciones vencidas.
- Las vistas hacen **polling** cada 1,5 s. Es provisorio: el plan prevé Realtime de Supabase y el cambio queda aislado en `src/lib/hooks.ts`.

### Limitaciones de esta etapa (a propósito)

- El estado vive **en memoria del servidor** (`src/server/store.ts`, detrás de la interfaz `PartyStore`): se pierde al reiniciar y, en Vercel, cada instancia tiene el suyo. Es el próximo paso: implementar `PartyStore` con Supabase (migraciones + RLS) sin tocar dominio ni UI.
- Sin cuentas: el acceso del anfitrión es un token guardado en el navegador; los invitados son apodos.
- Topes del plan ya aplicados: **40 invitados** por fiesta y **3 fiestas en vivo** a la vez.

Ver [`AGENTS.md`](AGENTS.md) para las convenciones y [`docs/decisions.md`](docs/decisions.md) para el registro de decisiones.

## Deploy

- **Preview por PR:** Vercel genera una URL por pull request.
- **Producción:** al mergear a `main`.
- Variable de entorno opcional: `YOUTUBE_API_KEY`.

### Ojo con la protección de previews

Por defecto Vercel pide iniciar sesión para abrir los previews (*Deployment Protection*). Como anfitrión podés entrar igual, pero **tus invitados no**: para probar la fiesta con celulares de otras personas, o corrés la app en tu red local (`npm run dev`) o desactivás la protección del proyecto en **Vercel → Project → Settings → Deployment Protection → Vercel Authentication: Disabled**. Los dominios de producción no tienen esa protección.

Cuando el preview queda público, el workflow `Smoke test del preview` lo prueba solo en cada PR.
