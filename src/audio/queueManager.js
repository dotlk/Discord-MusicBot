
const fs = require("node:fs");
const path = require("node:path");

const TEMP_DIR = path.resolve(__dirname, "../../temp");

// Mantém na RAM apenas referências necessárias ao funcionamento
const runtimes = new Map();

function getQueueDir(guildId) {
    return path.join(TEMP_DIR, String(guildId));
}

function getQueuePath(guildId) {
    return path.join(getQueueDir(guildId), "queue.json");
}

function getRuntime(guildId) {
    if (!runtimes.has(guildId)) {
        runtimes.set(guildId, {
            player: null,
            connection: null
        });
    }

    return runtimes.get(guildId);
}

function readQueue(guildId) {
    const file = getQueuePath(guildId);

    if (!fs.existsSync(file)) {
        return null;
    }

    return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeQueue(guildId, queue) {
    const dir = getQueueDir(guildId);

    fs.mkdirSync(dir, { recursive: true });

    const data = {
        guildId: String(guildId),
        tracks: queue.tracks,
        currentTrack: queue.currentTrack,
        status: queue.status
    };

    fs.writeFileSync(
        getQueuePath(guildId),
        JSON.stringify(data, null, 2),
        "utf8"
    );

    return data;
}

function createQueue(guildId) {
    let queue = readQueue(guildId);

    if (!queue) {
        queue = writeQueue(guildId, {
            tracks: [],
            currentTrack: null,
            status: "idle"
        });

        console.log(`🎵 Fila criada para o servidor ${guildId}`);
    }

    return getQueue(guildId);
}

function getQueue(guildId) {
    const queue = readQueue(guildId);

    if (!queue) return null;

    const runtime = getRuntime(guildId);

    return {
        ...queue,
        player: runtime.player,
        connection: runtime.connection
    };
}

function addTrack(guildId, track) {
    createQueue(guildId);

    const queue = readQueue(guildId);
    queue.tracks.push(track);

    writeQueue(guildId, queue);

    console.log(`➕ Música adicionada: ${track.title}`);

    return queue.tracks.length;
}

function addTracks(guildId, tracks) {
    createQueue(guildId);

    const queue = readQueue(guildId);
    queue.tracks.push(...tracks);

    writeQueue(guildId, queue);

    console.log(`➕ ${tracks.length} músicas adicionadas à fila.`);

    return queue.tracks.length;
}

function nextTrack(guildId) {
    const queue = readQueue(guildId);

    if (!queue) return null;

    const track = queue.tracks.shift() || null;

    queue.currentTrack = track;
    queue.status = track ? "playing" : "idle";

    writeQueue(guildId, queue);

    return track;
}

function removeTrack(guildId, position) {
    const queue = readQueue(guildId);

    if (
        !queue ||
        !Number.isInteger(position) ||
        position < 1 ||
        position > queue.tracks.length
    ) {
        return null;
    }

    const [removed] = queue.tracks.splice(position - 1, 1);

    writeQueue(guildId, queue);

    console.log(`➖ Música removida: ${removed.title}`);

    return removed;
}

function clearQueue(guildId) {
    const queue = readQueue(guildId);

    if (!queue) return 0;

    const count = queue.tracks.length;

    queue.tracks = [];

    writeQueue(guildId, queue);

    console.log(`🗑️ ${count} músicas removidas da fila.`);

    return count;
}

function getCurrentTrack(guildId) {
    return readQueue(guildId)?.currentTrack || null;
}

function updateQueue(guildId, changes) {
    const queue = readQueue(guildId);

    if (!queue) return null;

    const allowedFields = [
        "tracks",
        "currentTrack",
        "status"
    ];

    for (const field of allowedFields) {
        if (
            Object.prototype.hasOwnProperty.call(
                changes,
                field
            )
        ) {
            queue[field] = changes[field];
        }
    }

    writeQueue(guildId, queue);

    return getQueue(guildId);
}

function setConnection(guildId, connection) {
    createQueue(guildId);
    getRuntime(guildId).connection = connection;
}

function setPlayer(guildId, player) {
    createQueue(guildId);
    getRuntime(guildId).player = player;
}

function deleteQueue(guildId) {
    const dir = getQueueDir(guildId);
    const exists = fs.existsSync(dir);

    runtimes.delete(guildId);

    if (exists) {
        fs.rmSync(dir, {
            recursive: true,
            force: true
        });
    }

    console.log(`🗑️ Fila encerrada: ${guildId}`);

    return exists;
}

module.exports = {
    createQueue,
    getQueue,
    addTrack,
    addTracks,
    nextTrack,
    removeTrack,
    clearQueue,
    getCurrentTrack,
    updateQueue,
    setConnection,
    setPlayer,
    deleteQueue
};
