
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const TEMP_DIR = path.resolve(__dirname, '../../temp');
const runtimes = new Map();
const queueEvents = new EventEmitter();

function onQueueChange(listener) {
    queueEvents.on('change', listener);

    return () => queueEvents.off('change', listener);
}

function getQueueDir(guildId) {
    return path.join(TEMP_DIR, String(guildId));
}

function getQueuePath(guildId) {
    return path.join(getQueueDir(guildId), 'queue.json');
}

function getRuntime(guildId) {
    if (!runtimes.has(guildId)) {
        runtimes.set(guildId, { player: null, connection: null });
    }

    return runtimes.get(guildId);
}

function readQueue(guildId) {
    const file = getQueuePath(guildId);

    return fs.existsSync(file)
        ? JSON.parse(fs.readFileSync(file, 'utf8'))
        : null;
}

function writeQueue(guildId, queue) {
    fs.mkdirSync(getQueueDir(guildId), { recursive: true });

    const data = {
        guildId: String(guildId),
        tracks: queue.tracks,
        currentTrack: queue.currentTrack,
        status: queue.status,
        loop: queue.loop === true
    };

    fs.writeFileSync(
        getQueuePath(guildId),
        JSON.stringify(data, null, 2),
        'utf8'
    );

    queueEvents.emit('change', String(guildId));

    return data;
}

function createQueue(guildId) {
    if (!readQueue(guildId)) {
        writeQueue(guildId, {
            tracks: [],
            currentTrack: null,
            status: 'idle',
            loop: false
        });

        console.log(`🎵 Fila criada para o servidor ${guildId}`);
    }

    return getQueue(guildId);
}

function getQueue(guildId) {
    const queue = readQueue(guildId);

    return queue
        ? { ...queue, ...getRuntime(guildId) }
        : null;
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

    return queue.tracks.length;
}

function nextTrack(guildId) {
    const queue = readQueue(guildId);

    if (!queue || queue.tracks.length === 0) return null;

    const track = queue.tracks.shift();

    queue.currentTrack = track;
    queue.status = 'playing';

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

    return removed;
}

function clearQueue(guildId) {
    const queue = readQueue(guildId);

    if (!queue) return 0;

    const count = queue.tracks.length;
    queue.tracks = [];

    writeQueue(guildId, queue);

    return count;
}

function prioritizeTrack(guildId, position, playNow = false) {
    const queue = readQueue(guildId);

    if (
        !queue ||
        !Number.isInteger(position) ||
        position < 1 ||
        position > queue.tracks.length
    ) {
        return null;
    }

    const [selected] = queue.tracks.splice(position - 1, 1);
    const interrupted = playNow ? queue.currentTrack : null;

    queue.tracks.unshift(selected);

    if (interrupted) {
        queue.tracks.splice(1, 0, interrupted);
    }

    writeQueue(guildId, queue);

    return { selected, interrupted };
}

function toggleLoop(guildId) {
    createQueue(guildId);

    const queue = readQueue(guildId);
    queue.loop = queue.loop !== true;

    writeQueue(guildId, queue);

    return queue.loop;
}

function shuffleQueue(guildId) {
    const queue = readQueue(guildId);

    if (!queue || queue.tracks.length < 2) return 0;

    // Fisher-Yates: somente as músicas em espera.
    for (let i = queue.tracks.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));

        [queue.tracks[i], queue.tracks[j]] =
            [queue.tracks[j], queue.tracks[i]];
    }

    writeQueue(guildId, queue);

    console.log(
        `🔀 Fila embaralhada: ${queue.tracks.length} músicas (${guildId})`
    );

    return queue.tracks.length;
}

// Reorganiza as músicas em espera usando índices começando em zero.
function moveTrack(guildId, fromIndex, toIndex) {
    const queue = readQueue(guildId);

    if (
        !queue ||
        !Number.isInteger(fromIndex) ||
        !Number.isInteger(toIndex) ||
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= queue.tracks.length ||
        toIndex >= queue.tracks.length
    ) {
        return false;
    }

    if (fromIndex === toIndex) return true;

    const [movedTrack] = queue.tracks.splice(fromIndex, 1);

    queue.tracks.splice(toIndex, 0, movedTrack);

    writeQueue(guildId, queue);

    return true;
}

function getCurrentTrack(guildId) {
    return getQueue(guildId)?.currentTrack || null;
}

function updateQueue(guildId, changes) {
    createQueue(guildId);

    const queue = readQueue(guildId);

    for (const field of ['tracks', 'currentTrack', 'status']) {
        if (Object.prototype.hasOwnProperty.call(changes, field)) {
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
        fs.rmSync(dir, { recursive: true, force: true });
    }

    queueEvents.emit('change', String(guildId));

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
    prioritizeTrack,
    toggleLoop,
    shuffleQueue,
    moveTrack,
    getCurrentTrack,
    updateQueue,
    setConnection,
    setPlayer,
    deleteQueue,
    onQueueChange
};
