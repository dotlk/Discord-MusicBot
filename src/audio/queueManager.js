const fs = require('node:fs');
const path = require('node:path');
const TEMP_DIR = path.resolve(__dirname, '../../temp');
const runtimes = new Map();

function getQueueDir(guildId) { return path.join(TEMP_DIR, String(guildId)); }
function getQueuePath(guildId) { return path.join(getQueueDir(guildId), 'queue.json'); }
function getRuntime(guildId) {
    if (!runtimes.has(guildId)) runtimes.set(guildId, { player: null, connection: null });
    return runtimes.get(guildId);
}
function readQueue(guildId) {
    const file = getQueuePath(guildId);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}
function writeQueue(guildId, queue) {
    fs.mkdirSync(getQueueDir(guildId), { recursive: true });
    const data = {
        guildId: String(guildId), tracks: queue.tracks,
        currentTrack: queue.currentTrack, status: queue.status
    };
    fs.writeFileSync(getQueuePath(guildId), JSON.stringify(data, null, 2), 'utf8');
    return data;
}
function createQueue(guildId) {
    if (!readQueue(guildId)) {
        writeQueue(guildId, { tracks: [], currentTrack: null, status: 'idle' });
        console.log(`🎵 Fila criada para o servidor ${guildId}`);
    }
    return getQueue(guildId);
}
function getQueue(guildId) {
    const queue = readQueue(guildId);
    return queue ? { ...queue, ...getRuntime(guildId) } : null;
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
    if (!queue) return null;
    const track = queue.tracks.shift() || null;
    queue.currentTrack = track;
    queue.status = track ? 'playing' : 'idle';
    writeQueue(guildId, queue);
    return track;
}
function removeTrack(guildId, position) {
    const queue = readQueue(guildId);
    if (!queue || !Number.isInteger(position) || position < 1 || position > queue.tracks.length) return null;
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

// Move uma música em espera para o início da fila.
// Com playNow, recoloca a música atual logo depois dela.
// A interrupção efetiva do player é feita por skipTrack().
function prioritizeTrack(guildId, position, playNow = false) {
    const queue = readQueue(guildId);
    if (!queue || !Number.isInteger(position) || position < 1 || position > queue.tracks.length) return null;
    const [selected] = queue.tracks.splice(position - 1, 1);
    queue.tracks.unshift(selected);
    const interrupted = playNow ? queue.currentTrack : null;
    if (interrupted) queue.tracks.splice(1, 0, interrupted);
    writeQueue(guildId, queue);
    return { selected, interrupted };
}

function getCurrentTrack(guildId) { return readQueue(guildId)?.currentTrack || null; }
function updateQueue(guildId, changes) {
    const queue = readQueue(guildId);
    if (!queue) return null;
    for (const field of ['tracks', 'currentTrack', 'status']) {
        if (Object.prototype.hasOwnProperty.call(changes, field)) queue[field] = changes[field];
    }
    writeQueue(guildId, queue);
    return getQueue(guildId);
}
function setConnection(guildId, connection) { createQueue(guildId); getRuntime(guildId).connection = connection; }
function setPlayer(guildId, player) { createQueue(guildId); getRuntime(guildId).player = player; }
function deleteQueue(guildId) {
    const dir = getQueueDir(guildId);
    const exists = fs.existsSync(dir);
    runtimes.delete(guildId);
    if (exists) fs.rmSync(dir, { recursive: true, force: true });
    console.log(`🗑️ Fila encerrada: ${guildId}`);
    return exists;
}
module.exports = {
    createQueue, getQueue, addTrack, addTracks, nextTrack,
    removeTrack, clearQueue, prioritizeTrack, getCurrentTrack,
    updateQueue, setConnection, setPlayer, deleteQueue
};
