const assert = require("node:assert/strict");

const {
  FantasyProsError,
  createFantasyProsClient,
  normalizeNewsItem,
  normalizeInjuryItem
} = require("../fantasypros");

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    }
  };
}

const newsItem = normalizeNewsItem({
  id: 10,
  player_id: 20,
  team_id: "MIN",
  title: "Player update",
  desc: "<strong>Ready</strong> to play.",
  categories: ["News", "Injury"],
  created: "2026-08-30 12:00:00",
  link: "https://example.com/news"
});

assert.deepEqual(newsItem, {
  id: 10,
  playerId: 20,
  playerName: null,
  team: "MIN",
  title: "Player update",
  summary: "Ready to play.",
  impact: null,
  categories: ["News", "Injury"],
  createdAt: "2026-08-30 12:00:00",
  sourceUrl: "https://example.com/news"
});

const injuryItem = normalizeInjuryItem({
  player_id: 30,
  name: "Test Player",
  team_id: "GB",
  position_id: "WR",
  injury_type: "Hamstring",
  status: "Questionable",
  status_short: "Q",
  practice_1: "DNP",
  practice_2: "Limit",
  practice_3: "Full",
  probability_of_playing: "0.75",
  comment: "Trending upward.",
  injury_update_date: "2026-08-30"
});

assert.equal(injuryItem.playerName, "Test Player");
assert.equal(injuryItem.position, "WR");
assert.equal(injuryItem.bodyPart, null);
assert.deepEqual(
  injuryItem.practiceStatus,
  ["DNP", "Limit", "Full"]
);

let fetchCount = 0;
let currentTime = Date.UTC(2026, 7, 30, 12);

const cachedClient = createFantasyProsClient({
  apiKeyProvider: () => "test-key",
  now: () => currentTime,
  fetchImpl: async (url, options) => {
    fetchCount += 1;
    assert.match(url, /\/nfl\/news$/);
    assert.equal(
      options.headers["x-api-key"],
      "test-key"
    );

    return jsonResponse({
      sport: "NFL",
      count: 1,
      items: [{ id: 1, title: "News" }]
    });
  }
});

(async () => {
  const first = await cachedClient.fetchFantasyProsNews();
  const second = await cachedClient.fetchFantasyProsNews();

  assert.equal(fetchCount, 1);
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(second.fetchedAt, first.fetchedAt);

  currentTime += 15 * 60 * 1000 + 1;
  await cachedClient.fetchFantasyProsNews();
  assert.equal(fetchCount, 2);

  const concurrentClient = createFantasyProsClient({
    apiKeyProvider: () => "test-key",
    fetchImpl: async () => {
      await new Promise((resolve) =>
        setTimeout(resolve, 5)
      );
      return jsonResponse({
        sport: "NFL",
        count: 0,
        injuries: []
      });
    }
  });

  const [initial, joined] = await Promise.all([
    concurrentClient.fetchFantasyProsInjuries(),
    concurrentClient.fetchFantasyProsInjuries()
  ]);

  assert.equal(initial.cached, false);
  assert.equal(joined.cached, true);

  const missingKeyClient = createFantasyProsClient({
    apiKeyProvider: () => "",
    fetchImpl: async () => {
      throw new Error("should not be called");
    }
  });

  await assert.rejects(
    missingKeyClient.fetchFantasyProsNews(),
    (error) =>
      error instanceof FantasyProsError &&
      error.status === 503 &&
      error.code === "FANTASYPROS_NOT_CONFIGURED"
  );

  const rateLimitedClient = createFantasyProsClient({
    apiKeyProvider: () => "test-key",
    fetchImpl: async () => jsonResponse({}, 429)
  });

  await assert.rejects(
    rateLimitedClient.fetchFantasyProsInjuries(),
    (error) =>
      error instanceof FantasyProsError &&
      error.status === 429 &&
      error.code === "FANTASYPROS_RATE_LIMITED" &&
      !error.message.includes("test-key")
  );

  console.log("FantasyPros integration tests passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
