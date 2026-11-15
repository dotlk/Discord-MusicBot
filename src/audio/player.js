
const {
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    NoSubscriberBehavior,
    StreamType
} = require("@discordjs/voice");

const { spawn } = require("node:child_process");
const ffmpegPath = require("ffmpeg-static");
const { getYtDlpPath } = require("./binaries");
const { getVideoInfo } = require("./youtube");

const {
    createQueue,
    getQueue,
    nextTrack,
    updateQueue,
    setPlayer,
    setConnection,
    prioritizeTrack
} = require("./queueManager");

const {
    updateMusicStatus,
    clearMusicStatus
} = require("../discord/musicStatus");

const ytDlpPath = getYtDlpPath();

const activeStreams = new Map();
const generations = new Map();
const bypassLoop = new Set();

function getGeneration(guildId) {
    return generations.get(guildId) || 0;
}

function invalidateGeneration(guildId) {
    const next = getGeneration(guildId) + 1;
    generations.set(guildId, next);
    return next;
}

function terminateProcess(child) {
    if (!child) return;

    if (
        child.exitCode === null &&
        child.signalCode === null
    ) {
        try {
            child.kill();
        } catch (error) {
            console.error(
                "Erro ao encerrar processo:",
                error
            );
        }
    }
}

function cleanupStream(guildId) {
    const stream = activeStreams.get(guildId);
    if (!stream) return;

    activeStreams.delete(guildId);

    stream.ytDlp.stdout?.unpipe(
        stream.ffmpeg.stdin
    );

    stream.ytDlp.stdout?.destroy();
    stream.ffmpeg.stdin?.destroy();
    stream.ffmpeg.stdout?.destroy();

    terminateProcess(stream.ytDlp);
    terminateProcess(stream.ffmpeg);
}

function getOrCreatePlayer(guildId) {
    const queue = createQueue(guildId);

    if (queue.player) {
        return queue.player;
    }

    const player = createAudioPlayer({
        behaviors: {
            noSubscriber: NoSubscriberBehavior.Pause
        }
    });

    player.on(AudioPlayerStatus.Idle, () => {
        const currentQueue = getQueue(guildId);

        if (
            !currentQueue ||
            currentQueue.player !== player ||
            !currentQueue.currentTrack
        ) {
            return;
        }

        cleanupStream(guildId);

        const manualTransition =
            bypassLoop.delete(guildId);

        if (
            currentQueue.loop &&
            !manualTransition
        ) {
            const generation =
                invalidateGeneration(guildId);

            void playTrack(
                guildId,
                currentQueue.currentTrack,
                generation
            ).catch(error => {
                console.error(
                    `Erro ao repetir música (${guildId}):`,
                    error
                );

                const latest = getQueue(guildId);

                if (
                    !latest ||
                    generation !== getGeneration(guildId)
                ) {
                    return;
                }

                updateQueue(guildId, {
                    currentTrack: null,
                    status: "idle"
                });

                void playNext(guildId)
                    .catch(console.error);
            });

            return;
        }

        updateQueue(guildId, {
            currentTrack: null,
            status: "idle"
        });

        void playNext(guildId).catch(error => {
            console.error(
                `❌ Erro ao avançar fila (${guildId}):`,
                error
            );

            clearMusicStatus(guildId);
        });
    });

    player.on("error", error => {
        console.error(
            `❌ Erro no player ${guildId}:`,
            error
        );

        const currentQueue = getQueue(guildId);

        if (
            !currentQueue ||
            currentQueue.player !== player
        ) {
            return;
        }

        cleanupStream(guildId);

        bypassLoop.add(guildId);
        player.stop(true);
    });

    setPlayer(guildId, player);

    console.log(
        `🎵 Player criado para o servidor ${guildId}`
    );

    return player;
}

function attachPlayer(guildId, connection) {
    const player = getOrCreatePlayer(guildId);

    setConnection(guildId, connection);
    connection.subscribe(player);

    console.log(
        `🔊 Player conectado ao servidor ${guildId}`
    );

    return player;
}

