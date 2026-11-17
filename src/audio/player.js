const {
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    NoSubscriberBehavior,
    StreamType
} = require("@discordjs/voice");

const { spawn } = require("node:child_process");
const { Transform } = require("node:stream");
const { EventEmitter } = require("node:events");

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

// ==============================
// AUDIO VISUALIZER
// ==============================

const visualizerEvents = new EventEmitter();
visualizerEvents.setMaxListeners(0);

const VISUALIZER_SAMPLE_RATE = 48000;
const VISUALIZER_WINDOW_SIZE = 1024;
const VISUALIZER_INTERVAL = 50;

const VISUALIZER_FREQUENCIES = [
    60, 120, 250, 500,
    1000, 2000, 4000, 8000
];

function analyzeFrequencies(samples) {
    const bands = VISUALIZER_FREQUENCIES.map(frequency => {
        const omega =
            2 * Math.PI * frequency / VISUALIZER_SAMPLE_RATE;

        const coefficient = 2 * Math.cos(omega);

        let previous = 0;
        let previous2 = 0;

        for (let i = 0; i < samples.length; i++) {
            const current =
                samples[i] +
                coefficient * previous -
                previous2;

            previous2 = previous;
            previous = current;
        }

        const power =
            previous2 * previous2 +
            previous * previous -
            coefficient * previous * previous2;

        const magnitude =
            Math.sqrt(Math.max(0, power)) / samples.length;

        return Math.min(1, magnitude / 9000);
    });

    return bands;
}

function createVisualizerStream(guildId) {
    let pending = Buffer.alloc(0);
    let samples = [];
    let lastEmission = 0;

    return new Transform({
        transform(chunk, encoding, callback) {
            try {
                pending = Buffer.concat([pending, chunk]);

                // PCM s16le estéreo: 4 bytes por frame.
                const usableLength =
                    pending.length - (pending.length % 4);

                for (
                    let offset = 0;
                    offset < usableLength;
                    offset += 4
                ) {
                    const left = pending.readInt16LE(offset);
                    const right = pending.readInt16LE(offset + 2);

                    samples.push((left + right) / 2);

                    if (samples.length >= VISUALIZER_WINDOW_SIZE) {
                        const now = Date.now();

                        if (
                            now - lastEmission >=
                            VISUALIZER_INTERVAL
                        ) {
                            const bands =
                                analyzeFrequencies(samples);

                            visualizerEvents.emit("data", {
                                guildId,
                                bands,
                                timestamp: now
                            });

                            lastEmission = now;
                        }

                        samples = [];
                    }
                }

                pending = pending.subarray(usableLength);

                // Encaminha o áudio original sem alterações.
                callback(null, chunk);
            } catch (error) {
                // A análise não deve interromper a reprodução.
                callback(null, chunk);
            }
        }
    });
}

// ==============================
// CONTROLE DE GERAÇÕES
// ==============================

function getGeneration(guildId) {
    return generations.get(guildId) || 0;
}

function invalidateGeneration(guildId) {
    const next = getGeneration(guildId) + 1;
    generations.set(guildId, next);
    return next;
}

// ==============================
// POSIÇÃO DA MÚSICA
// ==============================

function getPlaybackPosition(guildId) {
    const state = playbackPositions.get(guildId);

    if (!state) return 0;

    return Math.floor(
        state.offsetMs +
        (state.resource?.playbackDuration || 0)
    );
}

// ==============================
// GERENCIAMENTO DE PROCESSOS
// ==============================

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

// Encerra um fluxo específico sem alterar o Map.
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

// Encerra o fluxo atualmente registrado.
function cleanupStream(guildId) {
    const stream = activeStreams.get(guildId);
    if (!stream) return;

    activeStreams.delete(guildId);
    destroyStream(stream);
}

// ==============================
// PLAYER
// ==============================

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

