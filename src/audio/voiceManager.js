
const {
    joinVoiceChannel,
    getVoiceConnection,
    entersState,
    VoiceConnectionStatus
} = require("@discordjs/voice");

const {
    attachPlayer,
    stopPlayer
} = require("./player");

const {
    getQueue,
    deleteQueue
} = require("./queueManager");

// Conecta o bot a um canal de voz
async function joinChannel(channel) {
    const guildId = channel.guild.id;

    const existingConnection = getVoiceConnection(guildId);

    // Reutiliza a conexão se já estiver no mesmo canal
    if (
        existingConnection &&
        existingConnection.joinConfig.channelId === channel.id &&
        existingConnection.state.status === VoiceConnectionStatus.Ready
    ) {
        attachPlayer(guildId, existingConnection);
        return existingConnection;
    }

    // Encerra a conexão anterior
    if (existingConnection) {
        existingConnection.destroy();
    }

    const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: true,
        selfMute: false
    });

    try {
        await entersState(
            connection,
            VoiceConnectionStatus.Ready,
            30000
        );

        // Associa o player à conexão
        attachPlayer(guildId, connection);

        console.log(
            `🔊 Conectado ao canal ${channel.name} (${guildId})`
        );

        return connection;

    } catch (error) {
        connection.destroy();
        throw error;
    }
}

// Desconecta o bot e encerra completamente a fila
function leaveChannel(guildId) {
    const queue = getQueue(guildId);

    // Recupera a conexão mesmo se ela não estiver mais
    // registrada no gerenciador do Discord.
    const connection =
        getVoiceConnection(guildId) ||
        queue?.connection;

    // Interrompe a reprodução e encerra os processos de áudio.
    try {
        stopPlayer(guildId);
    } catch (error) {
        console.error(
            `Erro ao interromper o player (${guildId}):`,
            error
        );
    }

    // Desconecta do canal, caso a conexão ainda exista.
    try {
        if (
            connection &&
            connection.state.status !== VoiceConnectionStatus.Destroyed
        ) {
            connection.destroy();
        }
    } catch (error) {
        console.error(
            `Erro ao desconectar do canal (${guildId}):`,
            error
        );
    } finally {
        // Remove os dados persistentes e as referências em memória.
        deleteQueue(guildId);
    }

    console.log(
        `🔇 Desconectado e fila encerrada: ${guildId}`
    );

    return true;
}

module.exports = {
    joinChannel,
    leaveChannel
};
