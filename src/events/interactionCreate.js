
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
    pauseMusicStatus,
    resumeMusicStatus
} = require("../discord/musicStatus");

const {
    joinChannel,
    leaveChannel
} = require("../audio/voiceManager");

const {
    getQueue,
    addTrack,
    addTracks,
    removeTrack,
    clearQueue,
    prioritizeTrack,
    toggleLoop,
    shuffleQueue
} = require("../audio/queueManager");

const {
    playNext,
    skipTrack,
    playPrioritizedNow
} = require("../audio/player");

const {
    isYouTubePlaylist,
    getVideoInfo,
    getPlaylistInfo
} = require("../audio/youtube");

const {
    parseSpotifyUrl,
    getSpotifyTrackInfo,
    getSpotifyPlaylistInfo,
    getSpotifyAlbumInfo
} = require("../audio/spotify");

const {
    handleQueue
} = require("../commands/queue");

const MAX_CONCURRENT_PLAYS = 3;

const playLocks = new Map();
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

// ==============================
// CONVITE DA ACTIVITY
// ==============================

function createActivityInviteRow(applicationId) {
    const button = new ButtonBuilder()
        .setLabel("🎵 Abrir Activity")
        .setStyle(ButtonStyle.Link)
        .setURL(`https://discord.com/activities/${applicationId}`);

    return new ActionRowBuilder().addComponents(button);
}

async function sendActivityInvite(interaction) {
    await interaction.channel.send({
        content:
            "🎵 **A central de música está pronta!**\n" +
            "Abra a Activity para acompanhar a fila e controlar a reprodução.",
        components: [
            createActivityInviteRow(interaction.applicationId)
        ]
    });
}

