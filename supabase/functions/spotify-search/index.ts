// Searches Spotify for a room's song box: rooms.js calls it as you type and
// gets back songs and playlists to queue with a click. It signs in to Spotify
// as the app itself (client credentials), so no one needs a Spotify login to
// search. Needs two secrets, SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET, from
// an app made at https://developer.spotify.com/dashboard.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Spotify's app token lasts an hour, so it's kept and reused until near the end
let token: string | null = null;
let expires = 0;

async function appToken(): Promise<string> {
  if (token && Date.now() < expires - 60_000) return token;
  const id = Deno.env.get('SPOTIFY_CLIENT_ID');
  const secret = Deno.env.get('SPOTIFY_CLIENT_SECRET');
  if (!id || !secret) throw new Error('Spotify search isn\'t set up yet');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(id + ':' + secret),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Couldn\'t reach Spotify');
  token = data.access_token;
  expires = Date.now() + data.expires_in * 1000;
  return token!;
}

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

// deno-lint-ignore no-explicit-any
function smallest(images: any[] | undefined) {
  return images && images.length ? images[images.length - 1].url : null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const { q } = await req.json();
    const query = String(q || '').trim().slice(0, 100);
    if (!query) return reply({ results: [] });
    const res = await fetch(
      'https://api.spotify.com/v1/search?type=track,playlist&limit=6&q=' + encodeURIComponent(query),
      { headers: { Authorization: 'Bearer ' + await appToken() } },
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'Spotify search failed');
    // deno-lint-ignore no-explicit-any
    const songs = (data.tracks?.items || []).map((t: any) => ({
      id: t.uri,
      title: t.name,
      by: t.artists.map((a: { name: string }) => a.name).join(', '),
      art: smallest(t.album?.images),
    }));
    // Spotify sometimes returns gaps in the playlist list
    // deno-lint-ignore no-explicit-any
    const playlists = (data.playlists?.items || []).filter(Boolean).slice(0, 2).map((p: any) => ({
      id: p.uri,
      kind: 'playlist',
      title: p.name,
      by: p.owner?.display_name || '',
      art: smallest(p.images),
    }));
    return reply({ results: songs.concat(playlists) });
  } catch (e) {
    return reply({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
