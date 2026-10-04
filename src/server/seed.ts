/**
 * Mazo de cartas de acción preset (global).
 *
 * Redacción sin promover el consumo: el brindis es "con lo que tengas" y las
 * cartas que mencionan bebida aclaran que es opcional.
 */

import type { ActionCard } from "@/domain/types";

export type PresetCard = Omit<ActionCard, "origin" | "status" | "proposedBy">;

export const PRESET_CARDS: PresetCard[] = [
  {
    id: "preset-karaoke",
    title: "Karaoke obligatorio",
    text: "El que propuso el último tema canta el estribillo que elija la mesa.",
    durationSec: 90,
    emoji: "🎤",
  },
  {
    id: "preset-brindis",
    title: "Brindis general",
    text: "Todos brindan con lo que tengan a mano. El anfitrión dice por qué.",
    durationSec: 60,
    emoji: "🥂",
  },
  {
    id: "preset-baile",
    title: "Pista de baile",
    text: "Todos al centro. El primer tema del próximo bloque no se rechaza.",
    durationSec: 120,
    emoji: "💃",
  },
  {
    id: "preset-selfie",
    title: "Selfie grupal",
    text: "Se junta todo el mundo y el anfitrión saca una foto. Va al chat de la fiesta.",
    durationSec: 60,
    emoji: "📸",
  },
  {
    id: "preset-anecdota",
    title: "Confesión",
    text: "Cada invitado dice en una frase qué tema va a pedir cuando le toque elegir.",
    durationSec: 90,
    emoji: "🤫",
  },
  {
    id: "preset-piedra",
    title: "Batalla de playback",
    text: "Dos voluntarios actúan el próximo tema como si fuera su show.",
    durationSec: 120,
    emoji: "🎭",
  },
  {
    id: "preset-cambio",
    title: "Intercambio de puestos",
    text: "Todos se sientan en otro lugar y el que queda parado elige tema para el próximo bloque.",
    durationSec: 90,
    emoji: "🪑",
  },
  {
    id: "preset-pregunta",
    title: "Pregunta incómoda",
    text: "El invitado con más votos en la última ronda responde una pregunta que elija la mesa.",
    durationSec: 60,
    emoji: "❓",
  },
];
