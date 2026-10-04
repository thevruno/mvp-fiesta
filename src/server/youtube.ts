/**
 * Importación de playlists de YouTube.
 *
 * Orden de preferencia:
 *  1. **Data API v3** (`YOUTUBE_API_KEY`): es el camino serio. Da título,
 *     duración y `status.embeddable` de cada tema, que es lo que el plan pide
 *     para descartar de antemano los no embebibles.
 *  2. **Scraping liviano** de la página pública de la playlist: sin clave, pero
 *     frágil. Igual sirve para no bloquear el MVP.
 *  3. Si nada funciona, la consola permite cargar el tema a mano.
 *
 * Nunca se usa `search.list` (100 unidades de cuota contra 1 de las demás).
 */

import { z } from "zod";
import type { Playlist, Track } from "@/domain/types";

const API = "https://www.googleapis.com/youtube/v3";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

export const youtubeConfigured = () => Boolean(process.env.YOUTUBE_API_KEY);

/* ------------------------------------------------------------------ */
/* Parseo de URLs                                                      */
/* ------------------------------------------------------------------ */

export interface ParsedUrl {
  kind: "playlist" | "video";
  id: string;
}

const VIDEO_ID = /^[\w-]{11}$/;
const LIST_ID = /^[\w-]{10,42}$/;

export function parseYouTubeUrl(input: string): ParsedUrl | null {
  const raw = input.trim();
  if (!raw) return null;

  // Si pegaron sólo el id.
  if (VIDEO_ID.test(raw)) return { kind: "video", id: raw };
  if (LIST_ID.test(raw) && !raw.includes(".")) return { kind: "playlist", id: raw };

  let url: URL;
  try {
    url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\.|^m\.|^music\./, "");
  if (!/(^|\.)youtube(-nocookie)?\.com$|^youtu\.be$/.test(host)) return null;

  const list = url.searchParams.get("list");
  const video = url.searchParams.get("v");
  const path = url.pathname.split("/").filter(Boolean);

  if (host === "youtu.be" && path[0] && VIDEO_ID.test(path[0])) {
    // Un link corto puede traer playlist: si la trae, gana la playlist.
    return list ? { kind: "playlist", id: list } : { kind: "video", id: path[0] };
  }
  if (path[0] === "playlist" && list) return { kind: "playlist", id: list };
  if (path[0] === "shorts" && path[1] && VIDEO_ID.test(path[1])) {
    return { kind: "video", id: path[1] };
  }
  if (path[0] === "embed" && path[1] && VIDEO_ID.test(path[1])) {
    return { kind: "video", id: path[1] };
  }
  if (video && VIDEO_ID.test(video)) {
    return list ? { kind: "playlist", id: list } : { kind: "video", id: video };
  }
  if (list) return { kind: "playlist", id: list };

  return null;
}

/* ------------------------------------------------------------------ */
/* Camino 1: Data API                                                  */
/* ------------------------------------------------------------------ */

async function dataApi<T>(path: string, params: Record<string, string>): Promise<T> {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) throw new Error("sin clave");

  const url = new URL(`${API}/${path}`);
  for (const [k, v] of Object.entries({ ...params, key })) url.searchParams.set(k, v);

  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    const body = await response.text();
    if (response.status === 403 && body.includes("quota")) {
      throw new Error("Se agotó la cuota diaria de YouTube Data API. Probá mañana.");
    }
    throw new Error(`YouTube Data API respondió ${response.status}`);
  }
  return (await response.json()) as T;
}

async function viaDataApi(parsed: ParsedUrl): Promise<Playlist> {
  if (parsed.kind === "video") {
    const data = await dataApi<{
      items?: {
        id: string;
        snippet: { title: string };
        contentDetails: { duration: string };
        status: { embeddable: boolean };
      }[];
    }>("videos", { part: "snippet,contentDetails,status", id: parsed.id });

    const item = data.items?.[0];
    if (!item) throw new Error("No se encontró el video");

    return {
      id: parsed.id,
      title: item.snippet.title,
      maxMinutes: null,
      played: false,
      tracks: [
        {
          videoId: item.id,
          title: item.snippet.title,
          durationSec: parseIsoDuration(item.contentDetails.duration),
          embeddable: item.status.embeddable !== false,
        },
      ],
    };
  }

  const meta = await dataApi<{ items?: { snippet: { title: string } }[] }>("playlists", {
    part: "snippet",
    id: parsed.id,
  });
  const title = meta.items?.[0]?.snippet.title;
  if (!title) throw new Error("La playlist no existe o es privada");

  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = await dataApi<{
      nextPageToken?: string;
      items?: { contentDetails: { videoId: string } }[];
    }>("playlistItems", {
      part: "contentDetails",
      playlistId: parsed.id,
      maxResults: "50",
      ...(pageToken ? { pageToken } : {}),
    });
    for (const item of page.items ?? []) ids.push(item.contentDetails.videoId);
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length < 300);

  if (ids.length === 0) throw new Error("La playlist está vacía");

  const tracks: Track[] = [];
  // videos.list acepta hasta 50 ids por llamada y cuesta 1 unidad.
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const data = await dataApi<{
      items?: {
        id: string;
        snippet: { title: string };
        contentDetails: { duration: string };
        status: { embeddable: boolean };
      }[];
    }>("videos", { part: "snippet,contentDetails,status", id: chunk.join(",") });

    const byId = new Map((data.items ?? []).map((item) => [item.id, item]));
    for (const id of chunk) {
      const item = byId.get(id);
      // Los videos que ya no están (borrados/privados) se descartan.
      if (!item) continue;
      tracks.push({
        videoId: id,
        title: item.snippet.title,
        durationSec: parseIsoDuration(item.contentDetails.duration),
        embeddable: item.status.embeddable !== false,
      });
    }
  }

  return { id: parsed.id, title, maxMinutes: null, played: false, tracks };
}

