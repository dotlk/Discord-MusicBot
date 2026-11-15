const { ActivityType } = require("discord.js");
const client = require("./client");

function updateMusicStatus(track) {
    if (!client.isReady()) return;

    const author = String(
        track?.spotify?.author ||
        track?.author ||
        "Artista desconhecido"
    ).trim();

    client.user.setPresence({
        activities: [{
            name: "Custom Status",
            type: ActivityType.Custom,
            state: `Tocando ${author}`.slice(0, 128)
        }],
        status: "online"
    });
}

function clearMusicStatus() {
    if (!client.isReady()) return;

    client.user.setPresence({
        activities: [],
        status: "online"
    });
}

module.exports = {
    updateMusicStatus,
    clearMusicStatus
};
