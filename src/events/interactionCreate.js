
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
    addTrack,
    removeTrack,
    clearQueue,
    prioritizeTrack
} = require("../audio/queueManager");

const {
    playNext,
    skipTrack,
    playPrioritizedNow
} = require("../audio/player");

const {
    isYouTubeUrl,
    getVideoInfo
} = require("../audio/youtube");

const {
    handleQueue
} = require("../commands/queue");

// Máximo de solicitações /play simultâneas por servidor.
const MAX_CONCURRENT_PLAYS = 3;

// guildId -> quantidade de solicitações em andamento
const playLocks = new Map();

// Impede inicializações simultâneas da reprodução.
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
                            `🔊 Entrei no canal **${channel.name}** a pedido de <@${interaction.user.id}>!`
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

                    // Limite de 3 processamentos por servidor.
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

                        // Verifica se outra solicitação
                        // conectou o bot durante o processamento.
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
                // /REMOVE
                // ==============================
                case "remove": {
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

                    const position = interaction.options
                        .getInteger("position", true);

                    const queue = getQueue(guildId);

                    if (
                        !Number.isInteger(position) ||
                        position < 1 ||
                        !queue ||
                        position > queue.tracks.length
                    ) {
                        return await interaction.reply({
                            content:
                                "❌ Posição inválida. Use `/queue` para consultar as músicas disponíveis.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    // Remove somente da fila de espera.
                    const removedTrack = removeTrack(
                        guildId,
                        position
                    );

                    if (!removedTrack) {
                        return await interaction.reply({
                            content:
                                "❌ Não foi possível remover essa música.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    await interaction.reply({
                        content:
                            `🗑️ **Música removida da fila:** ${removedTrack.title}\n` +
                            `📋 **Posição:** ${position}\n` +
                            `👤 **Removida por:** <@${interaction.user.id}>`
                    });

                    break;
                }

                // ==============================
                // /CLEAR
                // ==============================
                case "clear": {
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

                    if (!queue?.tracks?.length) {
                        return await interaction.reply({
                            content:
                                "📋 A fila de espera já está vazia.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    // Botões de confirmação
                    const confirmButton =
                        new ButtonBuilder()
                            .setCustomId("clear_confirm")
                            .setLabel("Confirmar")
                            .setEmoji("✅")
                            .setStyle(ButtonStyle.Danger);

                    const cancelButton =
                        new ButtonBuilder()
                            .setCustomId("clear_cancel")
                            .setLabel("Cancelar")
                            .setEmoji("❌")
                            .setStyle(ButtonStyle.Secondary);

                    const row =
                        new ActionRowBuilder()
                            .addComponents(
                                confirmButton,
                                cancelButton
                            );

                    // Confirmação privada
                    const response =
                        await interaction.reply({
                            content:
                                "🗑️ **Limpar a fila de reprodução?**\n\n" +
                                `Isso removerá **${queue.tracks.length} música(s)** ` +
                                "da fila de espera.\n" +
                                "A música atual continuará tocando.",
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
                            "clear_cancel"
                        ) {
                            await confirmation.update({
                                content:
                                    "❎ Limpeza da fila cancelada.",
                                components: []
                            });

                            break;
                        }

                        // Verifica novamente se o usuário
                        // permanece no mesmo canal do bot.
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

                        // Remove somente as músicas em espera.
                        const removedCount =
                            clearQueue(guildId);

                        await confirmation.update({
                            content:
                                `🗑️ **Fila limpa!** ${removedCount} música(s) removida(s).\n` +
                                "▶️ A música atual continuará tocando.",
                            components: []
                        });
                        await interaction.channel.send({
                            content:
                                `🗑️ <@${interaction.user.id}> limpou a fila de reprodução ` +
                                `(**${removedCount} música(s)** removida(s)).`,
                            allowedMentions: {
                                users: [interaction.user.id],
                                parse: []
                            }
                        }).catch(console.error);

                    } catch (error) {
                        console.error(
                            "Erro na confirmação do /clear:",
                            error
                        );

                        await interaction.editReply({
                            content:
                                "⌛ Tempo esgotado ou não foi possível confirmar. Operação cancelada.",
                            components: []
                        }).catch(console.error);
                    }

                    break;
                }

                // ==============================
                // /NEXT
                // ==============================
                case "next": {
                    const guildId = interaction.guildId;
                    const connection = getVoiceConnection(guildId);

                    if (!connection) {
                        return await interaction.reply({
                            content: "❌ Não estou conectado a nenhum canal de voz.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    const member = await interaction.guild.members.fetch(
                        interaction.user.id
                    );

                    if (
                        member.voice.channelId !==
                        connection.joinConfig.channelId
                    ) {
                        return await interaction.reply({
                            content: "❌ Você precisa estar no mesmo canal de voz que eu.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    const position = interaction.options.getInteger(
                        "position",
                        true
                    );
                    const playNow =
                        interaction.options.getBoolean("playnow") ?? false;
                    const queue = getQueue(guildId);

                    if (
                        !queue ||
                        position < 1 ||
                        position > queue.tracks.length
                    ) {
                        return await interaction.reply({
                            content: "❌ Posição inválida. Consulte `/queue`.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    if (playNow && (!queue.currentTrack || !queue.player)) {
                        return await interaction.reply({
                            content: "❌ Não há uma música atual para interromper.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    const result = playNow
                        ? playPrioritizedNow(guildId, position)
                        : prioritizeTrack(guildId, position);

                    if (!result) {
                        return await interaction.reply({
                            content: "❌ Não foi possível reorganizar a fila.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    await interaction.reply({
                        content: playNow
                            ? `▶️ <@${interaction.user.id}> escolheu **${result.selected.title}** para tocar agora.\n` +
                              `↩️ **${result.interrupted.title}** voltou para a fila e tocará desde o início.`
                            : `⏭️ <@${interaction.user.id}> colocou **${result.selected.title}** como próxima música.`,
                        allowedMentions: {
                            users: [interaction.user.id],
                            parse: []
                        }
                    });

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

                        // Verifica novamente a conexão.
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
                        await interaction.channel.send({
                            content:
                                `⏹️ <@${interaction.user.id}> encerrou a reprodução ` +
                                "e desconectou o bot do canal de voz.",
                            allowedMentions: {
                                users: [interaction.user.id],
                                parse: []
                            }
                        }).catch(console.error);

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