// ==============================
// REPRODUÇÃO
// ==============================

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

    // Mantém o fluxo anterior vivo durante o carregamento do seek.
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

    const ffmpegArgs = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-i",
        "pipe:0"
    ];

    // Faz o seek na saída do FFmpeg, decodificando desde o início.
    // Isso evita os cortes imprecisos que podem ocorrer com
    // --download-sections no fluxo de áudio do yt-dlp.
    if (startSeconds > 0) {
        ffmpegArgs.push(
            "-ss",
            String(startSeconds)
        );
    }

    ffmpegArgs.push(
        "-vn",
        "-f",
        "s16le",
        "-ar",
        "48000",
        "-ac",
        "2",
        "pipe:1"
    );

    const ffmpeg = spawn(
        ffmpegPath,
        ffmpegArgs,
        {
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"]
        }
    );

    const stream = {
        ytDlp,
        ffmpeg
    };

    activeStreams.set(guildId, stream);

    let seekCommitted = false;
    let startupSettled = false;
    let startupTimer = null;

    const firstAudio = new Promise((resolve, reject) => {
        const finish = (callback, value) => {
            if (startupSettled) return;

            startupSettled = true;

            if (startupTimer) {
                clearTimeout(startupTimer);
                startupTimer = null;
            }

            callback(value);
        };

        ffmpeg.stdout.once("data", () => {
            finish(resolve);
        });

        startupTimer = setTimeout(() => {
            const error = new Error(
                "Tempo esgotado ao preparar o áudio."
            );

            finish(reject, error);
            failStream("FFmpeg", error);
        }, 120000);

        stream.rejectStartup = error => {
            finish(reject, error);
        };
    });

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

        if (preserveExistingStream && !seekCommitted) {
            // O novo fluxo falhou antes de assumir o player.
            // Restaura o fluxo anterior sem interromper a música.
            if (previousStream) {
                activeStreams.set(guildId, previousStream);
            } else {
                activeStreams.delete(guildId);
            }

            destroyStream(stream);
            stream.rejectStartup?.(error);
            return;
        }

        cleanupStream(guildId);
        stream.rejectStartup?.(error);

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
        } else if (
            isCurrentStream() &&
            !startupSettled
        ) {
            failStream(
                "FFmpeg",
                new Error("O fluxo terminou sem fornecer áudio.")
            );
        }
    });

    // ==============================
    // RECURSO DE ÁUDIO
    // ==============================

    ytDlp.stdout.pipe(ffmpeg.stdin);

    const visualizerStream =
        createVisualizerStream(guildId);

    ffmpeg.stdout.pipe(visualizerStream);

    const resource = createAudioResource(
        visualizerStream,
        {
            inputType: StreamType.Raw,
            metadata: track,
            inlineVolume: true
        }
    );

    resource.volume.setVolume(0.7);

    // Só troca o recurso atual quando já existe áudio disponível.
    await firstAudio;

    if (
        generation !== getGeneration(guildId) ||
        activeStreams.get(guildId) !== stream
    ) {
        return null;
    }

    playbackPositions.set(guildId, {
        offsetMs: startSeconds * 1000,
        resource
    });

    updateQueue(guildId, {
        currentTrack: track,
        status: "playing"
    });

    queue.player.play(resource);
    seekCommitted = true;

    // O fluxo anterior só é encerrado depois que o novo assumiu.
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

// ==============================
// PRÓXIMA MÚSICA
// ==============================

async function playNext(guildId) {
    const queue = getQueue(guildId);

    if (!queue?.player) {
        clearMusicStatus(guildId);
        return null;
    }

    // Invalida qualquer seek pendente.
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

// ==============================
// PULAR MÚSICA
// ==============================

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

    // Invalida qualquer seek pendente.
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

// ==============================
// SEEK
// ==============================

async function seekTrack(guildId, positionSeconds) {
    const queue = getQueue(guildId);

    if (
        !queue?.player ||
        !queue.currentTrack ||
        !Number.isFinite(positionSeconds) ||
        positionSeconds < 0 ||
        seekRequests.has(guildId)
    ) {
        return false;
    }

    const player = queue.player;
    const track = queue.currentTrack;

    if (
        Number.isFinite(track.duration) &&
        track.duration > 0 &&
        positionSeconds >= track.duration
    ) {
        return false;
    }

    const originalStatus = player.state.status;

    if (
        originalStatus !== AudioPlayerStatus.Playing &&
        originalStatus !== AudioPlayerStatus.Paused &&
        originalStatus !== AudioPlayerStatus.AutoPaused
    ) {
        return false;
    }

    const wasPaused =
        originalStatus === AudioPlayerStatus.Paused ||
        originalStatus === AudioPlayerStatus.AutoPaused;

    const seekId =
        (seekSequences.get(guildId) || 0) + 1;

    seekSequences.set(guildId, seekId);

    seekRequests.set(guildId, {
        id: seekId,
        wasPaused
    });

    // Pausa imediatamente e mantém o fluxo antigo disponível.
    if (!wasPaused) {
        player.pause();
    }

    const generation =
        invalidateGeneration(guildId);

    try {
        const result = await playTrack(
            guildId,
            track,
            generation,
            positionSeconds,
            true
        );

        const latestSeek =
            seekRequests.get(guildId);

        if (
            !latestSeek ||
            latestSeek.id !== seekId ||
            generation !== getGeneration(guildId)
        ) {
            return false;
        }

        if (!result) {
            throw new Error("O novo fluxo de áudio não ficou pronto.");
        }

        // Preserva uma pausa que já existia antes do seek.
        // Se estava tocando, playTrack já iniciou a nova posição.
        if (wasPaused) {
            player.pause();
        }

        seekRequests.delete(guildId);

        console.log(
            `⏩ Seek: ${track.title} → ${positionSeconds.toFixed(2)}s`
        );

        return true;
    } catch (error) {
        const latestSeek =
            seekRequests.get(guildId);

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

        // O fluxo antigo continua disponível. Retoma apenas se
        // a música estava tocando antes de iniciar o seek.
        seekRequests.delete(guildId);

        if (!wasPaused) {
            player.unpause();
        }

        return false;
    }
}

function isSeekPending(guildId) {
    return seekRequests.has(guildId);
}

// ==============================
// REPRODUZIR MÚSICA PRIORIZADA
// ==============================

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

// ==============================
// PARAR PLAYER
// ==============================

function stopPlayer(guildId) {
    bypassLoop.delete(guildId);

    // Invalida qualquer seek pendente.
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

    // Remove atividade do servidor.
    clearMusicStatus(guildId);

    console.log(
        `⏹️ Reprodução interrompida: ${guildId}`
    );

    return true;
}

// ==============================
// EXPORTAÇÕES
// ==============================

module.exports = {
    getOrCreatePlayer,
    attachPlayer,
    playTrack,
    playNext,
    skipTrack,
    playPrioritizedNow,
    stopPlayer,
    seekTrack,
    isSeekPending,
    getPlaybackPosition,
    visualizerEvents
};