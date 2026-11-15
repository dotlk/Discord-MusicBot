
const { execFile } = require("node:child_process");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const YT_DLP = path.resolve(
    __dirname,
    "../../bin/yt-dlp.exe"
);

const FFMPEG = require("ffmpeg-static");

const MAX_PLAYLIST_TRACKS = 100;

const BASE_ARGS = [
    "--js-runtimes",
    `node:${process.execPath}`,
    "--ffmpeg-location",
    FFMPEG,
    "--no-warnings"
];

function isYouTubeUrl(value) {
    try {
        const url = new URL(value);

        return [
            "youtube.com",
            "www.youtube.com",
            "m.youtube.com",
            "music.youtube.com",
            "youtu.be",
            "www.youtu.be"
        ].includes(url.hostname);
    } catch {
        return false;
    }
}

function isYouTubePlaylist(value) {
    if (!isYouTubeUrl(value)) return false;

    const url = new URL(value);

    return Boolean(url.searchParams.get("list"));
}

async function runYtDlp(args, timeout = 60000) {
    const { stdout } = await execFileAsync(
        YT_DLP,
        [...BASE_ARGS, ...args],
        {
            timeout,
            maxBuffer: 30 * 1024 * 1024,
            windowsHide: true
        }
    );

    return stdout.trim();
}

function normalizeTrack(info) {
    if (!info?.id) return null;

    const id = info.id;

    return {
        id,
        title: info.title || "Sem título",
        author:
            info.artist ||
            info.uploader ||
            info.channel ||
            "Canal desconhecido",
        duration: info.duration || null,
        url: `https://www.youtube.com/watch?v=${id}`,
        thumbnail:
            info.thumbnail ||
            `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        requestedBy: null
    };
}

async function getVideoInfo(query) {
    if (typeof query !== "string" || !query.trim()) {
        throw new Error("Informe um nome ou link de música.");
    }

    const input = query.trim();

    let target = input;

    if (!isYouTubeUrl(input)) {
        try {
            const url = new URL(input);

            if (["http:", "https:"].includes(url.protocol)) {
                throw new Error(
                    "Por enquanto, somente links do YouTube são aceitos."
                );
            }
        } catch (error) {
            if (
                error.message ===
                "Por enquanto, somente links do YouTube são aceitos."
            ) {
                throw error;
            }
        }

        target = `ytsearch1:${input}`;
    }

    const output = await runYtDlp([
        "--no-playlist",
        "--no-download",
        "--dump-single-json",
        target
    ]);

    const result = JSON.parse(output);

    const info = Array.isArray(result.entries)
        ? result.entries[0]
        : result;

    const track = normalizeTrack(info);

    if (!track) {
        throw new Error(
            "Não foi possível encontrar essa música."
        );
    }

    return track;
}

async function getPlaylistInfo(url) {
    if (!isYouTubePlaylist(url)) {
        throw new Error("Link de playlist inválido.");
    }

    const parsed = new URL(url);
    const playlistId = parsed.searchParams.get("list");

    // Remove parâmetros do vídeo e usa somente a playlist.
    const playlistUrl =
        `https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`;

    const output = await runYtDlp([
        "--flat-playlist",
        "--playlist-end",
        String(MAX_PLAYLIST_TRACKS),
        "--no-download",
        "--dump-single-json",
        playlistUrl
    ], 120000);

    const playlist = JSON.parse(output);

    if (!Array.isArray(playlist.entries)) {
        throw new Error(
            "Não foi possível obter as músicas da playlist."
        );
    }

    const tracks = playlist.entries
        .map(normalizeTrack)
        .filter(Boolean);

    if (!tracks.length) {
        throw new Error(
            "A playlist está vazia ou não possui vídeos disponíveis."
        );
    }

    return {
        id: playlistId,
        title: playlist.title || "Playlist do YouTube",
        tracks,
        count: tracks.length,
        maxTracks: MAX_PLAYLIST_TRACKS,
        truncated: playlist.entries.length >= MAX_PLAYLIST_TRACKS
    };
}

async function getAudioStreamUrl(url) {
    if (!isYouTubeUrl(url)) {
        throw new Error("URL do YouTube inválida.");
    }

    const output = await runYtDlp([
        "--no-playlist",
        "--no-download",
        "--format",
        "bestaudio/best",
        "--get-url",
        url
    ]);

    const streamUrl = output.split(/\r?\n/)[0];

    if (!streamUrl?.startsWith("https://")) {
        throw new Error(
            "Não foi possível obter o fluxo de áudio."
        );
    }

    return streamUrl;
}

module.exports = {
    isYouTubeUrl,
    isYouTubePlaylist,
    getVideoInfo,
    getPlaylistInfo,
    getAudioStreamUrl
};
