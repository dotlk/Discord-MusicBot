
import { useEffect, useRef, useState } from "react";
import { DiscordSDK } from "@discord/embedded-app-sdk";
import "./App.css";

const clientId = import.meta.env.VITE_DISCORD_CLIENT_ID;

function formatDuration(duration) {
    if (duration == null) return "--:--";

    const seconds = Number(duration);

    if (!Number.isFinite(seconds)) return duration;

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);

    return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function TrackImage({ src, className = "" }) {
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        setFailed(false);
    }, [src]);

    if (!src || failed) {
        return (
            <div className={className}>
                <span>♫</span>
            </div>
        );
    }

    return (
        <img
            className={className}
            src={src}
            alt="Capa da música"
            onError={() => setFailed(true)}
        />
    );
}

export default function App() {
    const socketRef = useRef(null);

    const [current, setCurrent] = useState(null);
    const [queue, setQueue] = useState([]);
    const [playing, setPlaying] = useState(false);
    const [loop, setLoop] = useState(false);
    const [dragged, setDragged] = useState(null);

    const [connected, setConnected] = useState(false);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        let socket = null;

        async function connectActivity() {
            try {
                if (!clientId) {
                    throw new Error(
                        "VITE_DISCORD_CLIENT_ID não está configurado."
                    );
                }

                const discordSdk = new DiscordSDK(clientId);

                await discordSdk.ready();

                const { code } = await discordSdk.commands.authorize({
                    client_id: clientId,
                    response_type: "code",
                    state: "",
                    prompt: "none",
                    scope: ["identify"]
                });

                const tokenResponse = await fetch("/api/token", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ code })
                });

                const tokenData = await tokenResponse.json();

                if (!tokenResponse.ok) {
                    throw new Error(
                        tokenData.error || "Falha na autenticação OAuth."
                    );
                }

                const auth = await discordSdk.commands.authenticate({
                    access_token: tokenData.access_token
                });

                if (!auth) {
                    throw new Error("Falha na autenticação com o Discord.");
                }

                if (!discordSdk.guildId) {
                    throw new Error(
                        "A Activity precisa estar aberta em um servidor."
                    );
                }

                if (cancelled) return;

                const protocol =
                    window.location.protocol === "https:" ? "wss:" : "ws:";

                socket = new WebSocket(
                    `${protocol}//${window.location.host}/ws`
                );

                socketRef.current = socket;

                socket.addEventListener("open", () => {
                    socket.send(JSON.stringify({
                        type: "auth",
                        accessToken: tokenData.access_token,
                        guildId: discordSdk.guildId
                    }));
                });

                socket.addEventListener("message", (event) => {
                    const message = JSON.parse(event.data);

                    if (message.type === "authenticated") {
                        setConnected(true);
                        setLoading(false);
                        setError("");
                    }

                    if (message.type === "state") {
                        setCurrent(message.currentTrack);
                        setQueue(message.tracks || []);
                        setLoop(message.loop === true);
                        setPlaying(message.status === "playing");
                    }

                    if (message.type === "error") {
                        setError(message.message || "Erro no servidor.");
                    }
                });

                socket.addEventListener("close", () => {
                    if (!cancelled) {
                        setConnected(false);
                        setLoading(false);
                        setError("Conexão com o bot encerrada.");
                    }
                });

                socket.addEventListener("error", () => {
                    if (!cancelled) {
                        setError("Não foi possível conectar ao servidor do bot.");
                        setLoading(false);
                    }
                });

            } catch (err) {
                console.error("[Activity]", err);

                if (!cancelled) {
                    setError(err.message || "Erro ao iniciar a Activity.");
                    setLoading(false);
                }
            }
        }

        connectActivity();

        return () => {
            cancelled = true;

            if (socket) {
                socket.close();
            }

            socketRef.current = null;
        };
    }, []);

    function sendAction(action, extra = {}) {
        const socket = socketRef.current;

        if (!socket || socket.readyState !== WebSocket.OPEN) {
            setError("Sem conexão com o bot.");
            return;
        }

        socket.send(JSON.stringify({
            type: "action",
            action,
            ...extra
        }));
    }

    function moveTrack(targetIndex) {
        if (dragged === null || dragged === targetIndex) return;

        sendAction("reorder", {
            fromIndex: dragged,
            toIndex: targetIndex
        });

        setDragged(null);
    }

    return (
        <main className="app">
            <section className="now-playing">
                <div className="section-label">TOCANDO AGORA</div>

                <TrackImage
                    src={current?.thumbnail}
                    className="track-art"
                />

                <div className="track-info">
                    <h2>{current?.title || "Nenhuma música"}</h2>
                    <p>{current?.artist || "Aguardando reprodução"}</p>
                </div>

                <div className="progress">
                    <div className="progress-bar">
                        <div className="progress-fill" />
                    </div>

                    <div className="progress-time">
                        <span>--:--</span>
                        <span>{formatDuration(current?.duration)}</span>
                    </div>
                </div>

                <div className="controls">
                    <button
                        className={`control-button ${loop ? "active" : ""}`}
                        onClick={() => sendAction("toggleLoop")}
                        disabled={!connected || !current}
                        title="Repetir música atual"
                    >
                        ↻
                    </button>

                    <button
                        className="play-button"
                        onClick={() => sendAction("togglePlayback")}
                        disabled={!connected || !current}
                        title={playing ? "Pausar" : "Retomar"}
                    >
                        {playing ? (
                            <span className="pause-icon">
                                <i />
                                <i />
                            </span>
                        ) : (
                            "▶"
                        )}
                    </button>

                    <button
                        className="control-button"
                        onClick={() => sendAction("next")}
                        disabled={!connected || !current}
                        title="Próxima música"
                    >
                        ⏭
                    </button>
                </div>

                <div className="playback-status">
                    {loading
                        ? "Conectando..."
                        : playing
                            ? "Reproduzindo"
                            : "Pausado"}

                    {loop && " · Repetição ativada"}
                </div>
            </section>

            <section className="queue-section">
                <div className="queue-header">
                    <div>
                        <div className="section-label">
                            PRÓXIMAS MÚSICAS
                        </div>

                        <h2>Fila de reprodução</h2>
                        <p>{queue.length} músicas na fila</p>
                    </div>

                    <button
                        className="shuffle-button"
                        onClick={() => sendAction("shuffle")}
                        disabled={!connected || queue.length < 2}
                    >
                        ⤨ Shuffle
                    </button>
                </div>

                <div className="queue-list">
                    {queue.length === 0 ? (
                        <div className="empty-queue">
                            Não há músicas na fila.
                        </div>
                    ) : (
                        queue.map((track, index) => (
                            <div
                                key={`${track.title}-${index}`}
                                className={`queue-item ${
                                    dragged === index ? "dragging" : ""
                                }`}
                                draggable={connected}
                                onDragStart={() => setDragged(index)}
                                onDragOver={(event) => event.preventDefault()}
                                onDrop={() => moveTrack(index)}
                                onDragEnd={() => setDragged(null)}
                            >
                                <span className="queue-number">
                                    {index + 1}
                                </span>

                                <TrackImage
                                    src={track.thumbnail}
                                    className="mini-art"
                                />

                                <div className="queue-track-info">
                                    <strong>{track.title}</strong>
                                    <span>{track.artist}</span>
                                </div>

                                <span className="duration">
                                    {formatDuration(track.duration)}
                                </span>

                                <span className="drag-handle">⠿</span>
                            </div>
                        ))
                    )}
                </div>

                <p className="queue-hint">
                    Arraste as músicas para reorganizar a fila.
                </p>
            </section>

            <footer>
                BicodeMel <span>•</span> Music for your server
                <span> · </span>
                {connected ? "Conectado" : "Desconectado"}
            </footer>

            {error && (
                <div className="activity-error">
                    {error}
                </div>
            )}
        </main>
    );
}
