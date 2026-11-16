
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

let tunnelProcess = null;

function getCloudflaredPath() {
    const binaries = {
        win32: "cloudflared-windows-amd64.exe",
        linux: "cloudflared-linux-amd64"
    };

    const binaryName = binaries[process.platform];

    if (!binaryName) {
        throw new Error(
            `Sistema operacional não suportado: ${process.platform}`
        );
    }

    const binaryPath = path.resolve(
        __dirname,
        "../../tools",
        binaryName
    );

    if (!fs.existsSync(binaryPath)) {
        throw new Error(`Executável não encontrado: ${binaryPath}`);
    }

    if (process.platform === "linux") {
        fs.chmodSync(binaryPath, 0o755);
    }

    return binaryPath;
}

function startCloudflareTunnel(
    port = Number(process.env.ACTIVITY_PORT || 3001)
) {
    if (tunnelProcess) {
        console.log("[Cloudflare] Túnel já iniciado.");
        return tunnelProcess;
    }

    let binaryPath;

    try {
        binaryPath = getCloudflaredPath();
    } catch (error) {
        console.error("[Cloudflare]", error.message);
        return null;
    }

    console.log(`[Cloudflare] Executável: ${binaryPath}`);
    console.log("[Cloudflare] Iniciando Quick Tunnel...");

    const args = [
        "tunnel",
        "--url",
        `http://127.0.0.1:${port}`
    ];

    tunnelProcess = spawn(binaryPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
    });

    function handleOutput(data) {
        const output = data.toString();

        for (const line of output.split(/\r?\n/)) {
            if (!line.trim()) continue;

            console.log(`[Cloudflare] ${line}`);

            const match = line.match(
                /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/
            );

            if (match) {
                console.log("----------------------------------------");
                console.log(`[Cloudflare] URL pública: ${match[0]}`);
                console.log("----------------------------------------");
            }
        }
    }

    tunnelProcess.stdout.on("data", handleOutput);
    tunnelProcess.stderr.on("data", handleOutput);

    tunnelProcess.on("error", error => {
        console.error(
            "[Cloudflare] Erro ao iniciar:",
            error.message
        );

        tunnelProcess = null;
    });

    tunnelProcess.on("close", code => {
        console.log(`[Cloudflare] Processo encerrado (código ${code}).`);
        tunnelProcess = null;
    });

    return tunnelProcess;
}

function stopCloudflareTunnel() {
    if (!tunnelProcess) return;

    tunnelProcess.kill();
    tunnelProcess = null;

    console.log("[Cloudflare] Túnel encerrado.");
}

module.exports = {
    startCloudflareTunnel,
    stopCloudflareTunnel
};