async function playTrack(
    guildId,
    track,
    generation
) {
    const queue = getQueue(guildId);

    if (!queue?.player) {
        throw new Error(
            "Player não inicializado."
        );
    }

    if (
        !track?.url &&
        !track?.spotifySearchQuery
    ) {
        throw new Error(
            "Música sem URL."
        );
    }

    if (
        generation !== getGeneration(guildId)
    ) {
        return null;
    }

    // ==============================
    // SPOTIFY → YOUTUBE
    // ==============================
    if (track.spotifySearchQuery) {
        const resolved = await getVideoInfo(
            track.spotifySearchQuery
        );

        if (
            generation !== getGeneration(guildId)
        ) {
            return null;
        }

        track = {
            ...resolved,
            spotify: track.spotify,
            requestedBy: track.requestedBy,
            spotifySearchQuery:
                track.spotifySearchQuery
        };
    }

    cleanupStream(guildId);

    // ==============================
    // YT-DLP
    // ==============================
    const ytDlp = spawn(ytDlpPath, [
        "--js-runtimes",
        `node:${process.execPath}`,
        "--ffmpeg-location",
        ffmpegPath,
        "--no-playlist",
        "--no-warnings",
        "--no-progress",
        "--format",
        "bestaudio/best",
        "--output",
        "-",
        track.url
    ], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
    });

    // ==============================
    // FFMPEG
    // ==============================
    const ffmpeg = spawn(ffmpegPath, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-i",
        "pipe:0",
        "-vn",
        "-f",
        "s16le",
        "-ar",
        "48000",
        "-ac",
        "2",
        "pipe:1"
    ], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
    });

    ytDlp.stdout.pipe(ffmpeg.stdin);

    const stream = {
        ytDlp,
        ffmpeg
    };

    activeStreams.set(guildId, stream);

    function isCurrentStream() {
        return (
            activeStreams.get(guildId) === stream &&
            generation === getGeneration(guildId)
        );
    }

    function failStream(source, error) {
        if (!isCurrentStream()) return;

        console.error(
            `❌ Erro no ${source} (${guildId}):`,
            error
        );

        cleanupStream(guildId);

        const currentQueue = getQueue(guildId);

        if (
            currentQueue?.player === queue.player
        ) {
            currentQueue.player.stop(true);
        }
    }

    ytDlp.on("error", error => {
        failStream("yt-dlp", error);
    });

    ffmpeg.on("error", error => {
        failStream("FFmpeg", error);
    });

    ytDlp.stdout.on("error", error => {
        if (error.code !== "EPIPE") {
            failStream(
                "stdout do yt-dlp",
                error
            );
        }
    });

    ffmpeg.stdin.on("error", error => {
        if (
            error.code !== "EPIPE" &&
            error.code !== "ERR_STREAM_DESTROYED"
        ) {
            failStream(
                "stdin do FFmpeg",
                error
            );
        }
    });

    ytDlp.stderr.on("data", data => {
        if (!isCurrentStream()) return;

        const message =
            data.toString().trim();

        if (message) {
            console.error(
                `yt-dlp (${guildId}): ${message}`
            );
        }
    });

    ffmpeg.stderr.on("data", data => {
        if (!isCurrentStream()) return;

        const message =
            data.toString().trim();

        if (message) {
            console.error(
                `FFmpeg (${guildId}): ${message}`
            );
        }
    });

    ytDlp.on("close", code => {
        if (
            isCurrentStream() &&
            code !== 0
        ) {
            failStream(
                "yt-dlp",
                new Error(
                    `Processo encerrado com código ${code}`
                )
            );
        }
    });

    ffmpeg.on("close", code => {
        if (
            isCurrentStream() &&
            code !== 0
        ) {
            failStream(
                "FFmpeg",
                new Error(
                    `Processo encerrado com código ${code}`
                )
            );
        }
    });

    // ==============================
    // RECURSO DE ÁUDIO
    // ==============================
    const resource = createAudioResource(
        ffmpeg.stdout,
        {
            inputType: StreamType.Raw,
            metadata: track,
            inlineVolume: true
        }
    );

    resource.volume.setVolume(0.7);

    updateQueue(guildId, {
        currentTrack: track,
        status: "playing"
    });

    queue.player.play(resource);

    // ==============================
    // ATUALIZA ATIVIDADE DO DISCORD
    // ==============================
    updateMusicStatus(guildId, track);

    console.log(
        `▶️ Reproduzindo: ${track.title}`
    );

    return track;
}

