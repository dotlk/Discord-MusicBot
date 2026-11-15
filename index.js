require("dotenv").config();

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