/** PT1H2M3S → 3723 */
export function parseIsoDuration(iso: string): number {
  const match = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!match) return 0;
  const [, d, h, m, s] = match;
  return (
    (Number(d ?? 0) * 86400) + Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0)
  );
}

/* ------------------------------------------------------------------ */
/* Camino 2: scraping de la página pública                             */
/* ------------------------------------------------------------------ */

interface ScrapedTrack {
  videoId: string;
  title: string;
  durationSec: number;
}

/** Extrae los temas del bloque `playlistVideoRenderer` de ytInitialData. */
export function extractTracksFromHtml(html: string): ScrapedTrack[] {
  const tracks: ScrapedTrack[] = [];
  const seen = new Set<string>();
  const marker = /"playlistVideoRenderer":\{"videoId":"([\w-]{11})"/g;

  let match: RegExpExecArray | null;
  while ((match = marker.exec(html)) !== null) {
    const videoId = match[1];
    if (seen.has(videoId)) continue;

    // Los datos del tema vienen en los caracteres siguientes.
    const window = html.slice(match.index, match.index + 2500);
    const length = /"lengthSeconds":"(\d+)"/.exec(window);
    const title =
      /"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/.exec(window) ??
      /"title":\{"simpleText":"((?:[^"\\]|\\.)*)"/.exec(window);

    if (!title) continue;
    seen.add(videoId);
    tracks.push({
      videoId,
      title: unescapeText(title[1]),
      durationSec: length ? Number(length[1]) : 0,
    });
  }

  return tracks;
}

function unescapeText(text: string): string {
  return text
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
    .replace(/\\n/g, " ");
}

export function extractTitleFromHtml(html: string): string | null {
  const og = /<meta property="og:title" content="([^"]+)"/.exec(html);
  if (og) return unescapeText(og[1]);
  const title = /<title>([^<]+)<\/title>/.exec(html);
  return title ? unescapeText(title[1]).replace(/\s*-\s*YouTube$/, "") : null;
}

async function viaScrape(parsed: ParsedUrl): Promise<Playlist> {
  const target =
    parsed.kind === "playlist"
      ? `https://www.youtube.com/playlist?list=${parsed.id}`
      : `https://www.youtube.com/watch?v=${parsed.id}`;

  let response: Response;
  try {
    response = await fetch(target, {
      headers: { "user-agent": UA, "accept-language": "es-AR,es;q=0.9,en;q=0.8" },
      cache: "no-store",
    });
  } catch {
    throw new Error(
      "No se pudo consultar YouTube desde el servidor. Configurá YOUTUBE_API_KEY o cargá el tema a mano.",
    );
  }

  if (!response.ok) throw new Error(`YouTube respondió ${response.status}`);

  const html = await response.text();

  if (parsed.kind === "video") {
    const title = extractTitleFromHtml(html) ?? "Tema sin título";
    const length = /"lengthSeconds":"(\d+)"/.exec(html);
    return {
      id: parsed.id,
      title,
      maxMinutes: null,
      played: false,
      tracks: [
        {
          videoId: parsed.id,
          title,
          durationSec: length ? Number(length[1]) : 0,
          // Sin Data API no se puede pre-chequear el permiso de embed: se asume
          // que sí y el reproductor reporta el error 101/150 si no lo permite.
          embeddable: true,
        },
      ],
    };
  }

  const title = extractTitleFromHtml(html);
  const scraped = extractTracksFromHtml(html);
  if (!title || scraped.length === 0) {
    throw new Error(
      "No se pudieron leer los temas de esa playlist (YouTube cambió la página o es privada). Configurá YOUTUBE_API_KEY o cargá el tema a mano.",
    );
  }

  return {
    id: parsed.id,
    title,
    maxMinutes: null,
    played: false,
    tracks: scraped.map((t) => ({
      videoId: t.videoId,
      title: t.title,
      durationSec: t.durationSec,
      embeddable: true,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Fachada                                                             */
/* ------------------------------------------------------------------ */

export interface ImportResult {
  playlist: Playlist;
  /** Temas embebibles (los que realmente van a sonar). */
  playable: number;
  /** Temas descartados por no ser embebibles o por tener duración inválida. */
  skipped: number;
  source: "data-api" | "scrape";
}

export async function fetchPlaylist(input: string): Promise<ImportResult> {
  const parsed = parseYouTubeUrl(input);
  if (!parsed) {
    throw new Error("Pegá el link de una playlist de YouTube (o el de un video)");
  }

  let result: { playlist: Playlist; source: ImportResult["source"] };

  if (youtubeConfigured()) {
    try {
      result = { playlist: await viaDataApi(parsed), source: "data-api" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      // Si la clave falla, se intenta el camino liviano antes de rendirse.
      if (message.includes("cuota")) throw error;
      result = { playlist: await viaScrape(parsed), source: "scrape" };
    }
  } else {
    result = { playlist: await viaScrape(parsed), source: "scrape" };
  }

  const playable = result.playlist.tracks.filter(
    (t) => t.embeddable && t.durationSec > 0,
  ).length;
  const skipped = result.playlist.tracks.length - playable;

  if (playable === 0) {
    throw new Error(
      "Ningún tema de esa lista se puede reproducir embebido (o no se pudieron leer las duraciones)",
    );
  }

  return {
    playlist: { ...result.playlist, tracks: result.playlist.tracks },
    playable,
    skipped,
    source: result.source,
  };
}

export const manualTrackSchema = z.object({
  url: z.string().trim().min(1),
  title: z.string().trim().min(1).max(120),
  durationSec: z.coerce.number().int().min(5).max(3600),
});
