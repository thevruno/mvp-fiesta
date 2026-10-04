# Decisiones (ADR corto)

Una línea por decisión, con fecha y motivo. Se agrega al final, sin reescribir el pasado.

## 2026-10-02 — Base del proyecto

- **Next.js 16 + TypeScript estricto + Tailwind v4**: es el stack del plan (sección 4) y lo que Vercel despliega sin configuración.
- **Sin `next/font/google`**: el build falla sin salida a internet. Se usa el stack de fuentes del sistema. Si más adelante hace falta una tipografía propia, se auto-hospeda con `next/font/local`.
- **CI con lint + typecheck + tests + build** en cada push y PR: el plan pide que la IA no rompa nada sin que se note.

## 2026-10-02 — Dominio puro primero

- **`src/domain` no importa nada**: ni Supabase, ni React, ni `fetch`. Toda la lógica de estados, armado de bloques, conteo de votos y desempate vive ahí. Es lo que se testea (66 tests, Vitest).
- **Los tiempos son `number` (epoch ms)**, no `Date` ni strings: las cuentas son exactas y los tests no dependen de la zona horaria. La traducción a `timestamptz` se hace en el borde.
- **El azar se inyecta, no se llama**: `reduce(state, event, { now, random })`. Así los tests son deterministas y el plan puede auditar cada ronda (la semilla se guarda en la ronda).
- **`reduce` devuelve `effects`** en vez de escribir: el dominio dice *qué* hay que hacer (`PLAY_TRACK`, `OPEN_ROUND`, `SHOW_ACTION`…) y la capa de datos/UI decide *cómo*.

## 2026-10-02 — Reglas que quedaron fijadas en el dominio

- **El anfitrión manda en el índice del bloque**: `TRACK_STARTED` con el `videoId` que realmente está sonando mueve el bloque a ese tema. Sin esto, el dominio creía que seguía sonando el tema 1 mientras el reproductor ya iba por el 4 (bug detectado con un test).
- **Una ronda por bloque** (`block.roundOpened`): la votación se abre una sola vez y no se reabre al pasar de tema.
- **`tiebreakSeed` se guarda siempre**, haya empate o no: es el registro del azar usado para cerrar la ronda.
- **Pozo agotado = reciclar, no terminar**: se vuelven a barajar las listas excluyendo la última sonada. Si la fiesta tiene una sola lista, se afloja la exclusión y sigue sonando en loop (antes terminaba sola: bug detectado con un test). La fiesta termina solo si el anfitrión la termina.
- **Ventana de votación**: `min(ventana, fin del bloque)` con un piso de 20 s. Si el bloque dura menos que el piso, la votación sigue viva unos segundos con la música parada (fase `voting`).
- **Anfitrión caído congela todo**: `HOST_LOST` bloquea transiciones *y* reportes del reproductor; `HOST_BACK` corre los deadlines por el tiempo perdido, para que la fiesta no se atrase.
- **`version` en cada transición**: es el compare-and-swap del plan (sección 6). Un `ADVANCE` con `expectedVersion` viejo se descarta sin efectos.

## 2026-10-03 — Capa de datos provisoria y UI jugable

- **El estado vive detrás de la interfaz `PartyStore`** (`src/server/ports.ts`). Hoy hay una implementación en memoria para poder jugar el MVP ya; Supabase será otra implementación con las mismas firmas. Ni el dominio ni la UI se tocan.
- **El servidor es el reloj.** `tick()` corre en cada lectura/escritura y ejecuta las transiciones cuyo deadline venció. Así no hay timers corriendo en ningún lado y la partida no se traba si nadie mira.
- **Polling cada 1,5 s en vez de Realtime.** Es provisorio y está aislado en `usePoll`. Con 3 fiestas de 40 invitados no hace falta más, y permite verificar todo por HTTP.
- **Los ids de las acciones y el estado viven en el servidor; el cliente solo pide.** Los tokens del anfitrión se guardan en el navegador (sin cuentas en esta etapa).
- **Sin `next/font/google`** (ya decidido): se usa el stack del sistema para que el build no dependa de internet.
- **Importación de playlists en tres niveles**: Data API con `YOUTUBE_API_KEY` → scraping de la página pública → carga manual de temas. El plan pide pre-chequear duraciones y `embeddable`; sin clave no se puede, así que se asume reproduccible y el reproductor reporta el error en vivo (el dominio ya sabe saltear esos temas).
- **El reproductor nunca se oculta** (mínimo visual 200×200) y no se manda `Referrer-Policy: no-referrer`, por el error 153 de YouTube.
- **El smoke test llama a las server actions por HTTP**, como el navegador. Verifica el flujo completo y sirve igual contra la URL de preview de Vercel.
- **Topes del plan aplicados en el servidor**: 40 invitados por fiesta, 3 fiestas en vivo, 3 cartas propuestas por invitado, validación de largo de textos.

## 2026-10-04 — Deploys y verificación online

- **Preview por PR con Vercel**, conectado a la GitHub App de la cuenta (sin tokens compartidos).
- **El smoke test corre desde GitHub Actions y no desde la máquina de desarrollo**: los sandboxes de trabajo no tienen salida a `*.vercel.app`, y Actions sí. Así cada PR verifica la app deployada de verdad.
- **Si el preview está protegido por Deployment Protection, el workflow avisa con un warning** en vez de fallar: es una configuración de Vercel, no un bug de la app.
