
const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    MessageFlags
} = require("discord.js");

const { getQueue } = require("../audio/queueManager");

const PAGE_SIZE = 5;
const TIMEOUT = 120000;

function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) {
        return "?:??";
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

function safeText(value, maxLength = 100) {
    const text = String(value || "Desconhecido")
        .replace(/[\r\n]+/g, " ")
        .replace(/([\\`*_~|>[\]])/g, "\\$1");

    return text.length > maxLength
        ? `${text.slice(0, maxLength - 1)}…`
        : text;
}

function validUrl(value) {
    try {
        const url = new URL(value);

        return ["https:", "http:"].includes(url.protocol)
            ? url.href
            : null;
    } catch {
        return null;
    }
}

function getAuthor(track) {
    return safeText(
        track.author ||
        track.uploader ||
        track.channel ||
        "Canal desconhecido",
        65
    );
}

function getTotalPages(tracks) {
    return Math.max(
        1,
        Math.ceil(tracks.length / PAGE_SIZE)
    );
}

function buildQueueEmbed(guildId, requestedPage) {
    const queue = getQueue(guildId);

    const tracks = queue?.tracks || [];
    const current = queue?.currentTrack || null;

    const totalPages = getTotalPages(tracks);

    const page = Math.min(
        Math.max(0, requestedPage),
        totalPages - 1
    );

    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle("Fila de reprodução");

    let description = "";

    // Música atual
    if (current) {
        const title = safeText(current.title, 90);
        const url = validUrl(current.url);

        const titleLine = url
            ? `**[${title}](${url})**`
            : `**${title}**`;

        description +=
            "### 🔊 Tocando agora\n" +
            `${titleLine}\n` +
            `**Autor:** ${getAuthor(current)}\n` +
            `**Duração:** ${formatDuration(current.duration)}`;

        const thumbnail = validUrl(current.thumbnail);

        if (thumbnail) {
            embed.setThumbnail(thumbnail);
        }
    } else {
        description += "### Nenhuma música tocando";
    }

    // Linha divisória
    description += "\n\n────────────────────────\n\n";

    // Próximas músicas
    if (tracks.length === 0) {
        description += "*Nenhuma música na fila.*";
    } else {
        const start = page * PAGE_SIZE;

        const visible = tracks.slice(
            start,
            start + PAGE_SIZE
        );

        const lines = visible.map((track, index) => {
            const position = start + index + 1;
            const title = safeText(track.title, 65);
            const url = validUrl(track.url);

            const titleLine = url
                ? `[${title}](${url})`
                : title;

            // O número fica fora do link.
            // O caractere invisível evita que o Discord
            // interprete a linha como uma lista Markdown.
            return (
                `\u200B**${position}.** **${titleLine}**  \n` +
                `**Autor:** ${getAuthor(track)}  \n` +
                `**Duração:** ${formatDuration(track.duration)}`
            );
        });

        description += lines.join("\n\n");
    }

    // Espaço antes do rodapé
    description += "\n\u200B";

    embed.setDescription(description.slice(0, 4096));

    const totalDuration = tracks.reduce(
        (sum, track) =>
            sum + (
                Number.isFinite(track.duration)
                    ? track.duration
                    : 0
            ),
        0
    );

    embed.setFooter({
        text:
            `Página ${page + 1}/${totalPages}` +
            `  •  ${tracks.length} na fila` +
            `  •  ${formatDuration(totalDuration)} restantes`
    });

    return {
        embed,
        page,
        totalPages
    };
}

// Botões compactos
function buildButtons(page, totalPages, disabled = false) {
    const previous = new ButtonBuilder()
        .setCustomId("queue_previous")
        .setLabel("❮")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled || page === 0);

    const refresh = new ButtonBuilder()
        .setCustomId("queue_refresh")
        .setEmoji("🔄")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled);

    const next = new ButtonBuilder()
        .setCustomId("queue_next")
        .setLabel("❯")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(
            disabled || page >= totalPages - 1
        );

    return [
        new ActionRowBuilder().addComponents(
            previous,
            refresh,
            next
        )
    ];
}

async function handleQueue(interaction) {
    const guildId = interaction.guildId;

    const queue = getQueue(guildId);

    if (!queue) {
        return await interaction.reply({
            content:
                "Ainda não existe uma fila neste servidor.",
            flags: MessageFlags.Ephemeral
        });
    }

    let page = 0;

    const initial = buildQueueEmbed(guildId, page);

    // Mensagem privada: apenas o usuário vê.
    const response = await interaction.reply({
        embeds: [initial.embed],
        components: buildButtons(
            initial.page,
            initial.totalPages
        ),
        flags: MessageFlags.Ephemeral,
        withResponse: true
    });

    const message = response.resource.message;

    const collector = message.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: TIMEOUT,
        filter: button =>
            button.customId.startsWith("queue_")
    });

    collector.on("collect", async button => {
        try {
            if (button.user.id !== interaction.user.id) {
                return await button.reply({
                    content:
                        "Use /queue para abrir sua própria visualização.",
                    flags: MessageFlags.Ephemeral
                });
            }

            if (button.customId === "queue_previous") {
                page--;
            } else if (
                button.customId === "queue_next"
            ) {
                page++;
            }

            const updated = buildQueueEmbed(
                guildId,
                page
            );

            page = updated.page;

            await button.update({
                embeds: [updated.embed],
                components: buildButtons(
                    updated.page,
                    updated.totalPages
                )
            });

        } catch (error) {
            console.error(
                "Erro ao atualizar fila:",
                error
            );

            if (!button.replied && !button.deferred) {
                await button.reply({
                    content:
                        "Não foi possível atualizar a fila.",
                    flags: MessageFlags.Ephemeral
                }).catch(console.error);
            }
        }
    });

    collector.on("end", async () => {
        try {
            const updated = buildQueueEmbed(
                guildId,
                page
            );

            await message.edit({
                embeds: [updated.embed],
                components: buildButtons(
                    updated.page,
                    updated.totalPages,
                    true
                )
            });
        } catch (error) {
            console.error(
                "Não foi possível desativar os botões:",
                error
            );
        }
    });
}

module.exports = {
    handleQueue
};
