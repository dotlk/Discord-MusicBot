
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

function getThumbnailUrl(src) {
    if (!src) return null;

    return `/api/thumbnail?url=${encodeURIComponent(src)}`;
}

function TrackImage({ src, className = "" }) {
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        setFailed(false);
    }, [src]);

    const thumbnailUrl = getThumbnailUrl(src);

    if (!thumbnailUrl || failed) {
        return (
            <div className={className}>
                <span>♫</span>
            </div>
        );
    }

    return (
        <img
            className={className}
            src={thumbnailUrl}
            alt="Capa da música"
            onError={() => setFailed(true)}
        />
    );
}

/* Visualizador de áudio com detecção de batidas */
function AudioVisualizer({ bandsRef }) {
    const barsRef = useRef([]);
    const visualizerRef = useRef(null);

    useEffect(() => {
        const barCount = barsRef.current.length;

        const smoothedBands = Array(8).fill(0);
        const energyHistory = [];

        let animationFrame;
        let previousTime = 0;
        let lastBeatTime = 0;
        let beatPulse = 0;
        let estimatedBpm = 0;

        const beatIntervals = [];

        function animate(timestamp) {
            if (timestamp - previousTime < 16) {
                animationFrame = requestAnimationFrame(animate);
                return;
            }

            const deltaTime = previousTime
                ? Math.min(timestamp - previousTime, 50)
                : 16;

            previousTime = timestamp;

            const targetBands = bandsRef.current;
            let totalEnergy = 0;

            for (let i = 0; i < 8; i++) {
                const target = Math.max(
                    0,
                    Math.min(1, Number(targetBands[i]) || 0)
                );

                const smoothing = target > smoothedBands[i]
                    ? 0.48
                    : 0.16;

                smoothedBands[i] +=
                    (target - smoothedBands[i]) * smoothing;

                totalEnergy += smoothedBands[i];
            }

            const energy = totalEnergy / 8;

            energyHistory.push(energy);

            if (energyHistory.length > 35) {
                energyHistory.shift();
            }

            const averageEnergy =
                energyHistory.reduce((sum, value) => sum + value, 0) /
                energyHistory.length;

            const isBeat =
                energyHistory.length >= 12 &&
                energy > averageEnergy * 1.18 + 0.018 &&
                energy > 0.055 &&
                timestamp - lastBeatTime > 250;

            if (isBeat) {
                if (lastBeatTime > 0) {
                    const interval = timestamp - lastBeatTime;

                    if (interval >= 280 && interval <= 1300) {
                        beatIntervals.push(interval);

                        if (beatIntervals.length > 6) {
                            beatIntervals.shift();
                        }

                        const averageInterval =
                            beatIntervals.reduce(
                                (sum, value) => sum + value,
                                0
                            ) / beatIntervals.length;

                        estimatedBpm = Math.round(
                            60000 / averageInterval
                        );
                    }
                }

                lastBeatTime = timestamp;
                beatPulse = 1;
            }

            beatPulse *= Math.exp(-deltaTime / 150);

            const time = timestamp / 1000;
            const baseHue = 265 + Math.sin(time * 0.65) * 5;

            const visualizer = visualizerRef.current;

            if (visualizer) {
                visualizer.style.setProperty(
                    "--beat-pulse",
                    beatPulse.toFixed(3)
                );

                visualizer.style.setProperty(
                    "--beat-glow",
                    `${16 + beatPulse * 42}px`
                );

                visualizer.style.setProperty(
                    "--beat-scale",
                    `${1 + beatPulse * 0.09}`
                );

                visualizer.style.setProperty(
                    "--beat-hue",
                    `${baseHue}deg`
                );

                visualizer.style.setProperty(
                    "--beat-bpm",
                    estimatedBpm
                );
            }

            for (let i = 0; i < barCount; i++) {
                const position = (i / barCount) * 8;

                const lowerIndex = Math.floor(position) % 8;
                const upperIndex = (lowerIndex + 1) % 8;

                const blend = position - Math.floor(position);

                const intensity =
                    smoothedBands[lowerIndex] * (1 - blend) +
                    smoothedBands[upperIndex] * blend;

                const localWave =
                    Math.sin(time * 2.2 + i * 0.35) * 4;

                const beatContribution =
                    beatPulse * (18 + intensity * 28);

                const height = Math.max(
                    5,
                    8 + intensity * 105 + beatContribution + localWave
                );

                const hue =
                    baseHue + Math.sin(i * 0.15) * 13;

                const bar = barsRef.current[i];

                if (!bar) continue;

                bar.style.setProperty(
                    "--bar-height",
                    `${height}px`
                );

                bar.style.setProperty(
                    "--bar-hue",
                    `${hue}deg`
                );

                bar.style.setProperty(
                    "--bar-opacity",
                    `${0.7 + intensity * 0.3}`
                );

                bar.style.setProperty(
                    "--bar-glow",
                    `${7 + beatPulse * 18}px`
                );
            }

            animationFrame = requestAnimationFrame(animate);
        }

        animationFrame = requestAnimationFrame(animate);

        return () => {
            cancelAnimationFrame(animationFrame);
        };
    }, [bandsRef]);

    return (
        <div
            ref={visualizerRef}
            className="visualizer"
            aria-hidden="true"
        >
            {Array.from({ length: 48 }, (_, index) => (
                <span
                    key={index}
                    ref={element => {
                        barsRef.current[index] = element;
                    }}
                    className={`visualizer-bar ${
                        index % 2 === 0 ? "outward" : "inward"
                    }`}
                    style={{
                        "--angle": `${(index / 48) * 360}deg`
                    }}
                />
            ))}
        </div>
    );
}

