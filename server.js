const express = require('express');
const path = require('path');

const KEY = process.env.API_FOOTBALL_KEY;
const BASE = 'https://v3.football.api-sports.io';
const M = 60e3, H = 60 * M;

// IDs de API-Football. Se pueden cambiar con variables de entorno.
// Verifica con /api/find?q=america si el ID de tu equipo es el correcto.
const TEAMS = {
  america: +process.env.TEAM_AMERICA || 2287,
  barcelona: +process.env.TEAM_BARCELONA || 529,
  mexico: +process.env.TEAM_MEXICO || 16,
};

const cache = new Map();

async function api(q, ttl) {
  const hit = cache.get(q);
  if (hit && Date.now() - hit.t < (hit.err ? 5 * M : ttl)) {
    if (hit.err) throw new Error(hit.err);
    return hit.d;
  }
  if (!KEY) throw new Error('Falta la variable API_FOOTBALL_KEY en el servidor.');
  const r = await fetch(BASE + q, { headers: { 'x-apisports-key': KEY } });
  const j = await r.json();
  const errs = Array.isArray(j.errors) ? j.errors : Object.values(j.errors || {});
  if (errs.length) {
    cache.set(q, { t: Date.now(), err: errs.join(' | ') });
    throw new Error(errs.join(' | '));
  }
  cache.set(q, { t: Date.now(), d: j.response });
  return j.response;
}

const slim = (f) => ({
  id: f.fixture.id,
  date: f.fixture.date,
  status: f.fixture.status.short,
  minute: f.fixture.status.elapsed,
  league: f.league.name,
  round: f.league.round,
  venue: f.fixture.venue && f.fixture.venue.name,
  home: { id: f.teams.home.id, name: f.teams.home.name, logo: f.teams.home.logo },
  away: { id: f.teams.away.id, name: f.teams.away.name, logo: f.teams.away.logo },
  goals: f.goals,
});

const app = express();
const fs = require('fs');
app.use(express.static(path.join(__dirname, 'public')));

// Sirve index.html desde /public o, si GitHub no conservó la carpeta, desde la raíz.
app.get('/', (req, res) => {
  const inPublic = path.join(__dirname, 'public', 'index.html');
  const inRoot = path.join(__dirname, 'index.html');
  const file = fs.existsSync(inPublic) ? inPublic : inRoot;
  if (!fs.existsSync(file)) return res.status(404).send('No se encontró index.html en el repositorio.');
  res.sendFile(file);
});

app.get('/api/team/:key', async (req, res) => {
  const id = TEAMS[req.params.key];
  if (!id) return res.status(404).json({ error: 'Equipo desconocido' });
  try {
    const lastQ = `/fixtures?team=${id}&last=5`;
    const nextQ = `/fixtures?team=${id}&next=5`;
    // Cerca de un partido se refresca cada 5 min; el resto del tiempo cada 3 h.
    const near = (list) => (list || []).some((f) => Math.abs(new Date(f.fixture.date) - Date.now()) < 3 * H);
    const pl = cache.get(lastQ), pn = cache.get(nextQ);
    const soon = !pl || !pn || near(pl.d) || near(pn.d);
    const ttl = soon ? 5 * M : 3 * H;
    const [last, next] = await Promise.all([api(lastQ, ttl), api(nextQ, ttl)]);
    let live = null;
    if (near(last) || near(next)) {
      const all = await api('/fixtures?live=all', 60e3);
      const f = all.find((x) => x.teams.home.id === id || x.teams.away.id === id);
      if (f) live = slim(f);
    }
    res.json({ live, last: last.map(slim).reverse(), next: next.map(slim) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/match/:id', async (req, res) => {
  try {
    const [f] = await api(`/fixtures?id=${+req.params.id}`, 2 * M);
    if (!f) return res.status(404).json({ error: 'Partido no encontrado' });
    res.json({
      match: slim(f),
      stats: (f.statistics || []).length === 2
        ? f.statistics[0].statistics.map((s, i) => ({
            type: s.type, home: s.value, away: f.statistics[1].statistics[i] && f.statistics[1].statistics[i].value,
          }))
        : [],
      events: (f.events || []).map((e) => ({
        minute: e.time.elapsed + (e.time.extra || 0), team: e.team.name, player: e.player && e.player.name,
        type: e.type, detail: e.detail,
      })),
      lineups: (f.lineups || []).map((l) => ({
        team: l.team.name, formation: l.formation, coach: l.coach && l.coach.name,
        startXI: l.startXI.map((p) => `${p.player.number} ${p.player.name}`),
      })),
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Para confirmar el ID de un equipo: /api/find?q=america
app.get('/api/find', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 3) return res.status(400).json({ error: 'Escribe al menos 3 letras' });
    const r = await api(`/teams?search=${encodeURIComponent(q)}`, 24 * H);
    res.json(r.map((t) => ({ id: t.team.id, name: t.team.name, country: t.team.country, national: t.team.national })));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true, keyConfigured: !!KEY, teams: TEAMS }));

app.listen(process.env.PORT || 3000, () => console.log('Listo'));
