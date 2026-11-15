
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

// Desconecta o bot e encerra a fila
function leaveChannel(guildId) {
    const connection = getVoiceConnection(guildId);

    if (!connection) return false;

    // Interrompe a reprodução
    stopPlayer(guildId);

    // Desconecta do canal
    connection.destroy();

    // Remove os dados da fila
    deleteQueue(guildId);

    console.log(`🔇 Desconectado do servidor ${guildId}`);

    return true;
}

module.exports = {
    joinChannel,
    leaveChannel
};
