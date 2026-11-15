
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
    createQueue,
    getQueue,
    nextTrack,
    updateQueue,
    setPlayer,
    setConnection
} = require("./queueManager");

const { getAudioStreamUrl } = require("./youtube");

// Processos de streaming ativos por servidor
const activeStreams = new Map();

// Impede que operações antigas iniciem músicas
// depois de /stop ou de uma nova reprodução
const generations = new Map();

function getGeneration(guildId) {
    return generations.get(guildId) || 0;
}

function invalidateGeneration(guildId) {
    const next = getGeneration(guildId) + 1;
    generations.set(guildId, next);
    return next;
}

function cleanupStream(guildId) {
    const stream = activeStreams.get(guildId);

    if (!stream) return;

    activeStreams.delete(guildId);

    stream.ffmpeg.stdout?.destroy();

    if (
        stream.ffmpeg.exitCode === null &&
        !stream.ffmpeg.killed
    ) {
        stream.ffmpeg.kill();
    }
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
            currentQueue.player !== player
        ) {
            return;
        }

        cleanupStream(guildId);

        updateQueue(guildId, {
            currentTrack: null,
            status: "idle"
        });

        playNext(guildId);
    });

    player.on("error", (error) => {
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

        updateQueue(guildId, {
            currentTrack: null,
            status: "idle"
        });

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

async function playTrack(guildId, track, generation) {
    const queue = getQueue(guildId);

    if (!queue || !queue.player) {
        throw new Error("Player não inicializado.");
    }

    if (!track || !track.url) {
        throw new Error("Música sem URL.");
    }

    const streamUrl = await getAudioStreamUrl(
        track.url
    );

    // Uma operação mais recente cancelou esta
    if (generation !== getGeneration(guildId)) {
        return null;
    }

    cleanupStream(guildId);

    const ffmpeg = spawn(
        ffmpegPath,
        [
            "-hide_banner",
            "-loglevel", "error",
            "-nostdin",
            "-i", streamUrl,
            "-vn",
            "-f", "s16le",
            "-ar", "48000",
            "-ac", "2",
            "pipe:1"
        ],
        {
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"]
        }
    );

    ffmpeg.on("error", (error) => {
        console.error(
            `❌ Falha ao executar FFmpeg (${guildId}):`,
            error
        );

        const current = activeStreams.get(guildId);

        if (current?.ffmpeg === ffmpeg) {
            queue.player.stop(true);
        }
    });

    ffmpeg.stderr.on("data", (data) => {
        console.error(
            `FFmpeg (${guildId}): ${data.toString()}`
        );
    });

    ffmpeg.on("close", (code) => {
        const current = activeStreams.get(guildId);

        if (current?.ffmpeg !== ffmpeg) {
            return;
        }

        if (code !== 0) {
            console.error(
                `⚠️ FFmpeg encerrado com código ${code}`
            );
        }
    });

    const resource = createAudioResource(
        ffmpeg.stdout,
        {
            inputType: StreamType.Raw,
            metadata: track,
            inlineVolume: true
        }
    );

    resource.volume.setVolume(0.7);

    activeStreams.set(guildId, {
        ffmpeg
    });

    updateQueue(guildId, {
        currentTrack: track,
        status: "playing"
    });

    queue.player.play(resource);

    console.log(
        `▶️ Reproduzindo: ${track.title}`
    );

    return track;
}

async function playNext(guildId) {
    const queue = getQueue(guildId);

    if (!queue || !queue.player) {
        return null;
    }

    const generation = invalidateGeneration(
        guildId
    );

    cleanupStream(guildId);

    while (generation === getGeneration(guildId)) {
        const track = nextTrack(guildId);

        if (!track) {
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

function stopPlayer(guildId) {
    // Cancela operações assíncronas pendentes
    invalidateGeneration(guildId);

    const queue = getQueue(guildId);

    if (!queue || !queue.player) {
        cleanupStream(guildId);
        return false;
    }

    const player = queue.player;

    // Remove o player antes de interromper,
    // evitando avanço automático da fila
    setPlayer(guildId, null);

    cleanupStream(guildId);

    updateQueue(guildId, {
        tracks: [],
        currentTrack: null,
        status: "idle"
    });

    player.stop(true);

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
    stopPlayer
};
