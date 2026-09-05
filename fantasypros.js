const FANTASYPROS_BASE_URL =
  "https://api.fantasypros.com/public/v2/json";

const FANTASYPROS_CACHE_TTL_MS =
  15 * 60 * 1000;

class FantasyProsError extends Error {
  constructor(message, { status = 502, code = "FANTASYPROS_ERROR" } = {}) {
    super(message);
    this.name = "FantasyProsError";
    this.status = status;
    this.code = code;
  }
}

function compactText(value) {
  if (typeof value !== "string") {
    return value ?? null;
  }

  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCategories(categories) {
  if (Array.isArray(categories)) {
    return categories
      .map((category) => compactText(category))
      .filter(Boolean);
  }

  if (typeof categories === "string") {
    return categories
      .split(",")
      .map((category) => category.trim())
      .filter(Boolean);
  }

  return [];
}

function normalizeNewsItem(item = {}) {
  return {
    id: item.id ?? null,
    playerId: item.player_id ?? null,
    playerName:
      item.player_name ?? item.name ?? null,
    team: item.team_id ?? item.team ?? null,
    title: compactText(item.title),
    summary: compactText(
      item.desc ?? item.description ?? item.summary
    ),
    impact: compactText(item.impact),
    categories: normalizeCategories(item.categories),
    createdAt: item.created ?? null,
    sourceUrl: item.link ?? item.url ?? null
  };
}

function normalizeInjuryItem(item = {}) {
  return {
    playerId: item.player_id ?? null,
    playerName:
      item.player_name ?? item.name ?? null,
    team: item.team_id ?? item.team ?? null,
    position:
      item.position_id ?? item.position ?? null,
    injury:
      item.injury_type ??
      item.practice_report_injury_type ??
      null,
    status: item.status ?? null,
    statusShort: item.status_short ?? null,
    bodyPart:
      item.body_part ??
      item.practice_report_injury_type ??
      null,
    practiceStatus: [
      item.practice_1,
      item.practice_2,
      item.practice_3
    ].filter((status) => status != null),
    gameStatus:
      item.game_status ?? item.status ?? null,
    probabilityOfPlaying:
      item.probability_of_playing ?? null,
    summary: compactText(item.comment),
    updatedAt: item.injury_update_date ?? null
  };
}

function createFantasyProsClient({
  fetchImpl = globalThis.fetch,
  apiKeyProvider = () =>
    process.env.FANTASYPROS_API_KEY,
  now = () => Date.now(),
  cacheTtlMs = FANTASYPROS_CACHE_TTL_MS
} = {}) {
  const cache = new Map();
  const inFlight = new Map();

  async function request(resource, normalizeItem) {
    const currentTime = now();
    const cached = cache.get(resource);

    if (cached && cached.expiresAt > currentTime) {
      return {
        ...cached.payload,
        cached: true
      };
    }

    if (inFlight.has(resource)) {
      const payload = await inFlight.get(resource);
      return {
        ...payload,
        cached: true
      };
    }

    const apiKey = apiKeyProvider();

    if (!apiKey) {
      throw new FantasyProsError(
        "FantasyPros API is not configured.",
        {
          status: 503,
          code: "FANTASYPROS_NOT_CONFIGURED"
        }
      );
    }

    if (typeof fetchImpl !== "function") {
      throw new FantasyProsError(
        "FantasyPros requests are unavailable.",
        {
          status: 503,
          code: "FANTASYPROS_FETCH_UNAVAILABLE"
        }
      );
    }

    const requestPromise = (async () => {
      let response;

      try {
        response = await fetchImpl(
          `${FANTASYPROS_BASE_URL}/nfl/${resource}`,
          {
            headers: {
              Accept: "application/json",
              "x-api-key": apiKey
            },
            signal: AbortSignal.timeout(10000)
          }
        );
      } catch (error) {
        throw new FantasyProsError(
          "FantasyPros is temporarily unavailable.",
          { code: "FANTASYPROS_UNAVAILABLE" }
        );
      }

      if (!response.ok) {
        if (response.status === 429) {
          throw new FantasyProsError(
            "FantasyPros rate limit reached. Try again later.",
            {
              status: 429,
              code: "FANTASYPROS_RATE_LIMITED"
            }
          );
        }

        throw new FantasyProsError(
          "FantasyPros could not provide current data.",
          {
            status: 502,
            code: "FANTASYPROS_UPSTREAM_ERROR"
          }
        );
      }

      let upstream;

      try {
        upstream = await response.json();
      } catch (error) {
        throw new FantasyProsError(
          "FantasyPros returned an invalid response.",
          { code: "FANTASYPROS_INVALID_RESPONSE" }
        );
      }

      const sourceItems =
        resource === "news"
          ? upstream.items
          : upstream.injuries;

      if (!Array.isArray(sourceItems)) {
        throw new FantasyProsError(
          "FantasyPros returned an unexpected response.",
          { code: "FANTASYPROS_INVALID_RESPONSE" }
        );
      }

      const fetchedAtMs = now();
      const payload = {
        sport: upstream.sport ?? "NFL",
        count: sourceItems.length,
        upstreamCount:
          typeof upstream.count === "number"
            ? upstream.count
            : sourceItems.length,
        fetchedAt: new Date(fetchedAtMs).toISOString(),
        expiresAt: new Date(
          fetchedAtMs + cacheTtlMs
        ).toISOString(),
        cached: false,
        items: sourceItems.map(normalizeItem)
      };

      cache.set(resource, {
        expiresAt: fetchedAtMs + cacheTtlMs,
        payload
      });

      return payload;
    })();

    inFlight.set(resource, requestPromise);

    try {
      return await requestPromise;
    } finally {
      inFlight.delete(resource);
    }
  }

  return {
    fetchFantasyProsNews() {
      return request("news", normalizeNewsItem);
    },
    fetchFantasyProsInjuries() {
      return request("injuries", normalizeInjuryItem);
    },
    clearCache() {
      cache.clear();
    }
  };
}

const fantasyProsClient = createFantasyProsClient();

module.exports = {
  FANTASYPROS_BASE_URL,
  FANTASYPROS_CACHE_TTL_MS,
  FantasyProsError,
  createFantasyProsClient,
  normalizeNewsItem,
  normalizeInjuryItem,
  fetchFantasyProsNews:
    fantasyProsClient.fetchFantasyProsNews,
  fetchFantasyProsInjuries:
    fantasyProsClient.fetchFantasyProsInjuries
};
