
const {
    Events,
    MessageFlags,
    PermissionFlagsBits,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType
} = require("discord.js");

const {
    getVoiceConnection,
    AudioPlayerStatus
} = require("@discordjs/voice");

const {
    joinChannel,
    leaveChannel
} = require("../audio/voiceManager");

const {
    getQueue,
    addTrack
} = require("../audio/queueManager");

const {
    playNext,
    skipTrack
} = require("../audio/player");

const {
    isYouTubeUrl,
    getVideoInfo
} = require("../audio/youtube");

const {
    handleQueue
} = require("../commands/queue");

// Máximo de solicitações /play em processamento
// simultaneamente por servidor.
const MAX_CONCURRENT_PLAYS = 3;

// guildId -> quantidade de solicitações em andamento
const playLocks = new Map();

// Impede duas inicializações simultâneas de reprodução
// dentro do mesmo servidor.
const playbackStarts = new Set();

function acquirePlaySlot(guildId) {
    const active = playLocks.get(guildId) || 0;

    if (active >= MAX_CONCURRENT_PLAYS) {
        return false;
    }

    playLocks.set(guildId, active + 1);
    return true;
}

function releasePlaySlot(guildId) {
    const active = playLocks.get(guildId) || 0;

    if (active <= 1) {
        playLocks.delete(guildId);
    } else {
        playLocks.set(guildId, active - 1);
    }
}

function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) {
        return "Desconhecida";
    }

    const total = Math.floor(seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const remaining = total % 60;

    if (hours > 0) {
        return [
            hours,
            String(minutes).padStart(2, "0"),
            String(remaining).padStart(2, "0")
        ].join(":");
    }

    return `${minutes}:${String(remaining).padStart(2, "0")}`;
}

