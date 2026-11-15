const { Events } = require("discord.js");

module.exports = function registerReadyEvent(client) {
    client.once(Events.ClientReady, () => {
        console.log(`✅ Logado como ${client.user.tag}`);
        console.log("🎵 Music Bot está online!");
    });
};