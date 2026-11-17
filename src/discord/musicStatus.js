
const { ActivityType } = require("discord.js");
const client = require("./client");

// Músicas ativas em cada servidor
const activeGuilds = new Map();

// Servidores cuja reprodução está pausada
const pausedGuilds = new Set();

// Último servidor que controla a atividade atual
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

// Encontra a música mais recente que não está pausada
function showLatestActiveGuild() {
    const entries = [...activeGuilds.entries()].reverse();

    const entry = entries.find(
        ([guildId]) => !pausedGuilds.has(guildId)
    );

    if (!entry) {
        lastGuildId = null;
        removeActivity();
        return;
    }

    const [guildId, track] = entry;

    lastGuildId = guildId;
    applyActivity(track);
}

// Atualiza o status ao iniciar ou trocar uma música
function updateMusicStatus(guildId, track) {
    if (!guildId || !track) return;

    // Remove e adiciona novamente para atualizar a ordem.
    activeGuilds.delete(guildId);
    activeGuilds.set(guildId, track);

    // Uma nova música significa que o servidor voltou a tocar.
    pausedGuilds.delete(guildId);

    lastGuildId = guildId;

    applyActivity(track);

    console.log(
        `🎵 Status atualizado: Tocando ${getAuthor(track)}`
    );
}

// Oculta o status quando a reprodução é pausada
function pauseMusicStatus(guildId) {
    if (!guildId || !activeGuilds.has(guildId)) return;

    pausedGuilds.add(guildId);

    // Se esse servidor controlava a atividade,
    // procura outro servidor que ainda esteja tocando.
    if (lastGuildId === guildId) {
        showLatestActiveGuild();
    }

    console.log("⏸️ Status musical pausado.");
}

// Restaura o status quando a reprodução é retomada
function resumeMusicStatus(guildId) {
    if (!guildId || !activeGuilds.has(guildId)) return;

    pausedGuilds.delete(guildId);

    // Atualiza a ordem para esse servidor assumir o status.
    const track = activeGuilds.get(guildId);

    activeGuilds.delete(guildId);
    activeGuilds.set(guildId, track);

    lastGuildId = guildId;

    applyActivity(track);

    console.log(
        `▶️ Status musical restaurado: Tocando ${getAuthor(track)}`
    );
}

// Remove o status de um servidor quando a música termina
function clearMusicStatus(guildId) {
    if (!guildId) return;

    activeGuilds.delete(guildId);
    pausedGuilds.delete(guildId);

    // Se o servidor removido controlava a atividade,
    // ou se não existe atividade atual, procura outro.
    if (
        lastGuildId === guildId ||
        lastGuildId === null
    ) {
        showLatestActiveGuild();
    }

    if (activeGuilds.size === 0) {
        console.log("⏹️ Status musical removido.");
        return;
    }

    console.log(
        `⏹️ Status musical atualizado após encerrar servidor ${guildId}.`
    );
}

// Garante que o bot inicie sem atividade personalizada
function initializeMusicStatus() {
    activeGuilds.clear();
    pausedGuilds.clear();
    lastGuildId = null;

    removeActivity();
}

module.exports = {
    updateMusicStatus,
    pauseMusicStatus,
    resumeMusicStatus,
    clearMusicStatus,
    initializeMusicStatus
};
