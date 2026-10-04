#!/usr/bin/env node
/**
 * Smoke test de punta a punta contra un servidor corriendo.
 *
 * Llama a las server actions por HTTP igual que lo hace el navegador, así que
 * sirve tanto contra `npm run start` en local como contra la URL de preview de
 * Vercel. Verifica el flujo completo: crear la fiesta, cargar temas, arrancar,
 * entrar como invitado, votar y ver el resultado.
 *
 * Uso:
 *   npm run build && npm run start &
 *   node scripts/smoke.mjs http://localhost:3000
 *   node scripts/smoke.mjs https://mi-preview.vercel.app
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const BASE = process.argv[2] ?? "http://localhost:3000";

/* ------------------------------------------------------------------ */
/* Descubrir los ids de las server actions del build                  */
/* ------------------------------------------------------------------ */

function discoverActions() {
  const dir = join(process.cwd(), ".next/static/chunks");
  const actions = new Map();

  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".js")) continue;
    const source = readFileSync(join(dir, file), "utf8");
    const pattern = /createServerReference\)\("([0-9a-f]+)"[^)]*?"([A-Za-z][\w]*)"/g;

    let match;
    while ((match = pattern.exec(source)) !== null) {
      actions.set(match[2], match[1]);
    }
  }

  return actions;
}

let ACTIONS = discoverActions();

