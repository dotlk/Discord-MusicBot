
const {
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    NoSubscriberBehavior,
    StreamType
} = require("@discordjs/voice");

const { spawn } = require("node:child_process");
const ffmpegPath = require("ffmpeg-static");

const {
    getYtDlpPath,
    getYtDlpEnv
} = require("./binaries");

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
const playbackPositions = new Map();

const seekRequests = new Map();
const seekSequences = new Map();

function getGeneration(guildId) {
    return generations.get(guildId) || 0;
}

function invalidateGeneration(guildId) {
    const next = getGeneration(guildId) + 1;
    generations.set(guildId, next);
    return next;
}

function getPlaybackPosition(guildId) {
    const state = playbackPositions.get(guildId);

    if (!state) return 0;

    return Math.floor(
        state.offsetMs +
        (state.resource?.playbackDuration || 0)
    );
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

// Encerra um fluxo específico sem alterar o Map
function destroyStream(stream) {
    if (!stream) return;

    stream.ytDlp.stdout?.unpipe(
        stream.ffmpeg.stdin
    );

    stream.ytDlp.stdout?.destroy();
    stream.ffmpeg.stdin?.destroy();
    stream.ffmpeg.stdout?.destroy();

    terminateProcess(stream.ytDlp);
    terminateProcess(stream.ffmpeg);
}

// Encerra o fluxo atualmente registrado
function cleanupStream(guildId) {
    const stream = activeStreams.get(guildId);
    if (!stream) return;

    activeStreams.delete(guildId);
    destroyStream(stream);
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
        playbackPositions.delete(guildId);

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
    generation,
    startSeconds = 0,
    preserveExistingStream = false
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

    if (
        !Number.isFinite(startSeconds) ||
        startSeconds < 0
    ) {
        throw new Error(
            "Posição de reprodução inválida."
        );
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

    if (
        generation !== getGeneration(guildId)
    ) {
        return null;
    }

    // Guarda o fluxo anterior durante o seek
    const previousStream = preserveExistingStream
        ? activeStreams.get(guildId)
        : null;

    if (!preserveExistingStream) {
        cleanupStream(guildId);
    }

    // ==============================
    // YT-DLP
    // ==============================
    const ytDlpArgs = [
        "--js-runtimes",
        `node:${process.execPath}`,
        "--ffmpeg-location",
        ffmpegPath,
        "--no-playlist",
        "--no-warnings",
        "--no-progress",
        "--format",
        "bestaudio/best"
    ];

    if (startSeconds > 0) {
        ytDlpArgs.push(
            "--download-sections",
            `*${startSeconds}-`
        );
    }

    ytDlpArgs.push(
        "--output",
        "-",
        track.url
    );

    const ytDlp = spawn(
        ytDlpPath,
        ytDlpArgs,
        {
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
            env: getYtDlpEnv()
        }
    );

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

    playbackPositions.set(guildId, {
        offsetMs: startSeconds * 1000,
        resource
    });

    updateQueue(guildId, {
        currentTrack: track,
        status: "playing"
    });

    // Substitui diretamente o recurso anterior
    queue.player.play(resource);

    // O novo recurso assumiu a reprodução.
    // Agora podemos encerrar o fluxo anterior.
    if (
        previousStream &&
        previousStream !== stream
    ) {
        destroyStream(previousStream);
    }

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

    // Invalida qualquer seek pendente
    seekRequests.delete(guildId);

    const generation =
        invalidateGeneration(guildId);

    cleanupStream(guildId);
    playbackPositions.delete(guildId);

    while (
        generation === getGeneration(guildId)
    ) {
        const track = nextTrack(guildId);

        if (!track) {
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

    // Invalida qualquer seek pendente
    seekRequests.delete(guildId);

    invalidateGeneration(guildId);
    cleanupStream(guildId);
    playbackPositions.delete(guildId);

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

async function seekTrack(guildId, positionSeconds) {
    const queue = getQueue(guildId);

    if (
        !queue?.player ||
        !queue.currentTrack ||
        !Number.isFinite(positionSeconds) ||
        positionSeconds < 0
    ) {
        return false;
    }

    const player = queue.player;
    const track = queue.currentTrack;

    const previousSeek =
        seekRequests.get(guildId);

    if (
        player.state.status === AudioPlayerStatus.Idle &&
        !previousSeek
    ) {
        return false;
    }

    if (
        Number.isFinite(track.duration) &&
        track.duration > 0 &&
        positionSeconds >= track.duration
    ) {
        return false;
    }

    // Preserva o estado original de pausa
    const wasPaused = previousSeek
        ? previousSeek.wasPaused
        : player.state.status === AudioPlayerStatus.Paused;

    // Identificador exclusivo desta solicitação
    const seekId =
        (seekSequences.get(guildId) || 0) + 1;

    seekSequences.set(guildId, seekId);

    seekRequests.set(guildId, {
        id: seekId,
        wasPaused
    });

    // Invalida as operações anteriores
    const generation =
        invalidateGeneration(guildId);

    try {
        // Não usamos player.stop().
        // O novo recurso substitui diretamente o atual.
        await playTrack(
            guildId,
            track,
            generation,
            positionSeconds,
            true
        );

        const latestSeek =
            seekRequests.get(guildId);

        // Só o seek mais recente pode finalizar
        if (
            !latestSeek ||
            latestSeek.id !== seekId ||
            generation !== getGeneration(guildId)
        ) {
            return false;
        }

        if (wasPaused) {
            player.pause();
        }

        seekRequests.delete(guildId);

        console.log(
            `⏩ Seek: ${track.title} → ${positionSeconds}s`
        );

        return true;
    } catch (error) {
        const latestSeek =
            seekRequests.get(guildId);

        // Um seek antigo não pode interferir no atual
        if (
            !latestSeek ||
            latestSeek.id !== seekId ||
            generation !== getGeneration(guildId)
        ) {
            return false;
        }

        console.error(
            `Erro ao reposicionar música (${guildId}):`,
            error
        );

        seekRequests.delete(guildId);

        cleanupStream(guildId);
        playbackPositions.delete(guildId);

        updateQueue(guildId, {
            status: "idle"
        });

        return false;
    }
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

    // Invalida qualquer seek pendente
    seekRequests.delete(guildId);

    invalidateGeneration(guildId);

    const queue = getQueue(guildId);

    if (!queue?.player) {
        cleanupStream(guildId);
        playbackPositions.delete(guildId);
        clearMusicStatus(guildId);
        return false;
    }

    const player = queue.player;

    setPlayer(guildId, null);
    cleanupStream(guildId);
    playbackPositions.delete(guildId);

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
    stopPlayer,
    seekTrack,
    getPlaybackPosition
};
