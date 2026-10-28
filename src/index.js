export default {
  async scheduled(event, env, ctx) {
    await processSpotifyLikes(env);
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

    const artistsObjects = track.artists || [];
    const artistsNames = artistsObjects.map((a) => a.name);

    console.log(
      `[DEBUG] Processing new track: "${trackName}" by ${artistsNames.join(', ')}`,
    );

    const llmData = await getLLMData(artistsNames, env.GEMINI_API_KEY);

    if (!llmData) {
      console.log(
        '[DEBUG] LLM data unavailable on all models. Retrying on next cron run in 2 minutes.',
      );
      return;
    }

    await sendTelegramMessage(
      env,
      trackName,
      albumName,
      year,
      llmData,
      track.external_urls?.spotify,
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

async function getLLMData(artistsNames, apiKey) {
  if (!apiKey) {
    console.error('[DEBUG] GEMINI_API_KEY is missing!');
    return null;
  }

  const prompt = `Проаналізуй наступних музичних виконавців: ${artistsNames.join(', ')}.
Для КОЖНОГО виконавця надай таку інформацію:
1. Коротка інформація (стиль, історія, звідки вони, чим відомі - 1-2 абзаци).
2. Найпопулярніший трек цього виконавця.
3. Найпопулярніший альбом цього виконавця (або EP).

Якщо інформації про когось немає, пиши "Інформації не знайдено", НЕ вигадуй факти.
Відповідь дай СУВОРО у форматі JSON (масив об'єктів під ключем "artists_info"):
{
  "artists_info": [
    {
      "name": "Ім'я виконавця",
      "bio": "коротка інформація...",
      "top_track": "Назва найпопулярнішого треку",
      "top_album": "Назва найпопулярнішого альбому"
    }
  ]
}`;

  const models = ['gemini-3.8-flash', 'gemini-3.5-flash-lite'];

  for (const model of models) {
    try {
      console.log(`[DEBUG] Calling Gemini API with model: ${model}`);
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              response_mime_type: 'application/json',
            },
          }),
        },
      );

      const data = await res.json();
      if (res.ok) {
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          const parsed = JSON.parse(text);
          if (parsed.artists_info) {
            console.log(
              `[DEBUG] Gemini call successful using ${model}!`,
            );
            return parsed.artists_info;
          }
        }
      } else {
        console.error(
          `[DEBUG] Gemini Error (${model}):`,
          JSON.stringify(data),
        );
        // Якщо помилка 503 або 429, цикл автоматично перейде до наступної, легшої моделі
        if (res.status === 503 || res.status === 429) {
          console.log(
            `[DEBUG] ${model} is unavailable. Switching to fallback...`,
          );
          continue;
        }
      }
    } catch (e) {
      console.error(
        `[DEBUG] Gemini Exception (${model}):`,
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

async function sendTelegramMessage(
  env,
  trackName,
  albumName,
  year,
  llmData,
  spotifyUrl,
) {
  const allArtistNames = llmData.map((a) => a.name).join(', ');

  const artistsHtml = llmData
    .map((artist) =>
      `
<b>👤 ${escapeHtml(artist.name)}</b>
${escapeHtml(artist.bio)}
🏆 Найпопулярніший трек: <i>${escapeHtml(artist.top_track)}</i>
💿 Найпопулярніший альбом: <i>${escapeHtml(artist.top_album)}</i>
  `.trim(),
    )
    .join('\n\n');

  const text = `
<b>🎵 <a href="${spotifyUrl}">${escapeHtml(allArtistNames)} — ${escapeHtml(trackName)}</a></b>

<b>Альбом:</b> ${escapeHtml(albumName)}
<b>Рік:</b> ${escapeHtml(year)}

${artistsHtml}
  `.trim();

  const res = await fetch(
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

  const tgData = await res.json();
  if (!res.ok || !tgData.ok) {
    console.error(
      '[DEBUG] Telegram API Error:',
      JSON.stringify(tgData),
    );
  } else {
    console.log('[DEBUG] Telegram message sent successfully!');
  }
}
