// src/routes/user.routes.js
"use strict";

const express  = require("express");
const bcrypt   = require("bcryptjs");
const jwt      = require("jsonwebtoken");
const { query } = require("../db");
const { ApiError } = require("../utils/api-error");

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "rik-anime-secret-change-me";
const JWT_EXPIRES = "30d";

// ── Helpers ──────────────────────────────────────

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function signToken(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return next(new ApiError(401, "No autenticado"));
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    req.userId = Number(payload.sub);
    next();
  } catch {
    next(new ApiError(401, "Token inválido o expirado"));
  }
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ═══════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════

// POST /api/users/register
router.post("/register", asyncHandler(async (req, res) => {
  const { email, username, password } = req.body || {};

  if (!email || !username || !password)
    throw new ApiError(400, "Email, nombre de usuario y contraseña son requeridos");
  if (!validateEmail(email))
    throw new ApiError(400, "El email no tiene un formato válido");
  if (password.length < 6)
    throw new ApiError(400, "La contraseña debe tener al menos 6 caracteres");
  if (username.trim().length < 2)
    throw new ApiError(400, "El nombre de usuario debe tener al menos 2 caracteres");

  const existing = await query(
    "SELECT id FROM users WHERE email = $1 OR username = $2",
    [email.toLowerCase(), username.trim()]
  );
  if (existing.rows.length > 0)
    throw new ApiError(409, "El email o nombre de usuario ya están registrados");

  const hash = await bcrypt.hash(password, 12);
  const result = await query(
    "INSERT INTO users (email, username, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email",
    [email.toLowerCase(), username.trim(), hash]
  );
  const user = result.rows[0];

  // Crear playlists por defecto
  await query(
    "INSERT INTO playlists (user_id, name) VALUES ($1,'Ver más tarde'),($1,'Completados') ON CONFLICT DO NOTHING",
    [user.id]
  );

  res.status(201).json({
    success: true,
    token: signToken(user.id),
    user: { id: user.id, username: user.username, email: user.email },
  });
}));

// POST /api/users/login
router.post("/login", asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) throw new ApiError(400, "Email y contraseña requeridos");

  const result = await query(
    "SELECT id, username, email, password_hash FROM users WHERE email = $1",
    [email.toLowerCase()]
  );
  if (!result.rows.length) throw new ApiError(401, "Credenciales incorrectas");

  const user = result.rows[0];
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) throw new ApiError(401, "Credenciales incorrectas");

  res.json({
    success: true,
    token: signToken(user.id),
    user: { id: user.id, username: user.username, email: user.email },
  });
}));

// GET /api/users/me — sincronizar todos los datos del usuario
router.get("/me", authMiddleware, asyncHandler(async (req, res) => {
  const uid = req.userId;

  const [userRes, favsRes, followRes, histRes, playlistsRes] = await Promise.all([
    query("SELECT id, username, email FROM users WHERE id = $1", [uid]),
    query("SELECT mal_id, title, image, score, type FROM favorites WHERE user_id = $1 ORDER BY added_at DESC", [uid]),
    query("SELECT mal_id, title, image, broadcast, episodes FROM following WHERE user_id = $1 ORDER BY added_at DESC", [uid]),
    query("SELECT mal_id, episode, time_sec, updated_at FROM watch_history WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 50", [uid]),
    query(`
      SELECT p.id, p.name,
        COALESCE(json_agg(pi ORDER BY pi.added_at) FILTER (WHERE pi.id IS NOT NULL), '[]') AS items
      FROM playlists p
      LEFT JOIN playlist_items pi ON pi.playlist_id = p.id
      WHERE p.user_id = $1
      GROUP BY p.id, p.name
      ORDER BY p.created_at
    `, [uid]),
  ]);

  if (!userRes.rows.length) throw new ApiError(404, "Usuario no encontrado");

  // Convertir historial al formato que espera el frontend
  const history = histRes.rows.map(h => ({
    key:       `${h.mal_id}_${h.episode}`,
    mal_id:    h.mal_id,
    episode:   h.episode,
    time:      Number(h.time_sec),
    updatedAt: new Date(h.updated_at).getTime(),
  }));

  res.json({
    success: true,
    user: userRes.rows[0],
    favorites: favsRes.rows,
    following: followRes.rows,
    history,
    playlists: playlistsRes.rows,
  });
}));

// ═══════════════════════════════════════════════════
// FAVORITOS
// ═══════════════════════════════════════════════════