module.exports = function registerInteractionEvent(client) {
    client.on(Events.InteractionCreate, async interaction => {
        if (!interaction.isChatInputCommand()) return;

        try {
            const command = interaction.commandName;

            console.log(
                `🎵 Comando recebido: /${command}`
            );

            if (!interaction.inGuild()) {
                return await interaction.reply({
                    content:
                        "❌ Este comando só funciona em servidores.",
                    flags: MessageFlags.Ephemeral
                });
            }

            switch (command) {

                // ==============================
                // /JOIN
                // ==============================
                case "join": {
                    const member =
                        await interaction.guild.members.fetch(
                            interaction.user.id
                        );

                    const channel = member.voice.channel;

                    if (!channel) {
                        return await interaction.reply({
                            content:
                                "❌ Entre em um canal de voz primeiro!",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    const existingConnection =
                        getVoiceConnection(
                            interaction.guildId
                        );

                    if (
                        existingConnection &&
                        existingConnection.joinConfig.channelId !==
                        channel.id
                    ) {
                        return await interaction.reply({
                            content:
                                "❌ Já estou conectado a outro canal de voz.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    const permissions =
                        channel.permissionsFor(
                            interaction.guild.members.me
                        );

                    if (
                        !permissions?.has(
                            PermissionFlagsBits.Connect
                        ) ||
                        !permissions?.has(
                            PermissionFlagsBits.Speak
                        )
                    ) {
                        return await interaction.reply({
                            content:
                                "❌ Não tenho permissão para entrar ou falar nesse canal.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    await interaction.deferReply();

                    await joinChannel(channel);

                    await interaction.editReply({
                        content:
                            `🔊 Entrei no canal **${channel.name}**!`
                    });

                    break;
                }

                // ==============================
                // /PLAY
                // ==============================
                case "play": {
                    const guildId = interaction.guildId;

                    const query = interaction.options
                        .getString("query", true)
                        .trim();

                    if (!isYouTubeUrl(query)) {
                        return await interaction.reply({
                            content:
                                "❌ Por enquanto, envie um link válido do YouTube.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    const member =
                        await interaction.guild.members.fetch(
                            interaction.user.id
                        );

                    const channel = member.voice.channel;

                    if (!channel) {
                        return await interaction.reply({
                            content:
                                "❌ Entre em um canal de voz primeiro!",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    const existingConnection =
                        getVoiceConnection(guildId);

                    if (
                        existingConnection &&
                        existingConnection.joinConfig.channelId !==
                        channel.id
                    ) {
                        return await interaction.reply({
                            content:
                                "❌ Você precisa estar no mesmo canal de voz que eu.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    const permissions =
                        channel.permissionsFor(
                            interaction.guild.members.me
                        );

                    if (
                        !permissions?.has(
                            PermissionFlagsBits.Connect
                        ) ||
                        !permissions?.has(
                            PermissionFlagsBits.Speak
                        )
                    ) {
                        return await interaction.reply({
                            content:
                                "❌ Não tenho permissão para entrar ou falar nesse canal.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    // Reserva uma das 3 vagas do servidor.
                    if (!acquirePlaySlot(guildId)) {
                        return await interaction.reply({
                            content:
                                "⏳ Este servidor já está processando 3 músicas. " +
                                "Aguarde uma solicitação terminar.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    try {
                        await interaction.deferReply();

                        const track =
                            await getVideoInfo(query);

                        track.requestedBy =
                            interaction.user.id;

                        // Outra solicitação pode ter conectado
                        // o bot enquanto aguardávamos o yt-dlp.
                        const currentConnection =
                            getVoiceConnection(guildId);

                        if (
                            currentConnection &&
                            currentConnection.joinConfig.channelId !==
                            channel.id
                        ) {
                            await interaction.editReply({
                                content:
                                    "❌ O bot foi conectado a outro canal de voz."
                            });
                            break;
                        }

                        const connection =
                            await joinChannel(channel);

                        if (
                            getVoiceConnection(guildId) !==
                            connection
                        ) {
                            await interaction.editReply({
                                content:
                                    "❌ A conexão foi encerrada durante a solicitação."
                            });
                            break;
                        }

                        // A fila é compartilhada por servidor.
                        // Este trecho é síncrono, portanto as
                        // inserções não se sobrepõem no Node.js.
                        const previousQueue =
                            getQueue(guildId);

                        const playerStatus =
                            previousQueue?.player?.state.status;

                        const isPlaying =
                            Boolean(
                                previousQueue?.currentTrack
                            ) ||
                            playerStatus ===
                                AudioPlayerStatus.Playing ||
                            playerStatus ===
                                AudioPlayerStatus.Buffering ||
                            playbackStarts.has(guildId);

                        const position = addTrack(
                            guildId,
                            track
                        );

                        if (!isPlaying) {
                            // Reserva a inicialização antes
                            // de iniciar o processamento.
                            playbackStarts.add(guildId);

                            void playNext(guildId)
                                .catch(error => {
                                    console.error(
                                        `❌ Erro ao iniciar música (${guildId}):`,
                                        error
                                    );
                                })
                                .finally(() => {
                                    playbackStarts.delete(guildId);
                                });

                            await interaction.editReply({
                                content:
                                    `▶️ **Iniciando reprodução:** ${track.title}\n` +
                                    `⏱️ Duração: ${formatDuration(track.duration)}`
                            });
                        } else {
                            await interaction.editReply({
                                content:
                                    `➕ **Adicionado à fila:** ${track.title}\n` +
                                    `⏱️ Duração: ${formatDuration(track.duration)}\n` +
                                    `📋 Posição: ${position}`
                            });
                        }

                    } finally {
                        // Libera somente a vaga desta solicitação.
                        releasePlaySlot(guildId);
                    }

                    break;
                }

                // ==============================
                // /QUEUE
                // ==============================
                case "queue": {
                    await handleQueue(interaction);
                    break;
                }

                // ==============================
                // /SKIP
                // ==============================
                case "skip": {
                    const guildId = interaction.guildId;

                    const connection =
                        getVoiceConnection(guildId);

                    if (!connection) {
                        return await interaction.reply({
                            content:
                                "❌ Não estou conectado a nenhum canal de voz.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    const member =
                        await interaction.guild.members.fetch(
                            interaction.user.id
                        );

                    if (
                        member.voice.channelId !==
                        connection.joinConfig.channelId
                    ) {
                        return await interaction.reply({
                            content:
                                "❌ Você precisa estar no mesmo canal de voz que eu.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    const queue = getQueue(guildId);

                    if (!queue?.currentTrack) {
                        return await interaction.reply({
                            content:
                                "❌ Não há nenhuma música tocando.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    const currentTitle =
                        queue.currentTrack.title;

                    const nextTitle =
                        queue.tracks[0]?.title;

                    if (!skipTrack(guildId)) {
                        return await interaction.reply({
                            content:
                                "❌ Não foi possível pular a música.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    await interaction.reply({
                        content: nextTitle
                            ? `⏭️ **Pulada:** ${currentTitle}\n` +
                              `▶️ **Próxima:** ${nextTitle}`
                            : `⏭️ **Pulada:** ${currentTitle}\n` +
                              "⏹️ Não há mais músicas na fila."
                    });

                    break;
                }

                // ==============================
                // /STOP
                // ==============================
                case "stop": {
                    const guildId = interaction.guildId;

                    const connection =
                        getVoiceConnection(guildId);

                    if (!connection) {
                        return await interaction.reply({
                            content:
                                "❌ Não estou conectado a nenhum canal de voz.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    const member =
                        await interaction.guild.members.fetch(
                            interaction.user.id
                        );

                    if (
                        member.voice.channelId !==
                        connection.joinConfig.channelId
                    ) {
                        return await interaction.reply({
                            content:
                                "❌ Você precisa estar no mesmo canal de voz que eu.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    const confirmButton =
                        new ButtonBuilder()
                            .setCustomId("stop_confirm")
                            .setLabel("Confirmar")
                            .setEmoji("✅")
                            .setStyle(ButtonStyle.Danger);

                    const cancelButton =
                        new ButtonBuilder()
                            .setCustomId("stop_cancel")
                            .setLabel("Cancelar")
                            .setEmoji("❌")
                            .setStyle(ButtonStyle.Secondary);

                    const row =
                        new ActionRowBuilder()
                            .addComponents(
                                confirmButton,
                                cancelButton
                            );

                    const response =
                        await interaction.reply({
                            content:
                                "⏹️ **Encerrar reprodução?**\n\n" +
                                "Isso interromperá a música, limpará a fila " +
                                "e desconectará o bot do canal de voz.",
                            components: [row],
                            flags: MessageFlags.Ephemeral,
                            withResponse: true
                        });

                    try {
                        const confirmation =
                            await response.resource.message
                                .awaitMessageComponent({
                                    componentType:
                                        ComponentType.Button,
                                    filter: button =>
                                        button.user.id ===
                                        interaction.user.id,
                                    time: 30000
                                });

                        if (
                            confirmation.customId ===
                            "stop_cancel"
                        ) {
                            await confirmation.update({
                                content:
                                    "❎ Operação cancelada.",
                                components: []
                            });

                            break;
                        }

                        const currentConnection =
                            getVoiceConnection(guildId);

                        const currentMember =
                            await interaction.guild.members.fetch(
                                interaction.user.id
                            );

                        if (
                            !currentConnection ||
                            currentMember.voice.channelId !==
                            currentConnection.joinConfig.channelId
                        ) {
                            await confirmation.update({
                                content:
                                    "❌ Você não está mais no mesmo canal de voz que o bot.",
                                components: []
                            });

                            break;
                        }

                        leaveChannel(guildId);

                        await confirmation.update({
                            content:
                                "⏹️ Reprodução encerrada! Saí do canal de voz.",
                            components: []
                        });

                    } catch (error) {
                        await interaction.editReply({
                            content:
                                "⌛ Tempo esgotado. Operação cancelada.",
                            components: []
                        }).catch(console.error);
                    }

                    break;
                }

                // ==============================
                // COMANDOS FUTUROS
                // ==============================
                default: {
                    await interaction.reply({
                        content:
                            `🚧 O comando /${command} está em desenvolvimento!`,
                        flags: MessageFlags.Ephemeral
                    });
                }
            }

        } catch (error) {
            console.error(
                "❌ Erro ao executar comando:",
                error
            );

            if (
                interaction.deferred ||
                interaction.replied
            ) {
                await interaction.editReply({
                    content:
                        "❌ Ocorreu um erro ao executar o comando.",
                    components: []
                }).catch(console.error);
            } else {
                await interaction.reply({
                    content:
                        "❌ Ocorreu um erro ao executar o comando.",
                    flags: MessageFlags.Ephemeral
                }).catch(console.error);
            }
        }
    });
};
