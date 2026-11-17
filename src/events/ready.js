
const { Events } = require("discord.js");
const { getVoiceConnection } = require("@discordjs/voice");

const { initializeMusicStatus } = require("../discord/musicStatus");
const { startActivityServer } = require("../activity/server");
const { startCloudflareTunnel } = require("../activity/cloudflareTunnel");

const { leaveChannel } = require("../audio/voiceManager");
const { getQueue } = require("../audio/queueManager");

module.exports = function registerReadyEvent(client) {

    // Detecta desconexões e movimentações do próprio bot.
    client.on(Events.VoiceStateUpdate, (oldState, newState) => {
        // Ignora alterações de outros usuários.
        if (oldState.id !== client.user.id) {
            return;
        }

        // Ignora entradas em canais e atualizações sem mudança de canal.
        if (
            !oldState.channelId ||
            oldState.channelId === newState.channelId
        ) {
            return;
        }

        const guildId = oldState.guild.id;

        // Evita repetir a limpeza quando o /stop já encerrou tudo.
        if (
            !getVoiceConnection(guildId) &&
            !getQueue(guildId)
        ) {
            return;
        }

        console.log(
            `⚠️ Bot desconectado ou movido de canal (${guildId}).`
        );

        // Executa a mesma limpeza utilizada pelo /stop.
        leaveChannel(guildId);
    });

    client.once(Events.ClientReady, () => {
        initializeMusicStatus();

        console.log("✅ Status musical inicializado.");
        console.log(`✅ Logado como ${client.user.tag}`);
        console.log("🎵 Music Bot está online!");

        startActivityServer(client);
        startCloudflareTunnel();
    });
};
