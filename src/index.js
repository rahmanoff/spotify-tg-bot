export default {
  async scheduled(event, env, ctx) {
    await processSpotifyLikes(env);
  },

  async fetch(request, env, ctx) {
    if (request.method === 'POST') {
      try {
        const update = await request.json();
        if (update.callback_query) {
          await handleCallbackQuery(env, update.callback_query);
        }
        return new Response('OK', { status: 200 });
      } catch (e) {
        console.error('[DEBUG] Fetch error:', e);
        return new Response('Error', { status: 500 });
      }
    }
    return new Response('Spotify TG Bot is running!', { status: 200 });
  },
};

async function processSpotifyLikes(env) {
  const lock = await env.KV.get('sync_lock');
  if (lock) {
    console.log('[DEBUG] Lock exists in KV. Exiting run.');
    return;
  }
  await env.KV.put('sync_lock', '1', { expirationTtl: 180 });

  try {
    const accessToken = await refreshSpotifyToken(env);

    const tracksRes = await spotifyFetch(
      'https://api.spotify.com/v1/me/tracks?limit=10',
      accessToken,
    );
    if (
      !tracksRes ||
      !tracksRes.items ||
      tracksRes.items.length === 0
    ) {
      console.log('[DEBUG] Spotify returned 0 tracks.');
      return;
    }

    let state = await env.KV.get('spotify_state', 'json');

    if (!state) {
      const latestTrackItem = tracksRes.items[0];
      state = {
        ts: latestTrackItem.added_at,
        ids: [latestTrackItem.track.id],
      };
      await env.KV.put('spotify_state', JSON.stringify(state));
      console.log(
        `[DEBUG] Initialized state to latest track "${latestTrackItem.track.name}". Ready for NEW likes.`,
      );
      return;
    }

    const items = tracksRes.items.reverse();

    const targetItem = items.find((item) => {
      return (
        item.added_at > state.ts ||
        (item.added_at === state.ts &&
          !state.ids.includes(item.track.id))
      );
    });

    if (!targetItem) {
      console.log(
        '[DEBUG] No new tracks found (compared to KV state TS).',
      );
      return;
    }

    const track = targetItem.track;
    const addedAt = targetItem.added_at;

    const trackName = track.name;
    const year = track.album?.release_date
      ? track.album.release_date.substring(0, 4)
      : 'невідомо';
    const albumName =
      track.album?.album_type === 'single'
        ? 'сінгл'
        : track.album?.name || 'невідомо';
    const trackCoverUrl = track.album?.images?.[0]?.url || null;

    const artistsObjects = track.artists || [];
    const artistsNames = artistsObjects.map((a) => a.name);

    console.log(
      `[DEBUG] Processing new track: "${trackName}" by ${artistsNames.join(', ')}`,
    );

    const llmData = await getLLMData(artistsNames, env.GEMINI_API_KEY);

    if (!llmData) {
      console.log(
        '[DEBUG] LLM data unavailable. Retrying on next cron run in 2 minutes.',
      );
      return;
    }

    const trackDataKey = `track_data_${track.id}`;
    await env.KV.put(
      trackDataKey,
      JSON.stringify({
        artists: llmData,
        artistsObjects: artistsObjects,
        accessToken: accessToken,
      }),
      { expirationTtl: 86400 },
    );

    await sendMainTrackMessage(
      env,
      trackName,
      albumName,
      year,
      artistsNames,
      track.external_urls?.spotify,
      trackCoverUrl,
      track.id,
    );

    if (addedAt === state.ts) {
      state.ids.push(track.id);
    } else {
      state.ts = addedAt;
      state.ids = [track.id];
    }
    await env.KV.put('spotify_state', JSON.stringify(state));
    console.log(
      `[DEBUG] Successfully processed and updated KV state to TS: ${state.ts}`,
    );
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
  if (!res.ok)
    throw new Error(
      `Failed to refresh Spotify token: ${JSON.stringify(data)}`,
    );
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

async function getArtistData(artistId, token) {
  try {
    return await spotifyFetch(
      `https://api.spotify.com/v1/artists/${artistId}`,
      token,
    );
  } catch (e) {
    console.error('[DEBUG] Failed to fetch artist data:', e);
    return null;
  }
}

async function getLLMData(artistsNames, apiKey) {
  if (!apiKey) {
    console.error('[DEBUG] GEMINI_API_KEY is missing!');
    return null;
  }

  const prompt = `Проаналізуй музичних артистів: ${artistsNames.join(', ')}.
Для кожного надай:
1. Повна біографія (стиль, історія, чим відомі - 1-2 абзаци).
2. Найпопулярніший трек.
3. Найпопулярний альбом.

Дай відповідь СУВОРО у форматі JSON:
{
  "artists_info": [
    {
      "name": "Ім'я",
      "bio": "опис...",
      "top_track": "Трек",
      "top_album": "Альбом"
    }
  ]
}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(
        `[DEBUG] Calling Gemini API (gemini-3.5-flash-lite), attempt ${attempt}/3`,
      );

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 25000);

      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              response_mime_type: 'application/json',
            },
          }),
          signal: controller.signal,
        },
      );
      clearTimeout(timeoutId);

      const textData = await res.text();
      let data;
      try {
        data = JSON.parse(textData);
      } catch (parseErr) {
        throw new Error(
          `Non-JSON response received: ${textData.substring(0, 100)}`,
        );
      }

      if (res.ok) {
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          const parsed = JSON.parse(text);
          if (parsed.artists_info) {
            console.log(
              `[DEBUG] Gemini call successful on attempt ${attempt}!`,
            );
            return parsed.artists_info;
          }
        }
      } else {
        console.error(
          `[DEBUG] Gemini Error (Attempt ${attempt}):`,
          JSON.stringify(data),
        );
        if (res.status === 503 || res.status === 429) {
          await new Promise((r) => setTimeout(r, 2000 * attempt));
        }
      }
    } catch (e) {
      console.error(
        `[DEBUG] Gemini Exception (Attempt ${attempt}):`,
        e.message || e,
      );
    }
  }

  return null;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function sendMainTrackMessage(
  env,
  trackName,
  albumName,
  year,
  artistsNames,
  spotifyUrl,
  coverUrl,
  trackId,
) {
  const artistsList = artistsNames
    .map((name) => escapeHtml(name))
    .join(', ');

  const text = `
<b>🎵 <a href="${spotifyUrl}">${artistsList} — ${escapeHtml(trackName)}</a></b>

<b>Артисти:</b> ${artistsList}
<b>Альбом:</b> ${escapeHtml(albumName)}
<b>Рік:</b> ${escapeHtml(year)}
  `.trim();

  const inlineKeyboard = {
    inline_keyboard: [
      [
        {
          text: '📖 Детальніше про артистів',
          callback_data: `details_${trackId}`,
        },
      ],
    ],
  };

  const endpoint = coverUrl ? 'sendPhoto' : 'sendMessage';
  const payload = {
    chat_id: env.TG_CHAT_ID,
    parse_mode: 'HTML',
    reply_markup: inlineKeyboard,
  };

  if (coverUrl) {
    payload.photo = coverUrl;
    payload.caption = text;
  } else {
    payload.text = text;
    payload.disable_web_page_preview = true;
  }

  const res = await fetch(
    `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${endpoint}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );

  const tgData = await res.json();
  if (!res.ok || !tgData.ok) {
    console.error(
      '[DEBUG] Telegram Main Track Message Error:',
      JSON.stringify(tgData),
    );
  } else {
    console.log('[DEBUG] Main track message sent successfully!');
  }
}

async function handleCallbackQuery(env, callbackQuery) {
  const data = callbackQuery.data;
  if (!data.startsWith('details_')) return;

  const trackId = data.replace('details_', '');
  const storedDataStr = await env.KV.get(`track_data_${trackId}`);

  await fetch(
    `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/answerCallbackQuery`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: callbackQuery.id,
        text: 'Завантажую інформацію...',
      }),
    },
  );

  if (!storedDataStr) {
    await fetch(
      `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: callbackQuery.message.chat.id,
          text: "Вибачте, дані про цей трек застаріли або не знайдені в пам'яті.",
          parse_mode: 'HTML',
        }),
      },
    );
    return;
  }

  const { artists, artistsObjects, accessToken } =
    JSON.parse(storedDataStr);

  for (let i = 0; i < artists.length; i++) {
    const artistInfo = artists[i];
    const artistObj = artistsObjects[i];

    const fullArtistData = artistObj?.id
      ? await getArtistData(artistObj.id, accessToken)
      : null;
    const photoUrl = fullArtistData?.images?.[0]?.url || null;
    const spotifyArtistUrl =
      fullArtistData?.external_urls?.spotify || '#';
    const genres = fullArtistData?.genres?.length
      ? fullArtistData.genres.join(', ')
      : 'не вказано';

    const text = `
<b>👤 <a href="${spotifyArtistUrl}">${escapeHtml(artistInfo.name)}</a></b>

<b>Жанри:</b> ${escapeHtml(genres)}

${escapeHtml(artistInfo.bio)}

🏆 Найпопулярніший трек: <i>${escapeHtml(artistInfo.top_track)}</i>
💿 Найпопулярніший альбом: <i>${escapeHtml(artistInfo.top_album)}</i>
    `.trim();

    const endpoint = photoUrl ? 'sendPhoto' : 'sendMessage';
    const payload = {
      chat_id: callbackQuery.message.chat.id,
      parse_mode: 'HTML',
    };

    if (photoUrl) {
      payload.photo = photoUrl;
      payload.caption = text;
    } else {
      payload.text = text;
      payload.disable_web_page_preview = true;
    }

    await fetch(
      `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${endpoint}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );
  }
}
