
const fs = require("node:fs");
const path = require("node:path");

const ytDlpTempDir = path.resolve(
    __dirname,
    "../../.yt-dlp-tmp"
);

function getYtDlpPath() {
    const executable = process.platform === "win32"
        ? "yt-dlp.exe"
        : "yt-dlp";

    const localPath = path.resolve(
        __dirname,
        "../../bin",
        executable
    );

    return fs.existsSync(localPath)
        ? localPath
        : executable;
}

function getYtDlpEnv() {
    if (process.platform === "win32") {
        return process.env;
    }

    // Cria o diretório caso ainda não exista.
    fs.mkdirSync(ytDlpTempDir, {
        recursive: true
    });

    return {
        ...process.env,
        TMPDIR: ytDlpTempDir
    };
}

module.exports = {
    getYtDlpPath,
    getYtDlpEnv
};