async function call(name, args, path = "/") {
  const id = ACTIONS.get(name);
  if (!id) throw new Error(`No encontré la acción ${name} en el build`);

  const response = await fetch(new URL(path, BASE), {
    method: "POST",
    headers: {
      "Next-Action": id,
      "Content-Type": "text/plain;charset=UTF-8",
      Accept: "text/x-component",
    },
    body: JSON.stringify(args),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${name} → HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  return { status: response.status, text };
}

/** El valor devuelto viene en el stream de RSC: se busca el primer JSON útil. */
function readResult(text) {
  for (const line of text.split("\n")) {
    const payload = line.replace(/^[0-9a-f]+:/, "").trim();
    if (payload === "null") return null;
    if (!payload.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(payload);
      if (parsed && typeof parsed === "object" && ("ok" in parsed || "partyId" in parsed)) {
        return parsed;
      }
    } catch {
      /* línea del stream que no es el resultado */
    }
  }
  return undefined;
}

async function action(name, args, path = "/", { allowNull = false } = {}) {
  const { text } = await call(name, args, path);
  const result = readResult(text);
  if (result === undefined || (result === null && !allowNull)) {
    throw new Error(`${name}: no pude leer la respuesta\n${text.slice(0, 400)}`);
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* El flujo                                                            */
/* ------------------------------------------------------------------ */

const check = (condition, message) => {
  if (condition) {
    console.log(`  ✓ ${message}`);
  } else {
    console.error(`  ✗ ${message}`);
    process.exitCode = 1;
  }
};

function videoId(seed) {
  return seed.padEnd(11, "0").slice(0, 11);
}

async function main() {
  console.log(`Smoke test contra ${BASE}\n`);
  ACTIONS = discoverActions();
  console.log(`Acciones encontradas: ${ACTIONS.size}`);

  console.log("\n1. Crear la fiesta");
  const created = await action("createParty", [{ name: "Fiesta smoke" }], "/host");
  check(created.ok === true, "la fiesta se creó");
  const { partyId, hostToken, code } = created;
  console.log(`  → código ${code}`);

  console.log("\n2. Cargar temas a mano (sin depender de la importación de YouTube)");
  for (const [list, name] of ["a", "b", "c"].entries()) {
    for (let i = 0; i < 3; i++) {
      const result = await action(
        "addManualTrack",
        [
          {
            partyId,
            hostToken,
            url: `https://www.youtube.com/watch?v=${videoId(`${list}${name}${i}smoke`)}`,
            title: `Lista ${name.toUpperCase()} tema ${i + 1}`,
            durationSec: 60,
            playlistTitle: `Lista ${name.toUpperCase()}`,
          },
        ],
        `/party/${partyId}`,
      );
      if (!result.ok) throw new Error(`no se pudo agregar el tema: ${result.error}`);
    }
  }
  check(true, "9 temas en 3 listas");

  console.log("\n3. Entrar dos invitados con el código");
  const vale = await action("joinParty", [{ code, nickname: "Vale" }], `/j/${code}`);
  const nacho = await action("joinParty", [{ code, nickname: "Nacho" }], `/j/${code}`);
  check(vale.ok && nacho.ok, "Vale y Nacho entraron");
  check(vale.partyId === partyId, "el invitado apunta a la misma fiesta");

  console.log("\n4. Arrancar la fiesta");
  const started = await action("startParty", [{ partyId, hostToken }], `/party/${partyId}`);
  check(started.ok === true, "arrancó");

  const view = await action("getHostView", [partyId, hostToken], `/party/${partyId}`);
  check(view?.phase === "playing", `fase: ${view?.phase}`);
  check(Boolean(view?.currentTrack), `suena: ${view?.currentTrack?.title}`);
  check(view?.guests?.length === 2, `${view?.guests?.length} invitados`);

  console.log("\n5. Simular el reproductor del anfitrión");
  const videoActual = view.currentTrack.videoId;
  const reported = await action(
    "reportPlayback",
    [{ partyId, hostToken, event: "started", videoId: videoActual }],
    `/party/${partyId}`,
  );
  check(reported.ok === true, "el reproductor reportó el inicio del tema");

  console.log("\n6. Votar (la ronda arranca sola por los ajustes por defecto)");
  let guestView = await action("getGuestView", [partyId, vale.guestId], `/j/${code}`);
  let intentos = 0;
  while (!guestView?.round && intentos++ < 5) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    guestView = await action("getGuestView", [partyId, vale.guestId], `/j/${code}`);
  }

  if (guestView?.round) {
    const options = guestView.round.options;
    console.log(`  → ronda con ${options.length} opciones: ${options.map((o) => o.title).join(" / ")}`);
    check(guestView.round.status === "open", "la votación está abierta");

    const voto = await action(
      "castVote",
      [{ partyId, guestId: vale.guestId, optionId: options[0].id }],
      `/j/${code}`,
    );
    check(voto.ok === true, "Vale votó");

    const cambio = await action(
      "castVote",
      [{ partyId, guestId: vale.guestId, optionId: options[1]?.id ?? options[0].id }],
      `/j/${code}`,
    );
    check(cambio.ok === true, "Vale cambió el voto");

    const after = await action("getHostView", [partyId, hostToken], `/party/${partyId}`);
    const votos = after.round.options.reduce((total, option) => total + option.votes, 0);
    check(votos === 1, `hay ${votos} voto contabilizado (un voto por persona)`);
    check(after.round.options[1]?.voters?.includes("Vale"), "el voto visible muestra el apodo");
  } else {
    check(false, "no se abrió la votación a tiempo");
  }

  console.log("\n7. Proponer una carta de acción");
  const propuesta = await action(
    "proposeCard",
    [{ partyId, guestId: vale.guestId, title: "Todos al centro", text: "Baile obligatorio", emoji: "💃" }],
    `/j/${code}`,
  );
  check(propuesta.ok === true, "la propuesta entró");

  const hostAfter = await action("getHostView", [partyId, hostToken], `/party/${partyId}`);
  check(hostAfter.pendingCards.length === 1, "el anfitrión la ve pendiente de aprobación");

  const aprobada = await action(
    "reviewCard",
    [{ partyId, hostToken, cardId: hostAfter.pendingCards[0].id, approve: true }],
    `/party/${partyId}`,
  );
  check(aprobada.ok === true, "el anfitrión la aprobó");

  console.log("\n8. Validaciones del servidor");
  const trucho = await action("getHostView", [partyId, "token-trucho"], `/party/${partyId}`, {
    allowNull: true,
  });
  check(trucho === null, "rechaza un token que no es del anfitrión");

  const fuera = await action(
    "castVote",
    [{ partyId, guestId: "no-estoy-en-la-fiesta", optionId: "pl:x" }],
    `/j/${code}`,
  );
  check(fuera.ok === false, "rechaza votos de gente que no está en la fiesta");

  console.log("\n9. Terminar la fiesta");
  const fin = await action("endParty", [{ partyId, hostToken }], `/party/${partyId}`);
  check(fin.ok === true, "el anfitrión la terminó");

  const final = await action("getHostView", [partyId, hostToken], `/party/${partyId}`);
  check(final.phase === "ended", `fase final: ${final.phase}`);

  console.log(
    process.exitCode ? "\n❌ Hubo fallas en el smoke test" : "\n✅ Smoke test completo: todo en verde",
  );
}

main().catch((error) => {
  console.error("\n💥 El smoke test se cortó:", error.message);
  process.exit(1);
});
