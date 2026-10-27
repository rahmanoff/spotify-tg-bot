export default {
  async scheduled(event, env, ctx) {
    // ⚠️ Обов'язково await, щоб Worker не вбивав процес завчасно
    await processSpotifyLikes(env);
  },
};

async function processSpotifyLikes(env) {
  // Замок у KV (TTL 180с) для захисту від паралельних кронів
  const lock = await env.KV.get('sync_lock');
  if (lock) {
    console.log('Lock exists. Exiting.');
    return;
  }
  await env.KV.put('sync_lock', '1', { expirationTtl: 180 });

  try {
    const accessToken = await refreshSpotifyToken(env);

    // ⚠️ Валідний limit = 10 (Spotify API 2026)
    const tracksRes = await spotifyFetch(
      'https://api.spotify.com/v1/me/tracks?limit=10',
      accessToken,
    );
    if (!tracksRes || !tracksRes.items || tracksRes.items.length === 0)
      return;

    let state = await env.KV.get('spotify_state', 'json');
    if (!state) state = { ts: '1970-01-01T00:00:00Z', ids: [] };

    // ⚠️ Поле items замість tracks
    const items = tracksRes.items.reverse();

    const targetItem = items.find((item) => {
      return (
        item.added_at > state.ts ||
        (item.added_at === state.ts &&
          !state.ids.includes(item.track.id))
      );
    });

    if (!targetItem) {
      console.log('No new tracks.');
      return;
    }

    const track = targetItem.track;
    const addedAt = targetItem.added_at;
    const artistName = track.artists[0].name;
    const trackName = track.name;

    // Метадані: Beatport -> Discogs -> не знайдено
    let metadata = await searchBeatport(artistName, trackName);
    if (!metadata) {
      metadata = await searchDiscogs(
        artistName,
        trackName,
        env.DISCOGS_KEY,
        env.DISCOGS_SECRET,
      );
    }
    if (!metadata) {
      metadata = {
        style: 'не знайдено',
        label: 'не знайдено',
        year: 'не знайдено',
        bpm: 'не знайдено',
        key: 'не знайдено',
      };
    }

    // LLM генерація (описи та країна)
    const llmData = await getLLMData(
      artistName,
      metadata.label,
      env.GEMINI_API_KEY,
    );

    // Плейлісти
    const playlists = await getAllSpotifyPlaylists(accessToken);
    const playlistsLinks = [];

    if (metadata.style !== 'не знайдено') {
      const styleLink = await addTrackToPlaylist(
        metadata.style,
        track.uri,
        playlists,
        accessToken,
      );
      playlistsLinks.push(
        `<a href="${styleLink}">${metadata.style}</a>`,
      );
    }

    if (metadata.label !== 'не знайдено') {
      const labelLink = await addTrackToPlaylist(
        metadata.label,
        track.uri,
        playlists,
        accessToken,
      );
      playlistsLinks.push(
        `<a href="${labelLink}">${metadata.label}</a>`,
      );
    }

    // Telegram пост
    await sendTelegramMessage(
      env,
      artistName,
      trackName,
      metadata,
      llmData,
      playlistsLinks,
      track.external_urls?.spotify,
    );

    // Оновлення стану без безкінечного масиву
    if (addedAt === state.ts) {
      state.ids.push(track.id);
    } else {
      state.ts = addedAt;
      state.ids = [track.id];
    }
    await env.KV.put('spotify_state', JSON.stringify(state));
  } catch (error) {
    console.error('Error in processSpotifyLikes:', error);
  } finally {
    await env.KV.delete('sync_lock');
  }
}

async function refreshSpotifyToken(env) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: env.SPOTIFY_REFRESH_TOKEN,
  });
  const authHeader = btoa(
    `${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`,
  );

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${authHeader}`,
    },
    body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Failed to refresh Spotify token');
  return data.access_token;
}

async function spotifyFetch(url, token, options = {}) {
  options.headers = {
    ...options.headers,
    Authorization: `Bearer ${token}`,
  };
  const res = await fetch(url, options);

  if (res.status === 429) {
    const retryAfter = parseInt(
      res.headers.get('retry-after') || '5',
      10,
    );
    if (retryAfter > 10) {
      throw new Error(
        `Rate limit too long (${retryAfter}s). Exiting run.`,
      );
    }
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return fetch(url, options).then((r) => r.json());
  }

  if (!res.ok) {
    if (res.status === 201 || res.status === 200) return {};
    throw new Error(`Spotify API Error: ${res.status} on ${url}`);
  }
  return await res.json();
}

async function getAllSpotifyPlaylists(token) {
  let url = 'https://api.spotify.com/v1/me/playlists?limit=50';
  const allPlaylists = [];

  while (url) {
    const data = await spotifyFetch(url, token);
    if (data.items) {
      allPlaylists.push(...data.items);
    }
    url = data.next;
  }

  return allPlaylists;
}

async function addTrackToPlaylist(
  playlistName,
  trackUri,
  allPlaylists,
  token,
) {
  let playlist = allPlaylists.find(
    (p) => p.name.toLowerCase() === playlistName.toLowerCase(),
  );

  if (!playlist) {
    // ⚠️ Новий ендпойнт POST /me/playlists
    const newPlRes = await fetch(
      'https://api.spotify.com/v1/me/playlists',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: playlistName, public: false }),
      },
    );

    if (newPlRes.status === 429)
      throw new Error('429 on playlist creation');
    playlist = await newPlRes.json();
  }

  // ⚠️ Новий ендпойнт /playlists/{id}/items
  const addRes = await fetch(
    `https://api.spotify.com/v1/playlists/${playlist.id}/items`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ uris: [trackUri] }),
    },
  );

  if (addRes.status === 429)
    throw new Error('429 on adding track to playlist');

  return playlist.external_urls.spotify;
}

