
const { execFile } = require("node:child_process");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const YT_DLP = path.resolve(
    __dirname,
    "../../bin/yt-dlp.exe"
);

const FFMPEG = require("ffmpeg-static");

const BASE_ARGS = [
    "--js-runtimes",
    `node:${process.execPath}`,
    "--ffmpeg-location",
    FFMPEG,
    "--no-playlist",
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

async function runYtDlp(args) {
    const { stdout } = await execFileAsync(
        YT_DLP,
        [...BASE_ARGS, ...args],
        {
            timeout: 60000,
            maxBuffer: 10 * 1024 * 1024,
            windowsHide: true
        }
    );

    return stdout.trim();
}

async function getVideoInfo(url) {
    if (!isYouTubeUrl(url)) {
        throw new Error("URL do YouTube inválida.");
    }

    const output = await runYtDlp([
        "--no-download",
        "--dump-single-json",
        url
    ]);

    const info = JSON.parse(output);

    if (!info || !info.id) {
        throw new Error(
            "Não foi possível obter os dados do vídeo."
        );
    }

    return {
        id: info.id,
        title: info.title,
        duration: info.duration,
        url: info.webpage_url,
        thumbnail: info.thumbnail,
        requestedBy: null
    };
}

async function getAudioStreamUrl(url) {
    if (!isYouTubeUrl(url)) {
        throw new Error("URL do YouTube inválida.");
    }

    const output = await runYtDlp([
        "--no-download",
        "--format",
        "bestaudio/best",
        "--get-url",
        url
    ]);

    const streamUrl = output.split(/\r?\n/)[0];

    if (!streamUrl || !streamUrl.startsWith("https://")) {
        throw new Error(
            "Não foi possível obter o fluxo de áudio."
        );
    }

    return streamUrl;
}

module.exports = {
    isYouTubeUrl,
    getVideoInfo,
    getAudioStreamUrl
};
