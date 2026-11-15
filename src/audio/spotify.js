
const spotifyUrlInfo = require("spotify-url-info");

const {
    getTracks,
    getData
} = spotifyUrlInfo(fetch);

const SPOTIFY_HOSTS = new Set([
    "open.spotify.com",
    "www.open.spotify.com"
]);

function parseSpotifyUrl(value) {
    try {
        const url = new URL(value);

        if (
            url.protocol !== "https:" ||
            !SPOTIFY_HOSTS.has(url.hostname)
        ) {
            return null;
        }

        const parts = url.pathname
            .split("/")
            .filter(Boolean);

        if (parts[0]?.startsWith("intl-")) {
            parts.shift();
        }

        const [type, id] = parts;

        if (
            !["track", "playlist", "album"].includes(type) ||
            !/^[a-zA-Z0-9]{22}$/.test(id || "")
        ) {
            return null;
        }

        return {
            type,
            id,
            url: `https://open.spotify.com/${type}/${id}`
        };
    } catch {
        return null;
    }
}

function isSpotifyUrl(value) {
    return parseSpotifyUrl(value) !== null;
}

async function getSpotifyTrackInfo(value) {
    const parsed = parseSpotifyUrl(value);

    if (!parsed || parsed.type !== "track") {
        throw new Error(
            "Informe um link de faixa do Spotify."
        );
    }

    const endpoint = new URL(
        "https://open.spotify.com/oembed"
    );

    endpoint.searchParams.set("url", parsed.url);

    const response = await fetch(endpoint, {
        signal: AbortSignal.timeout(15000),
        headers: {
            Accept: "application/json"
        }
    });

    if (!response.ok) {
        throw new Error(
            `Não foi possível consultar o Spotify (HTTP ${response.status}).`
        );
    }

    const data = await response.json();

    if (!data.title) {
        throw new Error(
            "O Spotify não retornou o título da faixa."
        );
    }

    return {
        id: parsed.id,
        title: data.title,
        author: data.author_name || null,
        url: parsed.url,
        thumbnail: data.thumbnail_url || null,
        searchQuery: [
            data.title,
            data.author_name
        ].filter(Boolean).join(" ")
    };
}

function normalizeSpotifyTrack(item) {
    const entry = item?.track || item;

    if (
        !entry ||
        entry.is_local ||
        entry.type === "episode"
    ) {
        return null;
    }

    const title = entry.name || entry.title;

    const author = Array.isArray(entry.artists)
        ? entry.artists
            .map(artist =>
                typeof artist === "string"
                    ? artist
                    : artist.name
            )
            .filter(Boolean)
            .join(", ")
        : (
            entry.artist ||
            entry.subtitle ||
            ""
        );

    if (!title) return null;

    const id = entry.id || null;

    return {
        id,
        title,
        author: author || "Artista desconhecido",

        duration: entry.duration_ms
            ? Math.round(entry.duration_ms / 1000)
            : null,

        url: id
            ? `https://open.spotify.com/track/${id}`
            : null,

        thumbnail:
            entry.album?.images?.[0]?.url || null,

        spotify: {
            id,
            title,
            author
        },

        spotifySearchQuery: [
            title,
            author
        ].filter(Boolean).join(" "),

        requestedBy: null
    };
}

async function getSpotifyCollectionInfo(value) {
    const parsed = parseSpotifyUrl(value);

    if (
        !parsed ||
        !["playlist", "album"].includes(parsed.type)
    ) {
        throw new Error(
            "Informe um link de playlist ou álbum do Spotify."
        );
    }

    let data;
    let items;

    try {
        [data, items] = await Promise.all([
            getData(parsed.url),
            getTracks(parsed.url)
        ]);
    } catch (error) {
        throw new Error(
            `Não foi possível consultar o ${parsed.type} do Spotify: ${error.message}`
        );
    }

    if (!Array.isArray(items)) {
        throw new Error(
            "O Spotify não retornou uma lista válida de músicas."
        );
    }

    const tracks = items
        .map(normalizeSpotifyTrack)
        .filter(Boolean);

    if (!tracks.length) {
        throw new Error(
            "Não foram encontradas músicas disponíveis."
        );
    }

    return {
        id: parsed.id,
        type: parsed.type,
        title:
            data?.name ||
            data?.title ||
            (parsed.type === "album"
                ? "Álbum do Spotify"
                : "Playlist do Spotify"),

        tracks,
        count: tracks.length,
        maxTracks: 100
    };
}

async function getSpotifyPlaylistInfo(value) {
    const parsed = parseSpotifyUrl(value);

    if (!parsed || parsed.type !== "playlist") {
        throw new Error(
            "Informe um link de playlist do Spotify."
        );
    }

    return getSpotifyCollectionInfo(value);
}

async function getSpotifyAlbumInfo(value) {
    const parsed = parseSpotifyUrl(value);

    if (!parsed || parsed.type !== "album") {
        throw new Error(
            "Informe um link de álbum do Spotify."
        );
    }

    return getSpotifyCollectionInfo(value);
}

module.exports = {
    parseSpotifyUrl,
    isSpotifyUrl,
    getSpotifyTrackInfo,
    getSpotifyPlaylistInfo,
    getSpotifyAlbumInfo,
    getSpotifyCollectionInfo
};