async function searchBeatport(artist, title) {
  try {
    const q = `${artist} ${title}`;
    const res = await fetch(
      `https://www.beatport.com/search/tracks?q=${encodeURIComponent(q)}`,
    );
    const html = await res.text();

    const match = html.match(
      /<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/,
    );
    if (!match) return null;

    const nextData = JSON.parse(match[1]);
    let trackObj = findObjWithKeys(nextData, ['track_name', 'bpm']);
    if (!trackObj) return null;

    return {
      style: trackObj.genre?.name || 'не знайдено',
      label: trackObj.label?.name || 'не знайдено',
      year: trackObj.release_date
        ? trackObj.release_date.substring(0, 4)
        : 'не знайдено',
      bpm: trackObj.bpm || 'не знайдено',
      key: trackObj.key?.name || 'не знайдено',
    };
  } catch (e) {
    return null;
  }
}

function findObjWithKeys(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  if (keys.every((k) => k in obj)) return obj;
  for (const k of Object.keys(obj)) {
    const result = findObjWithKeys(obj[k], keys);
    if (result) return result;
  }
  return null;
}

async function searchDiscogs(artist, title, key, secret) {
  if (!key || !secret) return null;
  try {
    const q = `${artist} ${title}`;
    const res = await fetch(
      `https://api.discogs.com/database/search?q=${encodeURIComponent(q)}&type=release`,
      {
        headers: {
          'User-Agent': 'SpotifyTelegramBot/1.0',
          Authorization: `Discogs key=${key}, secret=${secret}`,
        },
      },
    );
    const data = await res.json();
    if (!data.results || data.results.length === 0) return null;

    const release = data.results[0];
    return {
      style:
        (release.style && release.style[0]) ||
        (release.genre && release.genre[0]) ||
        'не знайдено',
      label: (release.label && release.label[0]) || 'не знайдено',
      year: release.year || 'не знайдено',
      bpm: 'не знайдено',
      key: 'не знайдено',
    };
  } catch (e) {
    return null;
  }
}

async function getLLMData(artist, label, apiKey) {
  if (!apiKey)
    return {
      artist_desc: 'LLM вимкнено',
      label_desc: 'LLM вимкнено',
      country: 'не знайдено',
    };

  const prompt = `Проаналізуй артиста "${artist}" та лейбл "${label}".
1. Напиши опис артиста (1-2 абзаци, жива мова: хто заснував, коли, місто, чим відомі). 
2. Напиши опис лейбла (1-2 абзаци: історія, фокус).
3. Визнач країну артиста. Не використовуй регулярні вирази, опирайся на свої знання. 

Якщо інформації немає взагалі — пиши "Інформації не знайдено", НЕ вигадуй факти.
Відповідь дай СУВОРО у форматі JSON:
{
  "artist_desc": "опис",
  "label_desc": "опис",
  "country": "Назва країни українською (або 'не знайдено')"
}`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { response_mime_type: 'application/json' },
        }),
      },
    );
    const data = await res.json();
    const text = data.candidates[0].content.parts[0].text;
    return JSON.parse(text);
  } catch (e) {
    return {
      artist_desc: 'Помилка LLM',
      label_desc: 'Помилка LLM',
      country: 'не знайдено',
    };
  }
}

async function sendTelegramMessage(
  env,
  artist,
  title,
  meta,
  llm,
  playlistsLinks,
  spotifyUrl,
) {
  const playlistsHtml =
    playlistsLinks.length > 0
      ? playlistsLinks.join(' | ')
      : '<i>Не створено</i>';

  const text = `
<b>🎵 <a href="${spotifyUrl}">${artist} — ${title}</a></b>

<b>BPM:</b> ${meta.bpm} | <b>Тональність:</b> ${meta.key}
<b>Рік:</b> ${meta.year} | <b>Стиль:</b> ${meta.style}
<b>Лейбл:</b> ${meta.label}
<b>Країна:</b> ${llm.country}

<b>👤 Про артиста:</b>
${llm.artist_desc}

<b>📀 Про лейбл:</b>
${llm.label_desc}

<b>📂 Плейлісти:</b>
${playlistsHtml}
  `.trim();

  await fetch(
    `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TG_CHAT_ID,
        text: text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    },
  );
}