// POST /api/users/favorites
router.post("/favorites", authMiddleware, asyncHandler(async (req, res) => {
  const { mal_id, title, image, score, type } = req.body || {};
  if (!mal_id) throw new ApiError(400, "mal_id requerido");

  await query(
    `INSERT INTO favorites (user_id, mal_id, title, image, score, type)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (user_id, mal_id) DO NOTHING`,
    [req.userId, mal_id, title, image, score, type]
  );
  res.json({ success: true });
}));

// DELETE /api/users/favorites/:malId
router.delete("/favorites/:malId", authMiddleware, asyncHandler(async (req, res) => {
  await query("DELETE FROM favorites WHERE user_id=$1 AND mal_id=$2", [req.userId, req.params.malId]);
  res.json({ success: true });
}));

// ═══════════════════════════════════════════════════
// SIGUIENDO
// ═══════════════════════════════════════════════════

router.post("/following", authMiddleware, asyncHandler(async (req, res) => {
  const { mal_id, title, image, broadcast, episodes } = req.body || {};
  if (!mal_id) throw new ApiError(400, "mal_id requerido");

  await query(
    `INSERT INTO following (user_id, mal_id, title, image, broadcast, episodes)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (user_id, mal_id) DO UPDATE SET title=$3, image=$4, broadcast=$5, episodes=$6`,
    [req.userId, mal_id, title, image, JSON.stringify(broadcast || {}), episodes || 0]
  );
  res.json({ success: true });
}));

router.delete("/following/:malId", authMiddleware, asyncHandler(async (req, res) => {
  await query("DELETE FROM following WHERE user_id=$1 AND mal_id=$2", [req.userId, req.params.malId]);
  res.json({ success: true });
}));

// ═══════════════════════════════════════════════════
// HISTORIAL / CONTINUAR VIENDO
// ═══════════════════════════════════════════════════

// PUT /api/users/history  — upsert de un entry
router.put("/history", authMiddleware, asyncHandler(async (req, res) => {
  const { mal_id, episode, time_sec } = req.body || {};
  if (!mal_id || episode == null) throw new ApiError(400, "mal_id y episode requeridos");

  await query(
    `INSERT INTO watch_history (user_id, mal_id, episode, time_sec, updated_at)
     VALUES ($1,$2,$3,$4,NOW())
     ON CONFLICT (user_id, mal_id, episode)
     DO UPDATE SET time_sec=$4, updated_at=NOW()`,
    [req.userId, mal_id, episode, time_sec || 0]
  );
  res.json({ success: true });
}));

// ═══════════════════════════════════════════════════
// PLAYLISTS
// ═══════════════════════════════════════════════════

// POST /api/users/playlists
router.post("/playlists", authMiddleware, asyncHandler(async (req, res) => {
  const { name } = req.body || {};
  if (!name?.trim()) throw new ApiError(400, "Nombre de playlist requerido");

  const result = await query(
    "INSERT INTO playlists (user_id, name) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING id, name",
    [req.userId, name.trim()]
  );
  if (!result.rows.length) throw new ApiError(409, "Ya existe una playlist con ese nombre");

  res.status(201).json({ success: true, playlist: result.rows[0] });
}));

// DELETE /api/users/playlists/:id
router.delete("/playlists/:id", authMiddleware, asyncHandler(async (req, res) => {
  await query("DELETE FROM playlists WHERE id=$1 AND user_id=$2", [req.params.id, req.userId]);
  res.json({ success: true });
}));

// POST /api/users/playlists/:id/items
router.post("/playlists/:id/items", authMiddleware, asyncHandler(async (req, res) => {
  const { mal_id, title, image, score, type } = req.body || {};
  if (!mal_id) throw new ApiError(400, "mal_id requerido");

  // Verificar que la playlist le pertenece
  const pl = await query("SELECT id FROM playlists WHERE id=$1 AND user_id=$2", [req.params.id, req.userId]);
  if (!pl.rows.length) throw new ApiError(403, "Playlist no encontrada");

  await query(
    `INSERT INTO playlist_items (playlist_id, mal_id, title, image, score, type)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (playlist_id, mal_id) DO NOTHING`,
    [req.params.id, mal_id, title, image, score, type]
  );
  res.json({ success: true });
}));

// DELETE /api/users/playlists/:id/items/:malId
router.delete("/playlists/:id/items/:malId", authMiddleware, asyncHandler(async (req, res) => {
  await query(
    "DELETE FROM playlist_items WHERE playlist_id=$1 AND mal_id=$2",
    [req.params.id, req.params.malId]
  );
  res.json({ success: true });
}));

module.exports = { router, authMiddleware };
