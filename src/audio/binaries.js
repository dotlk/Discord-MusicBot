const fs = require("node:fs");
const path = require("node:path");

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

module.exports = { getYtDlpPath };
