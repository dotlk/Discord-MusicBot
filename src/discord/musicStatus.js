
const { ActivityType } = require("discord.js");
const client = require("./client");

// Músicas ativas em cada servidor
const activeGuilds = new Map();

// Último servidor que iniciou ou atualizou uma música
let lastGuildId = null;

// Obtém o nome do autor
function getAuthor(track) {
    const author =
        track?.spotify?.author ||
        track?.author ||
        track?.artist ||
        track?.uploader ||
        track?.channel ||
        "Artista desconhecido";

    return String(author).trim() || "Artista desconhecido";
}

// Remove completamente a atividade personalizada
function removeActivity() {
    if (!client.isReady()) return;

    client.user.setPresence({
        activities: [],
        status: "online"
    });
}

// Exibe o autor da música atual
function applyActivity(track) {
    if (!client.isReady()) return;

    if (!track) {
        removeActivity();
        return;
    }

    const author = getAuthor(track);

    client.user.setPresence({
        activities: [
            {
                name: "Custom Status",
                type: ActivityType.Custom,
                state: `Tocando ${author}`.slice(0, 128)
            }
        ],
        status: "online"
    });
}

// Atualiza o status ao iniciar ou trocar uma música
function updateMusicStatus(guildId, track) {
    if (!guildId || !track) return;

    activeGuilds.set(guildId, track);
    lastGuildId = guildId;

    applyActivity(track);

    console.log(
        `🎵 Status atualizado: Tocando ${getAuthor(track)}`
    );
}

// Remove o status de um servidor quando a música termina
function clearMusicStatus(guildId) {
    if (!guildId) return;

    activeGuilds.delete(guildId);

    // Nenhum servidor está reproduzindo
    if (activeGuilds.size === 0) {
        lastGuildId = null;
        removeActivity();

        console.log("⏹️ Status musical removido.");
        return;
    }

    // Se o servidor removido não controlava
    // a atividade atual, mantém o status existente.
    if (lastGuildId !== guildId) {
        return;
    }

    // Outro servidor ainda está reproduzindo.
    // Usa a música mais recentemente atualizada.
    const entries = [...activeGuilds.entries()];
    const [nextGuildId, nextTrack] =
        entries[entries.length - 1];

    lastGuildId = nextGuildId;

    applyActivity(nextTrack);

    console.log(
        `🎵 Status alterado para outro servidor: ` +
        `Tocando ${getAuthor(nextTrack)}`
    );
}

// Garante que o bot inicie sem atividade personalizada
function initializeMusicStatus() {
    activeGuilds.clear();
    lastGuildId = null;

    removeActivity();
}

module.exports = {
    updateMusicStatus,
    clearMusicStatus,
    initializeMusicStatus
};
