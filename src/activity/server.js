
const http = require("node:http");
const { WebSocketServer, WebSocket } = require("ws");
const { AudioPlayerStatus, getVoiceConnection } = require("@discordjs/voice");

const {
    getQueue,
    toggleLoop,
    shuffleQueue,
    moveTrack
} = require("../audio/queueManager");

const { skipTrack } = require("../audio/player");

const DISCORD_API = "https://discord.com/api/v10";
const REDIRECT_URI = "https://127.0.0.1";

const clients = new Set();

const THUMBNAIL_HOSTS = new Set([
    "i.ytimg.com",
    "img.youtube.com",
    "yt3.ggpht.com"
]);

const MAX_THUMBNAIL_SIZE = 5 * 1024 * 1024;

async function proxyThumbnail(req, res) {
    try {
        const requestUrl = new URL(req.url, "http://localhost");
        const imageUrl = requestUrl.searchParams.get("url");

        if (!imageUrl) {
            res.writeHead(400);
            res.end("URL da imagem ausente.");
            return;
        }

        let parsedUrl;

        try {
            parsedUrl = new URL(imageUrl);
        } catch {
            res.writeHead(400);
            res.end("URL inválida.");
            return;
        }

        if (
            parsedUrl.protocol !== "https:" ||
            !THUMBNAIL_HOSTS.has(parsedUrl.hostname)
        ) {
            res.writeHead(403);
            res.end("Domínio de imagem não permitido.");
            return;
        }

        const response = await fetch(parsedUrl, {
            signal: AbortSignal.timeout(10000),
            redirect: "error",
            headers: {
                "User-Agent": "Mozilla/5.0"
            }
        });

        if (!response.ok) {
            res.writeHead(502);
            res.end("Não foi possível obter a imagem.");
            return;
        }

        const contentType = response.headers.get("content-type") || "";

        const allowedTypes = [
            "image/jpeg",
            "image/png",
            "image/webp",
            "image/gif"
        ];

        if (!allowedTypes.includes(contentType.split(";")[0].trim())) {
            res.writeHead(415);
            res.end("Formato de imagem não permitido.");
            return;
        }

        const contentLength = Number(
            response.headers.get("content-length") || 0
        );

        if (contentLength > MAX_THUMBNAIL_SIZE) {
            res.writeHead(413);
            res.end("Imagem muito grande.");
            return;
        }

        const imageBuffer = Buffer.from(
            await response.arrayBuffer()
        );

        if (imageBuffer.length > MAX_THUMBNAIL_SIZE) {
            res.writeHead(413);
            res.end("Imagem muito grande.");
            return;
        }

        res.writeHead(200, {
            "Content-Type": contentType,
            "Content-Length": imageBuffer.length,
            "Cache-Control": "public, max-age=86400",
            "X-Content-Type-Options": "nosniff"
        });

        res.end(imageBuffer);

    } catch (error) {
        console.error(
            "[Activity] Erro ao carregar thumbnail:",
            error.message
        );

        if (!res.headersSent) {
            res.writeHead(502);
            res.end("Erro ao carregar imagem.");
        }
    }
}

async function exchangeCode(code) {
    const body = new URLSearchParams({
        client_id: process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI
    });

    const response = await fetch(`${DISCORD_API}/oauth2/token`, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded"
        },
        body
    });

    const data = await response.json();

    if (!response.ok) {
        throw new Error(
            data.error_description || "Falha na autenticação OAuth."
        );
    }

    return data;
}

async function getDiscordUser(accessToken) {
    const response = await fetch(`${DISCORD_API}/users/@me`, {
        headers: {
            Authorization: `Bearer ${accessToken}`
        }
    });

    if (!response.ok) {
        throw new Error("Token Discord inválido ou expirado.");
    }

    return response.json();
}

function send(socket, type, data = {}) {
    if (socket.readyState !== WebSocket.OPEN) return;

    socket.send(JSON.stringify({ type, ...data }));
}

function serializeTrack(track) {
    if (!track) return null;

    return {
        title: track.title || "Desconhecido",
        artist:
            track.author ||
            track.artist ||
            track.uploader ||
            "Artista desconhecido",
        duration: track.duration || null,
        thumbnail: track.thumbnail || null
    };
}

function getSnapshot(guildId) {
    const queue = getQueue(guildId);

    if (!queue) {
        return {
            currentTrack: null,
            tracks: [],
            loop: false,
            status: "idle"
        };
    }

    const playerStatus = queue.player?.state?.status;

    let status = "idle";

    if (playerStatus === AudioPlayerStatus.Playing) {
        status = "playing";
    } else if (
        playerStatus === AudioPlayerStatus.Paused ||
        playerStatus === AudioPlayerStatus.AutoPaused
    ) {
        status = "paused";
    }

    return {
        currentTrack: serializeTrack(queue.currentTrack),
        tracks: queue.tracks.map(serializeTrack),
        loop: queue.loop === true,
        status
    };
}

async function validateVoiceAccess(client, guildId, userId) {
    const connection = getVoiceConnection(guildId);

    if (!connection) {
        throw new Error("O bot não está conectado a um canal de voz.");
    }

    const guild = await client.guilds.fetch(guildId);
    const voiceState = guild.voiceStates.cache.get(userId);

    if (
        !voiceState?.channelId ||
        voiceState.channelId !== connection.joinConfig.channelId
    ) {
        throw new Error(
            "Você precisa estar no mesmo canal de voz que o bot."
        );
    }

    return connection;
}