async function playNext(guildId) {
    const queue = getQueue(guildId);

    if (!queue?.player) {
        clearMusicStatus(guildId);
        return null;
    }

    const generation =
        invalidateGeneration(guildId);

    cleanupStream(guildId);

    while (
        generation === getGeneration(guildId)
    ) {
        const track = nextTrack(guildId);

        if (!track) {
            // ==============================
            // FILA FINALIZADA
            // ==============================
            clearMusicStatus(guildId);

            console.log(
                `⏹️ Fila finalizada: ${guildId}`
            );

            return null;
        }

        try {
            return await playTrack(
                guildId,
                track,
                generation
            );
        } catch (error) {
            console.error(
                `❌ Erro ao reproduzir ${track.title}:`,
                error
            );

            if (
                generation !== getGeneration(guildId)
            ) {
                return null;
            }

            updateQueue(guildId, {
                currentTrack: null,
                status: "idle"
            });
        }
    }

    return null;
}

function skipTrack(guildId) {
    const queue = getQueue(guildId);

    if (
        !queue?.player ||
        !queue.currentTrack
    ) {
        return false;
    }

    const player = queue.player;
    const skippedTitle =
        queue.currentTrack.title;

    invalidateGeneration(guildId);
    cleanupStream(guildId);

    const wasActive =
        player.state.status !==
        AudioPlayerStatus.Idle;

    if (wasActive) {
        bypassLoop.add(guildId);
        player.stop(true);
    } else {
        updateQueue(guildId, {
            currentTrack: null,
            status: "idle"
        });

        void playNext(guildId).catch(error => {
            console.error(
                `❌ Erro ao pular música (${guildId}):`,
                error
            );

            clearMusicStatus(guildId);
        });
    }

    console.log(
        `⏭️ Música pulada: ${skippedTitle}`
    );

    return true;
}

function playPrioritizedNow(
    guildId,
    position
) {
    const queue = getQueue(guildId);

    if (
        !queue?.player ||
        !queue.currentTrack
    ) {
        return null;
    }

    if (
        !Number.isInteger(position) ||
        position < 1 ||
        position > queue.tracks.length
    ) {
        return null;
    }

    const result = prioritizeTrack(
        guildId,
        position,
        true
    );

    if (!result) {
        return null;
    }

    if (!skipTrack(guildId)) {
        updateQueue(guildId, {
            tracks: queue.tracks,
            currentTrack: queue.currentTrack,
            status: queue.status
        });

        return null;
    }

    return result;
}

function stopPlayer(guildId) {
    bypassLoop.delete(guildId);
    invalidateGeneration(guildId);

    const queue = getQueue(guildId);

    if (!queue?.player) {
        cleanupStream(guildId);
        clearMusicStatus(guildId);
        return false;
    }

    const player = queue.player;

    setPlayer(guildId, null);
    cleanupStream(guildId);

    updateQueue(guildId, {
        tracks: [],
        currentTrack: null,
        status: "idle"
    });

    player.stop(true);

    // ==============================
    // REMOVE ATIVIDADE DO SERVIDOR
    // ==============================
    clearMusicStatus(guildId);

    console.log(
        `⏹️ Reprodução interrompida: ${guildId}`
    );

    return true;
}

module.exports = {
    getOrCreatePlayer,
    attachPlayer,
    playTrack,
    playNext,
    skipTrack,
    playPrioritizedNow,
    stopPlayer
};
