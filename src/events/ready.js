
const { Events } = require("discord.js");

const { initializeMusicStatus } = require("../discord/musicStatus");
const { startActivityServer } = require("../activity/server");
const { startCloudflareTunnel } = require("../activity/cloudflareTunnel");

module.exports = function registerReadyEvent(client) {
    client.once(Events.ClientReady, () => {
        initializeMusicStatus();

        console.log("✅ Status musical inicializado.");
        console.log(`✅ Logado como ${client.user.tag}`);
        console.log("🎵 Music Bot está online!");

        startActivityServer(client);
        startCloudflareTunnel();
    });
};