async function handleAction(client, socket, message) {
    const { guildId, userId } = socket;

    await validateVoiceAccess(client, guildId, userId);

    const queue = getQueue(guildId);

    if (!queue?.currentTrack || !queue.player) {
        throw new Error("Não há música em reprodução.");
    }

    switch (message.action) {
        case "togglePlayback": {
            const status = queue.player.state.status;

            if (status === AudioPlayerStatus.Playing) {
                queue.player.pause();
            } else if (
                status === AudioPlayerStatus.Paused ||
                status === AudioPlayerStatus.AutoPaused
            ) {
                queue.player.unpause();
            } else {
                throw new Error(
                    "O player não está pronto para essa ação."
                );
            }

            break;
        }

        case "next": {
            if (!skipTrack(guildId)) {
                throw new Error("Não foi possível avançar a música.");
            }

            break;
        }

        case "toggleLoop": {
            toggleLoop(guildId);
            break;
        }

        case "shuffle": {
            shuffleQueue(guildId);
            break;
        }

        case "reorder": {
            const { fromIndex, toIndex } = message;

            if (!moveTrack(guildId, fromIndex, toIndex)) {
                throw new Error(
                    "Não foi possível reorganizar a fila."
                );
            }

            break;
        }

        default:
            throw new Error("Ação desconhecida.");
    }

    broadcast(guildId);
}

function broadcast(guildId) {
    const snapshot = getSnapshot(guildId);

    for (const socket of clients) {
        if (
            socket.readyState === WebSocket.OPEN &&
            socket.authenticated &&
            socket.guildId === guildId
        ) {
            send(socket, "state", snapshot);
        }
    }
}

function startActivityServer(client) {
    if (!process.env.CLIENT_ID || !process.env.CLIENT_SECRET) {
        throw new Error(
            "CLIENT_ID e CLIENT_SECRET são necessários para a Activity."
        );
    }

    const PORT = Number(process.env.ACTIVITY_PORT || 3001);

    const server = http.createServer(async (req, res) => {
        if (req.method === "GET" && req.url === "/health") {
            res.writeHead(200, {
                "Content-Type": "application/json"
            });

            res.end(JSON.stringify({ status: "ok" }));
            return;
        }

        if (
            req.method === "GET" &&
            req.url.startsWith("/api/thumbnail")
        ) {
            await proxyThumbnail(req, res);
            return;
        }

        if (req.method === "POST" && req.url === "/api/token") {
            try {
                let rawBody = "";

                for await (const chunk of req) {
                    rawBody += chunk;

                    if (rawBody.length > 10000) {
                        throw new Error("Requisição muito grande.");
                    }
                }

                const { code } = JSON.parse(rawBody);

                if (typeof code !== "string" || !code) {
                    throw new Error("Código OAuth ausente.");
                }

                const tokenData = await exchangeCode(code);

                res.writeHead(200, {
                    "Content-Type": "application/json",
                    "Cache-Control": "no-store"
                });

                res.end(JSON.stringify({
                    access_token: tokenData.access_token
                }));

            } catch (error) {
                console.error(
                    "[Activity] OAuth:",
                    error.message
                );

                res.writeHead(400, {
                    "Content-Type": "application/json",
                    "Cache-Control": "no-store"
                });

                res.end(JSON.stringify({
                    error:
                        "Não foi possível autenticar com o Discord."
                }));
            }

            return;
        }

        res.writeHead(404);
        res.end("Not Found");
    });

    const wss = new WebSocketServer({ server });

    wss.on("connection", socket => {
        clients.add(socket);

        socket.authenticated = false;

        socket.on("message", async rawMessage => {
            try {
                const message = JSON.parse(rawMessage.toString());

                if (!socket.authenticated) {
                    if (message.type !== "auth") {
                        throw new Error("Autenticação necessária.");
                    }

                    const { accessToken, guildId } = message;

                    if (
                        typeof accessToken !== "string" ||
                        typeof guildId !== "string" ||
                        !/^\d{17,20}$/.test(guildId)
                    ) {
                        throw new Error(
                            "Dados de autenticação inválidos."
                        );
                    }

                    const user = await getDiscordUser(accessToken);

                    await validateVoiceAccess(
                        client,
                        guildId,
                        user.id
                    );

                    socket.authenticated = true;
                    socket.guildId = guildId;
                    socket.userId = user.id;

                    send(socket, "authenticated");
                    send(socket, "state", getSnapshot(guildId));

                    console.log(
                        `[Activity] ${user.username} conectado (${guildId}).`
                    );

                    return;
                }

                if (message.type === "action") {
                    await handleAction(client, socket, message);
                }

            } catch (error) {
                send(socket, "error", {
                    message: error.message || "Erro interno."
                });
            }
        });

        socket.on("close", () => {
            clients.delete(socket);
        });

        socket.on("error", error => {
            console.error(
                "[Activity] WebSocket:",
                error.message
            );
        });
    });

    const syncInterval = setInterval(() => {
        const guilds = new Set(
            [...clients]
                .filter(socket => socket.authenticated)
                .map(socket => socket.guildId)
        );

        for (const guildId of guilds) {
            broadcast(guildId);
        }
    }, 1500);

    server.listen(PORT, () => {
        console.log(
            `[Activity] Servidor iniciado na porta ${PORT}.`
        );
    });

    server.on("close", () => clearInterval(syncInterval));

    return { server, wss };
}

module.exports = { startActivityServer };