function isUnsupportedUrl(query) {
    try {
        const url = new URL(query);

        if (!["http:", "https:"].includes(url.protocol)) {
            return true;
        }

        const host = url.hostname.toLowerCase();

        return ![
            "youtube.com",
            "www.youtube.com",
            "m.youtube.com",
            "music.youtube.com",
            "youtu.be",
            "www.youtu.be",
            "open.spotify.com",
            "www.open.spotify.com"
        ].includes(host);
    } catch {
        return false;
    }
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
                        "Este comando só funciona em servidores.",
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
                                "Entre em um canal de voz primeiro!",
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
                                "Já estou conectado a outro canal de voz.",
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
                                "Não tenho permissão para entrar ou falar nesse canal.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    await interaction.deferReply();

                    await joinChannel(channel);

                    await interaction.editReply({
                        content:
                            `Entrei no canal **${channel.name}** a pedido de <@${interaction.user.id}>!`
                    });

                    await sendActivityInvite(interaction);

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

                    if (!query) {
                        return await interaction.reply({
                            content:
                                "Informe o nome ou link de uma música.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    if (isUnsupportedUrl(query)) {
                        return await interaction.reply({
                            content:
                                "Por enquanto, são aceitos links do YouTube e Spotify.",
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
                                "Entre em um canal de voz primeiro!",
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
                                "Você precisa estar no mesmo canal de voz que eu.",
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
                                "Não tenho permissão para entrar ou falar nesse canal.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    if (!acquirePlaySlot(guildId)) {
                        return await interaction.reply({
                            content:
                                "⏳ Este servidor já está processando 3 solicitações. " +
                                "Aguarde uma delas terminar.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    try {
                        await interaction.deferReply();

                        // ==============================
                        // IDENTIFICAÇÃO DA FONTE
                        // ==============================

                        const spotify = parseSpotifyUrl(query);

                        const youtubePlaylistMode = !spotify && isYouTubePlaylist(query);
                        const spotifyPlaylistMode = spotify?.type === "playlist";
                        const spotifyAlbumMode = spotify?.type === "album";
                        const playlistMode =
                            youtubePlaylistMode ||
                            spotifyPlaylistMode ||
                            spotifyAlbumMode;

                        const playlist = youtubePlaylistMode
                            ? await getPlaylistInfo(query)
                            : spotifyPlaylistMode
                                ? await getSpotifyPlaylistInfo(query)
                                : spotifyAlbumMode
                                    ? await getSpotifyAlbumInfo(query)
                                    : null;

                        let tracks;
                        if (playlistMode) {
                            tracks = playlist.tracks;
                        } else if (spotify) {
                            const spotifyTrack = await getSpotifyTrackInfo(query);
                            const youtubeTrack = await getVideoInfo(spotifyTrack.searchQuery);
                            youtubeTrack.spotify = {
                                id: spotifyTrack.id,
                                url: spotifyTrack.url,
                                title: spotifyTrack.title,
                                author: spotifyTrack.author
                            };
                            tracks = [youtubeTrack];
                        } else {
                            tracks = [await getVideoInfo(query)];
                        }

                        if (!tracks?.length) {
                            await interaction.editReply({
                                content:
                                    "Nenhuma música foi encontrada."
                            });
                            break;
                        }

                        for (const track of tracks) {
                            track.requestedBy =
                                interaction.user.id;
                        }

                        const track = tracks[0];

                        // ==============================
                        // CONEXÃO
                        // ==============================

                        const currentConnection =
                            getVoiceConnection(guildId);

                        if (
                            currentConnection &&
                            currentConnection.joinConfig.channelId !==
                            channel.id
                        ) {
                            await interaction.editReply({
                                content:
                                    "O bot foi conectado a outro canal de voz."
                            });
                            break;
                        }

                        // Identifica se esta solicitação fará o bot entrar na call.
                        const shouldSendActivityInvite = !currentConnection;

                        const connection =
                            await joinChannel(channel);

                        if (
                            getVoiceConnection(guildId) !==
                            connection
                        ) {
                            await interaction.editReply({
                                content:
                                    "A conexão foi encerrada durante a solicitação."
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

                        // ==============================
                        // FILA
                        // ==============================

                        const position = playlistMode
                            ? addTracks(guildId, tracks)
                            : addTrack(guildId, track);

                        // ==============================
                        // REPRODUÇÃO
                        // ==============================

                        if (!isPlaying) {
                            playbackStarts.add(guildId);

                            void playNext(guildId)
                                .catch(error => {
                                    console.error(
                                        `Erro ao iniciar música (${guildId}):`,
                                        error
                                    );
                                })
                                .finally(() => {
                                    playbackStarts.delete(guildId);
                                });

                            await interaction.editReply({
                                content: playlistMode
                                    ? `**${spotifyAlbumMode ? "Álbum" : "Playlist"} adicionado!**\n` +
                                      `${playlist.title}\n` +
                                      `Músicas adicionadas: ${tracks.length}\n` +
                                      `**Tocando agora:** ${track.title}`
                                    : spotify
                                        ? `**Spotify → YouTube**\n` +
                                          `**Música:** ${track.spotify.title}\n` +
                                          `**Artista:** ${track.spotify.author || "Desconhecido"}\n` +
                                          `**Reproduzindo:** ${track.title}\n` +
                                          `Duração: ${formatDuration(track.duration)}`
                                        : `**Tocando agora**\n` +
                                          `${track.title}\n` +
                                          `Duração: ${formatDuration(track.duration)}`
                            });
                        } else {
                            await interaction.editReply({
                                content: playlistMode
                                    ? `**${spotifyAlbumMode ? "Álbum" : "Playlist"} adicionado à fila!**\n` +
                                      `${playlist.title}\n` +
                                      `Músicas adicionadas: ${tracks.length}\n` +
                                      `Posição inicial: ${position - tracks.length + 1}`
                                    : spotify
                                        ? `**Spotify → YouTube**\n` +
                                          `**Música adicionada:** ${track.spotify.title}\n` +
                                          `**Artista:** ${track.spotify.author || "Desconhecido"}\n` +
                                          `**Resultado:** ${track.title}\n` +
                                          `Posição: ${position}`
                                        : `**Adicionado à fila**\n` +
                                          `${track.title}\n` +
                                          `Posição: ${position} · Duração: ${formatDuration(track.duration)}`
                            });
                        }

                        // Envia o convite somente quando este /play conecta o bot.
                        if (shouldSendActivityInvite) {
                            await sendActivityInvite(interaction);
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
                                "Não estou conectado a nenhum canal de voz.",
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
                                "Você precisa estar no mesmo canal de voz que eu.",
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
                                "Posição inválida. Use `/queue` para consultar as músicas disponíveis.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    const removedTrack = removeTrack(
                        guildId,
                        position
                    );

                    if (!removedTrack) {
                        return await interaction.reply({
                            content:
                                "Não foi possível remover essa música.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    await interaction.reply({
                        content:
                            `<@${interaction.user.id}> removeu uma música da fila.\n\n` +
                            `**Música removida**\n${removedTrack.title}\n` +
                            `Posição anterior: ${position}`
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
                                "Não estou conectado a nenhum canal de voz.",
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
                                "Você precisa estar no mesmo canal de voz que eu.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    const queue = getQueue(guildId);

                    if (!queue?.tracks?.length) {
                        return await interaction.reply({
                            content:
                                "A fila de espera já está vazia.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    const confirmButton =
                        new ButtonBuilder()
                            .setCustomId("clear_confirm")
                            .setLabel("Confirmar")
                            .setStyle(ButtonStyle.Danger);

                    const cancelButton =
                        new ButtonBuilder()
                            .setCustomId("clear_cancel")
                            .setLabel("Cancelar")
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
                                "**Limpar a fila de reprodução?**\n\n" +
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
                                    "Limpeza da fila cancelada.",
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
                                    "Você não está mais no mesmo canal de voz que o bot.",
                                components: []
                            });

                            break;
                        }

                        const removedCount =
                            clearQueue(guildId);

                        await confirmation.update({
                            content:
                                `**Fila limpa!** ${removedCount} música(s) removida(s).\n` +
                                "A música atual continuará tocando.",
                            components: []
                        });

                        await interaction.channel.send({
                            content:
                                `<@${interaction.user.id}> limpou a fila de reprodução.\n` +
                                `Músicas removidas: ${removedCount}`,
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
                                "Tempo esgotado ou não foi possível confirmar. Operação cancelada.",
                            components: []
                        }).catch(console.error);
                    }

                    break;
                }

                // ==============================
                // /SHUFFLE
                // ==============================
                case "shuffle": {
                    const guildId = interaction.guildId;
                    const connection = getVoiceConnection(guildId);

                    if (!connection) {
                        return await interaction.reply({
                            content: "Não estou conectado a nenhum canal de voz.",
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
                            content: "Você precisa estar no mesmo canal de voz que eu.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    const queue = getQueue(guildId);

                    if (!queue?.tracks || queue.tracks.length < 2) {
                        return await interaction.reply({
                            content: "🔀 É necessário ter pelo menos duas músicas na fila para embaralhar.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    const count = shuffleQueue(guildId);

                    await interaction.reply({
                        content:
                            `🔀 **Fila embaralhada!**\n` +
                            `${count} músicas reorganizadas aleatoriamente.\n` +
                            "A música atual continuará tocando normalmente.",
                        flags: MessageFlags.Ephemeral
                    });

                    break;
                }

                // ==============================
                // /LOOP
                // ==============================
                case "loop": {
                    const guildId = interaction.guildId;
                    const connection = getVoiceConnection(guildId);

                    if (!connection) {
                        return await interaction.reply({
                            content:
                                "Não estou conectado a nenhum canal de voz.",
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
                                "Você precisa estar no mesmo canal de voz que eu.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    const enabled = toggleLoop(guildId);

                    await interaction.reply({
                        content:
                            `<@${interaction.user.id}> alterou a repetição da música atual.\n\n` +
                            `**Loop: ${enabled ? "ON" : "OFF"}**`,
                        allowedMentions: {
                            users: [interaction.user.id],
                            parse: []
                        }
                    });

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
                            content:
                                "Não estou conectado a nenhum canal de voz.",
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
                                "Você precisa estar no mesmo canal de voz que eu.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    const position =
                        interaction.options.getInteger(
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
                            content:
                                "Posição inválida. Consulte `/queue`.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    if (
                        playNow &&
                        (!queue.currentTrack || !queue.player)
                    ) {
                        return await interaction.reply({
                            content:
                                "Não há uma música atual para interromper.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    const result = playNow
                        ? playPrioritizedNow(guildId, position)
                        : prioritizeTrack(guildId, position);

                    if (!result) {
                        return await interaction.reply({
                            content:
                                "Não foi possível reorganizar a fila.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    await interaction.reply({
                        content: playNow
                            ? `<@${interaction.user.id}> iniciou uma reprodução imediata.\n\n` +
                              `**Tocando agora**\n${result.selected.title}\n\n` +
                              `**Devolvida à fila**\n${result.interrupted.title}`
                            : `<@${interaction.user.id}> alterou a próxima música.\n\n` +
                              `**Próxima música**\n${result.selected.title}`,
                        allowedMentions: {
                            users: [interaction.user.id],
                            parse: []
                        }
                    });

                    break;
                }

                // ==============================
                // /PAUSE
                // ==============================
                case "pause": {
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

                    if (member.voice.channelId !== connection.joinConfig.channelId) {
                        return await interaction.reply({
                            content: "❌ Você precisa estar no mesmo canal de voz que eu.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    const queue = getQueue(guildId);

                    if (!queue?.player || !queue.currentTrack) {
                        return await interaction.reply({
                            content: "❌ Não há nenhuma música para pausar ou retomar.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    const player = queue.player;
                    const status = player.state.status;
                    const title = queue.currentTrack.title;

                    if (status === AudioPlayerStatus.Playing) {
                        if (!player.pause()) {
                            return await interaction.reply({
                                content: "❌ Não foi possível pausar a música.",
                                flags: MessageFlags.Ephemeral
                            });
                        }

                        pauseMusicStatus(guildId);

                        console.log(`⏸️ Música pausada: ${title}`);

                        await interaction.reply({
                            content:
                                `⏸️ **Música pausada**\n${title}\n\n` +
                                `Pausada por <@${interaction.user.id}>.`,
                            allowedMentions: {
                                users: [interaction.user.id],
                                parse: []
                            }
                        });
                        break;
                    }

                    if (
                        status === AudioPlayerStatus.Paused ||
                        status === AudioPlayerStatus.AutoPaused
                    ) {
                        if (!player.unpause()) {
                            return await interaction.reply({
                                content: "❌ Não foi possível retomar a música.",
                                flags: MessageFlags.Ephemeral
                            });
                        }

                        resumeMusicStatus(guildId);

                        console.log(`▶️ Música retomada: ${title}`);

                        await interaction.reply({
                            content:
                                `▶️ **Reprodução retomada**\n${title}\n\n` +
                                `Retomada por <@${interaction.user.id}>.`,
                            allowedMentions: {
                                users: [interaction.user.id],
                                parse: []
                            }
                        });
                        break;
                    }

                    await interaction.reply({
                        content: "⏳ O player não está pronto para pausar ou retomar.",
                        flags: MessageFlags.Ephemeral
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
                                "Não estou conectado a nenhum canal de voz.",
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
                                "Você precisa estar no mesmo canal de voz que eu.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    const queue = getQueue(guildId);

                    if (!queue?.currentTrack) {
                        return await interaction.reply({
                            content:
                                "Não há nenhuma música tocando.",
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
                                "Não foi possível pular a música.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    await interaction.reply({
                        content: nextTitle
                            ? `**Música pulada**\n${currentTitle}\n\n` +
                              `**Tocando em seguida**\n${nextTitle}`
                            : `**Música pulada**\n${currentTitle}\n\n` +
                              "A fila de reprodução terminou."
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
                                "Não estou conectado a nenhum canal de voz.",
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
                                "Você precisa estar no mesmo canal de voz que eu.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    const confirmButton =
                        new ButtonBuilder()
                            .setCustomId("stop_confirm")
                            .setLabel("Confirmar")
                            .setStyle(ButtonStyle.Danger);

                    const cancelButton =
                        new ButtonBuilder()
                            .setCustomId("stop_cancel")
                            .setLabel("Cancelar")
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
                                "**Encerrar reprodução?**\n\n" +
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
                                    "Operação cancelada.",
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
                                    "Você não está mais no mesmo canal de voz que o bot.",
                                components: []
                            });

                            break;
                        }

                        leaveChannel(guildId);

                        await confirmation.update({
                            content:
                                "Reprodução encerrada! Saí do canal de voz.",
                            components: []
                        });

                        await interaction.channel.send({
                            content:
                                `<@${interaction.user.id}> encerrou a reprodução.\n` +
                                "O bot saiu do canal de voz.",
                            allowedMentions: {
                                users: [interaction.user.id],
                                parse: []
                            }
                        }).catch(console.error);

                    } catch (error) {
                        await interaction.editReply({
                            content:
                                "Tempo esgotado. Operação cancelada.",
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
                            `O comando /${command} está em desenvolvimento!`,
                        flags: MessageFlags.Ephemeral
                    });
                }
            }

        } catch (error) {
            console.error(
                "Erro ao executar comando:",
                error
            );

            if (
                interaction.deferred ||
                interaction.replied
            ) {
                await interaction.editReply({
                    content:
                        "Ocorreu um erro ao executar o comando.",
                    components: []
                }).catch(console.error);
            } else {
                await interaction.reply({
                    content:
                        "Ocorreu um erro ao executar o comando.",
                    flags: MessageFlags.Ephemeral
                }).catch(console.error);
            }
        }
    });
};
