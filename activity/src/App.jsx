
import { useState } from "react";
import "./App.css";

const initialQueue = [
  { id: 1, title: "After Dark", artist: "Mr.Kitty", duration: "4:17" },
  { id: 2, title: "The Perfect Girl", artist: "Mareux", duration: "3:14" },
  { id: 3, title: "Resonance", artist: "HOME", duration: "3:32" },
  { id: 4, title: "Memory Reboot", artist: "VØJ, Narvent", duration: "3:29" },
];

export default function App() {
  const [current, setCurrent] = useState({
    title: "Little Dark Age",
    artist: "MGMT",
    duration: "4:59",
  });

  const [queue, setQueue] = useState(initialQueue);
  const [playing, setPlaying] = useState(true);
  const [loop, setLoop] = useState(false);
  const [dragged, setDragged] = useState(null);

  function nextTrack() {
    if (queue.length === 0) return;

    setCurrent(queue[0]);
    setQueue((previous) => previous.slice(1));
    setPlaying(true);
  }

  function shuffleQueue() {
    setQueue((previous) => {
      const shuffled = [...previous];

      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }

      return shuffled;
    });
  }

  function moveTrack(targetId) {
    if (!dragged || dragged === targetId) return;

    setQueue((previous) => {
      const items = [...previous];
      const from = items.findIndex((track) => track.id === dragged);
      const to = items.findIndex((track) => track.id === targetId);

      if (from === -1 || to === -1) return previous;

      const [moved] = items.splice(from, 1);
      items.splice(to, 0, moved);

      return items;
    });

    setDragged(null);
  }

  return (
    <main className="app">
      <section className="now-playing">
        <div className="section-label">TOCANDO AGORA</div>

        <div className="track-art">
          <span>♫</span>
        </div>

        <div className="track-info">
          <h2>{current.title}</h2>
          <p>{current.artist}</p>
        </div>

        <div className="progress">
          <div className="progress-bar">
            <div className="progress-fill" />
          </div>
          <div className="progress-time">
            <span>0:00</span>
            <span>{current.duration}</span>
          </div>
        </div>

        <div className="controls">
          <button
            className={`control-button ${loop ? "active" : ""}`}
            onClick={() => setLoop(!loop)}
            title="Repetir música atual"
          >
            ↻
          </button>

          <button
            className="play-button"
            onClick={() => setPlaying(!playing)}
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
            onClick={nextTrack}
            title="Próxima música"
          >
            ⏭
          </button>
        </div>

        <div className="playback-status">
          {playing ? "Reproduzindo" : "Pausado"}
          {loop && " · Repetição ativada"}
        </div>
      </section>

      <section className="queue-section">
        <div className="queue-header">
          <div>
            <div className="section-label">PRÓXIMAS MÚSICAS</div>
            <h2>Fila de reprodução</h2>
            <p>{queue.length} músicas na fila</p>
          </div>

          <button className="shuffle-button" onClick={shuffleQueue}>
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
                key={track.id}
                className={`queue-item ${dragged === track.id ? "dragging" : ""}`}
                draggable
                onDragStart={() => setDragged(track.id)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => moveTrack(track.id)}
                onDragEnd={() => setDragged(null)}
              >
                <span className="queue-number">{index + 1}</span>

                <div className="mini-art">♫</div>

                <div className="queue-track-info">
                  <strong>{track.title}</strong>
                  <span>{track.artist}</span>
                </div>

                <span className="duration">{track.duration}</span>
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
      </footer>
    </main>
  );
}
