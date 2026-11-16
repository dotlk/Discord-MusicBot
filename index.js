
require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");

// Limpa as pastas temporárias deixadas pela execução anterior.
function cleanTempOnStartup() {
    const tempDir = path.resolve(__dirname, "temp");
    const ytDlpTempDir = path.resolve(__dirname, ".yt-dlp-tmp");

    // Limpa as filas persistidas.
    fs.mkdirSync(tempDir, { recursive: true });

    for (const entry of fs.readdirSync(tempDir)) {
        fs.rmSync(path.join(tempDir, entry), {
            recursive: true,
            force: true
        });
    }

    // Remove completamente a pasta temporária do yt-dlp.
    fs.rmSync(ytDlpTempDir, {
        recursive: true,
        force: true
    });

    console.log("🧹 Pasta temp limpa na inicialização.");
    console.log("🧹 Pasta .yt-dlp-tmp limpa na inicialização.");
}

try {
    cleanTempOnStartup();
} catch (error) {
    console.error("❌ Falha ao limpar pastas temporárias:", error);
    process.exit(1);
}

const client = require("./src/discord/client");

// Registra os eventos
require("./src/events/ready")(client);
require("./src/events/interactionCreate")(client);

console.log("🚀 Tentando conectar ao Discord...");

client.login(process.env.DISCORD_TOKEN)
    .then(() => console.log("✅ Login concluído!"))
    .catch(error => {
        console.error("❌ Erro ao conectar:", error);
        process.exitCode = 1;
    });