export default function App() {
    const socketRef = useRef(null);

    const queueListRef = useRef(null);
    const dragPointerYRef = useRef(null);
    const dragScrollFrameRef = useRef(null);

    const [current, setCurrent] = useState(null);
    const [queue, setQueue] = useState([]);
    const [playing, setPlaying] = useState(false);
    const [playbackStatus, setPlaybackStatus] = useState("idle");
    const [processingNext, setProcessingNext] = useState(false);
    const [loop, setLoop] = useState(false);
    const [dragged, setDragged] = useState(null);

    const [progressMs, setProgressMs] = useState(0);
    const [seekPreviewMs, setSeekPreviewMs] = useState(null);

    const visualizerBandsRef = useRef(Array(8).fill(0));

    const progressBaseRef = useRef(0);
    const progressReceivedAtRef = useRef(Date.now());
    const seekingRef = useRef(false);

    const processingNextRef = useRef(false);
    const skipSawStopRef = useRef(false);
    const skipTrackKeyRef = useRef(null);

    const [connected, setConnected] = useState(false);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (playbackStatus !== "playing") return;

        const interval = setInterval(() => {
            const elapsed = Date.now() - progressReceivedAtRef.current;
            const nextProgress = progressBaseRef.current + elapsed;

            setProgressMs(nextProgress);
        }, 100);

        return () => clearInterval(interval);
    }, [playbackStatus]);

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
                    throw new Error(
                        "Falha na autenticação com o Discord."
                    );
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

                socket.addEventListener("message", event => {
                    const message = JSON.parse(event.data);

                    if (message.type === "authenticated") {
                        setConnected(true);
                        setError("");
                    }

                    if (message.type === "state") {
                        const nextTrack = message.currentTrack;
                        const nextStatus = message.status || "idle";
                        const nextQueue = message.tracks || [];

                        setCurrent(nextTrack);
                        setQueue(nextQueue);
                        setLoop(message.loop === true);
                        setPlaybackStatus(nextStatus);
                        setPlaying(nextStatus === "playing");

                        const nextPosition = Number(message.positionMs);

                        progressBaseRef.current =
                            Number.isFinite(nextPosition)
                                ? Math.max(0, nextPosition)
                                : 0;

                        progressReceivedAtRef.current = Date.now();
                        setProgressMs(progressBaseRef.current);

                        if (!nextTrack) {
                            progressBaseRef.current = 0;
                            setProgressMs(0);
                            setSeekPreviewMs(null);
                            visualizerBandsRef.current = Array(8).fill(0);
                        }

                        if (processingNextRef.current) {
                            const nextTrackKey = nextTrack
                                ? `${nextTrack.title}|${nextTrack.artist}`
                                : null;

                            if (nextStatus !== "playing") {
                                skipSawStopRef.current = true;
                            }

                            if (
                                !nextTrack ||
                                (
                                    nextStatus === "playing" &&
                                    (
                                        skipSawStopRef.current ||
                                        nextTrackKey !== skipTrackKeyRef.current
                                    )
                                )
                            ) {
                                processingNextRef.current = false;
                                skipSawStopRef.current = false;
                                setProcessingNext(false);
                            }
                        }

                        // A primeira mensagem state conclui a inicialização.
                        setLoading(false);
                    }

                    if (message.type === "progress") {
                        const nextPosition = Number(message.positionMs);

                        if (Number.isFinite(nextPosition)) {
                            progressBaseRef.current = Math.max(
                                0,
                                nextPosition
                            );

                            progressReceivedAtRef.current = Date.now();
                            setProgressMs(progressBaseRef.current);
                        }

                        if (message.status) {
                            setPlaybackStatus(message.status);
                            setPlaying(message.status === "playing");
                        }
                    }

                    if (message.type === "visualizer") {
                        if (
                            Array.isArray(message.bands) &&
                            message.bands.length === 8
                        ) {
                            visualizerBandsRef.current = message.bands;
                        }
                    }

                    if (message.type === "error") {
                        setError(
                            message.message || "Erro no servidor."
                        );

                        processingNextRef.current = false;
                        skipSawStopRef.current = false;
                        setProcessingNext(false);

                        // Evita manter a tela de loading em caso de erro.
                        setLoading(false);
                    }
                });

                socket.addEventListener("close", () => {
                    if (!cancelled) {
                        setConnected(false);
                        setLoading(false);
                        setError("Conexão com o bot encerrada.");

                        processingNextRef.current = false;
                        setProcessingNext(false);
                    }
                });

                socket.addEventListener("error", () => {
                    if (!cancelled) {
                        setError(
                            "Não foi possível conectar ao servidor do bot."
                        );
                        setLoading(false);
                    }
                });

            } catch (err) {
                console.error("[Activity]", err);

                if (!cancelled) {
                    setError(
                        err.message || "Erro ao iniciar a Activity."
                    );
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

    function getSeekPosition(event) {
        const durationMs = Number(current?.duration) * 1000;

        if (!Number.isFinite(durationMs) || durationMs <= 0) {
            return null;
        }

        const rect = event.currentTarget.getBoundingClientRect();

        if (rect.width <= 0) return null;

        const percentage = Math.max(
            0,
            Math.min(1, (event.clientX - rect.left) / rect.width)
        );

        return percentage * durationMs;
    }

    function handleSeekStart(event) {
        if (!connected || !current || !Number(current.duration)) return;

        event.preventDefault();

        const position = getSeekPosition(event);

        if (position === null) return;

        seekingRef.current = true;
        setSeekPreviewMs(position);

        event.currentTarget.setPointerCapture(event.pointerId);
    }

    function handleSeekMove(event) {
        if (!seekingRef.current) return;

        const position = getSeekPosition(event);

        if (position !== null) {
            setSeekPreviewMs(position);
        }
    }

    function handleSeekEnd(event) {
        if (!seekingRef.current) return;

        const position = getSeekPosition(event);

        seekingRef.current = false;
        setSeekPreviewMs(null);

        if (position === null) return;

        progressBaseRef.current = position;
        progressReceivedAtRef.current = Date.now();
        setProgressMs(position);

        sendAction("seek", {
            positionSeconds: position / 1000
        });
    }

    function handleSeekCancel() {
        seekingRef.current = false;
        setSeekPreviewMs(null);
    }

    function handleNext() {
        const socket = socketRef.current;

        if (!socket || socket.readyState !== WebSocket.OPEN || !current) {
            return;
        }

        processingNextRef.current = true;
        skipSawStopRef.current = false;

        skipTrackKeyRef.current = current
            ? `${current.title}|${current.artist}`
            : null;

        setProcessingNext(true);

        sendAction("next");
    }

    /* Auto-scroll da fila durante o arraste */
    function autoScrollQueue() {
        const container = queueListRef.current;
        const pointerY = dragPointerYRef.current;

        if (!container || pointerY === null) {
            dragScrollFrameRef.current = null;
            return;
        }

        const rect = container.getBoundingClientRect();

        const edgeSize = 75;
        const maxSpeed = 14;

        let scrollSpeed = 0;

        if (pointerY < rect.top + edgeSize) {
            const intensity = Math.min(
                1,
                (rect.top + edgeSize - pointerY) / edgeSize
            );

            scrollSpeed = -Math.ceil(intensity * maxSpeed);
        } else if (pointerY > rect.bottom - edgeSize) {
            const intensity = Math.min(
                1,
                (pointerY - (rect.bottom - edgeSize)) / edgeSize
            );

            scrollSpeed = Math.ceil(intensity * maxSpeed);
        }

        if (scrollSpeed !== 0) {
            container.scrollTop += scrollSpeed;
        }

        dragScrollFrameRef.current =
            requestAnimationFrame(autoScrollQueue);
    }

    function handleQueueDragOver(event) {
        event.preventDefault();

        dragPointerYRef.current = event.clientY;

        if (dragScrollFrameRef.current === null) {
            dragScrollFrameRef.current =
                requestAnimationFrame(autoScrollQueue);
        }
    }

    function stopQueueAutoScroll() {
        if (dragScrollFrameRef.current !== null) {
            cancelAnimationFrame(dragScrollFrameRef.current);
            dragScrollFrameRef.current = null;
        }

        dragPointerYRef.current = null;
    }

    function moveTrack(targetIndex) {
        if (dragged === null || dragged === targetIndex) return;

        sendAction("reorder", {
            fromIndex: dragged,
            toIndex: targetIndex
        });

        setDragged(null);
        stopQueueAutoScroll();
    }

    const durationMs = Number(current?.duration) * 1000;

    const displayedProgressMs =
        seekPreviewMs !== null ? seekPreviewMs : progressMs;

    const progressPercentage =
        Number.isFinite(durationMs) && durationMs > 0
            ? Math.min((displayedProgressMs / durationMs) * 100, 100)
            : 0;

    return (
        <main className={`app ${loading ? "is-loading" : ""}`}>
            <section className="now-playing">
                <AudioVisualizer bandsRef={visualizerBandsRef} />

                <div className="section-label">TOCANDO AGORA</div>

                <TrackImage
                    src={current?.thumbnail}
                    className="track-art"
                />

                <div className="track-info">
                    <h2>{current?.title || "Nenhuma música"}</h2>
                    <p>{current?.artist || "Aguardando música"}</p>
                </div>

                <div className={`progress ${seekPreviewMs !== null ? "is-seeking" : ""}`}>
                    <div
                        className="progress-bar"
                        role="slider"
                        aria-label="Posição da música"
                        aria-valuemin={0}
                        aria-valuemax={Number.isFinite(durationMs) ? durationMs : 0}
                        aria-valuenow={displayedProgressMs}
                        aria-disabled={!connected || !current}
                        tabIndex={connected && current ? 0 : -1}
                        style={{
                            cursor: connected && current ? "pointer" : "default",
                            touchAction: "none"
                        }}
                        onPointerDown={handleSeekStart}
                        onPointerMove={handleSeekMove}
                        onPointerUp={handleSeekEnd}
                        onPointerCancel={handleSeekCancel}
                    >
                        <div
                            className="progress-fill"
                            style={{
                                width: `${progressPercentage}%`
                            }}
                        />

                        {seekPreviewMs !== null && (
                            <div
                                className="progress-marker"
                                style={{ left: `${progressPercentage}%` }}
                            >
                                <span>
                                    {formatDuration(seekPreviewMs / 1000)}
                                </span>
                            </div>
                        )}
                    </div>

                    <div className="progress-time">
                        <span>
                            {formatDuration(displayedProgressMs / 1000)}
                        </span>

                        <span>
                            {formatDuration(current?.duration)}
                        </span>
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
                        disabled={
                            !connected ||
                            !current ||
                            !["playing", "paused"].includes(playbackStatus)
                        }
                        title={playing ? "Pausar" : "Retomar"}
                    >
                        {playing ? (
                            <span className="pause-icon">
                                <i />
                                <i />
                            </span>
                        ) : (
                            <svg
                                className="play-icon"
                                xmlns="http://www.w3.org/2000/svg"
                                viewBox="0 0 24 24"
                                fill="white"
                                aria-hidden="true"
                            >
                                <path d="m8.462 2.38 12.11 7.064c.204.135.395.276.567.451.41.416.692.952.806 1.525.167.847-.05 1.72-.565 2.408a3.1 3.1 0 0 1-.868.764L8.445 21.63c-.217.112-.44.211-.677.271a3.04 3.04 0 0 1-2.096-.21 3.03 3.03 0 0 1-1.493-1.669A3.2 3.2 0 0 1 4 19.011l.001-14.088a3.2 3.2 0 0 1 .211-1.031 3 3 0 0 1 1.421-1.563 3.04 3.04 0 0 1 1.905-.281c.327.06.631.177.924.332" />
                            </svg>
                        )}
                    </button>

                    <button
                        className="control-button"
                        onClick={handleNext}
                        disabled={!connected || !current}
                        title="Próxima música"
                    >
                        ⏭
                    </button>
                </div>

                <div className="playback-status">
                    {loading
                        ? "Conectando..."
                        : processingNext
                            ? "Processando..."
                            : playbackStatus === "playing"
                                ? "Reproduzindo"
                                : playbackStatus === "paused"
                                    ? "Pausado"
                                    : current
                                        ? "Preparando reprodução..."
                                        : "Aguardando música"}

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

                <div
                    className="queue-list"
                    ref={queueListRef}
                    onDragOver={handleQueueDragOver}
                >
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
                                onDragStart={() => {
                                    setDragged(index);
                                    dragPointerYRef.current = null;
                                }}
                                onDragOver={event => event.preventDefault()}
                                onDrop={() => moveTrack(index)}
                                onDragEnd={() => {
                                    setDragged(null);
                                    stopQueueAutoScroll();
                                }}
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
                <span> • </span>
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
