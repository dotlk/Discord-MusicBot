
require("dotenv").config();

const {
    REST,
    Routes,
    SlashCommandBuilder
} = require("discord.js");

// Comandos slash do BicodeMelBot
const commands = [
    new SlashCommandBuilder()
        .setName("join")
        .setDescription("Entra no seu canal de voz."),

    new SlashCommandBuilder()
        .setName("play")
        .setDescription("Reproduz uma música ou adiciona uma playlist à fila.")
        .addStringOption(option =>
            option
                .setName("query")
                .setDescription("Nome da música ou link do YouTube/Spotify")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("pause")
        .setDescription("Pausa ou retoma a música atual."),

    new SlashCommandBuilder()
        .setName("skip")
        .setDescription("Pula a música atual."),

    new SlashCommandBuilder()
        .setName("queue")
        .setDescription("Mostra a fila de reprodução."),

    new SlashCommandBuilder()
        .setName("remove")
        .setDescription("Remove uma música específica da fila.")
        .addIntegerOption(option =>
            option
                .setName("position")
                .setDescription("Posição da música na fila")
                .setMinValue(1)
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("clear")
        .setDescription("Remove todas as músicas da fila."),

    new SlashCommandBuilder()
        .setName("next")
        .setDescription("Escolhe a próxima música ou reproduz imediatamente.")
        .addIntegerOption(option =>
            option
                .setName("position")
                .setDescription("Posição da música na fila")
                .setMinValue(1)
                .setRequired(true)
        )
        .addBooleanOption(option =>
            option
                .setName("playnow")
                .setDescription("Tocar agora e colocar a música atual na fila?")
                .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName("loop")
        .setDescription("Ativa ou desativa a repetição da música atual."),

    new SlashCommandBuilder()
        .setName("stop")
        .setDescription("Para a reprodução, limpa a fila e desconecta o bot.")
].map(command => command.toJSON());

// Configuração da API do Discord
const rest = new REST({ version: "10" })
    .setToken(process.env.DISCORD_TOKEN);

// Registra os comandos globalmente
async function deployCommands() {
    try {
        if (!process.env.DISCORD_TOKEN || !process.env.CLIENT_ID) {
            throw new Error(
                "DISCORD_TOKEN ou CLIENT_ID não configurado no .env"
            );
        }

        console.log("🔄 Registrando comandos globais...");

        await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID),
            { body: commands }
        );

        console.log("✅ Comandos globais registrados com sucesso!");
        console.log(`🎵 ${commands.length} comandos disponíveis.`);

    } catch (error) {
        console.error("❌ Erro ao registrar comandos:", error);
        process.exitCode = 1;
    }
}

deployCommands();
