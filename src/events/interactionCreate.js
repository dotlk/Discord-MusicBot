
const {
    Events,
    MessageFlags,
    PermissionFlagsBits,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType
} = require("discord.js");

const { getVoiceConnection } = require("@discordjs/voice");

const {
    joinChannel,
    leaveChannel
} = require("../audio/voiceManager");

module.exports = function registerInteractionEvent(client) {
    client.on(Events.InteractionCreate, async interaction => {
        if (!interaction.isChatInputCommand()) return;

        try {
            const command = interaction.commandName;

            console.log(`🎵 Comando recebido: /${command}`);

            if (!interaction.inGuild()) {
                return await interaction.reply({
                    content: "❌ Este comando só funciona em servidores.",
                    flags: MessageFlags.Ephemeral
                });
            }

            switch (command) {
                case "join": {
                    const member = await interaction.guild.members.fetch(
                        interaction.user.id
                    );

                    const channel = member.voice.channel;

                    if (!channel) {
                        return await interaction.reply({
                            content: "❌ Entre em um canal de voz primeiro!",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    const permissions = channel.permissionsFor(
                        interaction.guild.members.me
                    );

                    if (
                        !permissions?.has(PermissionFlagsBits.Connect) ||
                        !permissions?.has(PermissionFlagsBits.Speak)
                    ) {
                        return await interaction.reply({
                            content: "❌ Não tenho permissão para entrar ou falar nesse canal.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    await interaction.deferReply();

                    await joinChannel(channel);

                    await interaction.editReply({
                        content: `🔊 Entrei no canal **${channel.name}**!`
                    });

                    break;
                }

                case "stop": {
                    const connection = getVoiceConnection(
                        interaction.guildId
                    );

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

                    const confirmButton = new ButtonBuilder()
                        .setCustomId("stop_confirm")
                        .setLabel("Confirmar")
                        .setEmoji("✅")
                        .setStyle(ButtonStyle.Danger);

                    const cancelButton = new ButtonBuilder()
                        .setCustomId("stop_cancel")
                        .setLabel("Cancelar")
                        .setEmoji("❌")
                        .setStyle(ButtonStyle.Secondary);

                    const row = new ActionRowBuilder()
                        .addComponents(confirmButton, cancelButton);

                    const response = await interaction.reply({
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
                                    componentType: ComponentType.Button,
                                    filter: button =>
                                        button.user.id === interaction.user.id,
                                    time: 30000
                                });

                        if (
                            confirmation.customId === "stop_cancel"
                        ) {
                            await confirmation.update({
                                content: "❎ Operação cancelada.",
                                components: []
                            });

                            break;
                        }

                        // Verifica novamente a conexão
                        const currentConnection = getVoiceConnection(
                            interaction.guildId
                        );

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

                        // Futuramente, também limpará a fila
                        leaveChannel(interaction.guildId);

                        await confirmation.update({
                            content:
                                "⏹️ Reprodução encerrada! Saí do canal de voz.",
                            components: []
                        });

                    } catch (error) {
                        // Tempo de confirmação esgotado
                        await interaction.editReply({
                            content:
                                "⌛ Tempo esgotado. Operação cancelada.",
                            components: []
                        }).catch(console.error);
                    }

                    break;
                }

                default: {
                    await interaction.reply({
                        content:
                            `🚧 O comando /${command} está em desenvolvimento!`,
                        flags: MessageFlags.Ephemeral
                    });
                }
            }

        } catch (error) {
            console.error("❌ Erro ao executar comando:", error);

            if (interaction.deferred || interaction.replied) {
                await interaction.editReply({
                    content: "❌ Ocorreu um erro ao executar o comando.",
                    components: []
                }).catch(console.error);
            } else {
                await interaction.reply({
                    content: "❌ Ocorreu um erro ao executar o comando.",
                    flags: MessageFlags.Ephemeral
                }).catch(console.error);
            }
        }
    });
};
