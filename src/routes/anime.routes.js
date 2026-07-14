const express = require("express");
const { requireApiKey } = require("../middlewares/auth");
const { dailyRateLimit } = require("../middlewares/rate-limit");
const animeService = require("../services/anime.service");
const downloadService = require("../services/download.service");
const { ApiError } = require("../utils/api-error");

const router = express.Router();

function asyncHandler(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}

router.use(requireApiKey, dailyRateLimit);

router.get(
  "/search",
  asyncHandler(async (req, res) => {
    const response = await animeService.searchAnime(req.query.q, req.query.domain);
    res.status(200).json(response);
  })
);

router.get(
  "/info",
  asyncHandler(async (req, res) => {
    if (!req.query.url) {
      throw new ApiError(400, "Se requiere el parametro url");
    }

    const response = await animeService.getAnimeInfo(req.query.url);
    res.status(200).json(response);
  })
);

router.get(
  "/episode",
  asyncHandler(async (req, res) => {
    if (!req.query.url) {
      throw new ApiError(400, "Se requiere el parametro url");
    }

    const response = await animeService.getEpisodeLinks(req.query.url, req.query.includeMega, req.query.excludeServers);
    res.status(200).json(response);
  })
);

router.post(
  "/download",
  asyncHandler(async (req, res) => {
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const data = downloadService.createDownload(req.body || {}, baseUrl);

    res.status(200).json({
      success: true,
      data,
    });
  })
);

router.get(
  "/download/:id",
  asyncHandler(async (req, res) => {
    const data = downloadService.getDownload(req.params.id);

    res.status(200).json({
      success: true,
      data,
    });
  })
);

router.post(
  "/batch-download",
  asyncHandler(async (req, res) => {
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const data = downloadService.createBatch(req.body || {}, baseUrl);

    res.status(200).json({
      success: true,
      data,
    });
  })
);

router.get(
  "/batch/:id",
  asyncHandler(async (req, res) => {
    const data = downloadService.getBatch(req.params.id);

    res.status(200).json({
      success: true,
      data,
    });
  })
);

// ── Agregar este endpoint en anime.routes.js ──────────────────
// Va junto a los demás router.get(...)

router.get("/jikan/search", asyncHandler(async (req, res) => {
  const { q, type, status, limit = 20 } = req.query;
  if (!q) throw new ApiError(400, "Parámetro q requerido");

  const params = new URLSearchParams({ q, sfw: "true", limit });
  if (type)   params.set("type",   type);
  if (status) params.set("status", status);

  const response = await axios.get(
    `https://api.jikan.moe/v4/anime?${params.toString()}`
  );
  res.status(200).json(response.data);
}));

router.get("/jikan/anime/:id", asyncHandler(async (req, res) => {
  const { id } = req.params;
  const response = await axios.get(`https://api.jikan.moe/v4/anime/${id}/full`);
  res.status(200).json(response.data);
}));

router.get("/jikan/top", asyncHandler(async (req, res) => {
  const { limit = 25, page = 1 } = req.query;
  const response = await axios.get(
    `https://api.jikan.moe/v4/top/anime?limit=${limit}&page=${page}&sfw=true`
  );
  res.status(200).json(response.data);
}));

router.get("/jikan/seasons/now", asyncHandler(async (req, res) => {
  const { limit = 25 } = req.query;
  const response = await axios.get(
    `https://api.jikan.moe/v4/seasons/now?limit=${limit}&sfw=true`
  );
  res.status(200).json(response.data);
}));

router.get("/jikan/schedules", asyncHandler(async (req, res) => {
  const { limit = 25 } = req.query;
  const response = await axios.get(
    `https://api.jikan.moe/v4/schedules?limit=${limit}&sfw=true`
  );
  res.status(200).json(response.data);
}));

router.get("/jikan/genres", asyncHandler(async (req, res) => {
  const { id, limit = 24, page = 1 } = req.query;
  if (!id) throw new ApiError(400, "Parámetro id requerido");
  const response = await axios.get(
    `https://api.jikan.moe/v4/anime?genres=${id}&order_by=score&sort=desc&limit=${limit}&page=${page}&sfw=true`
  );
  res.status(200).json(response.data);
}));

module.exports = router;
