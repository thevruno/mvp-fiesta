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
