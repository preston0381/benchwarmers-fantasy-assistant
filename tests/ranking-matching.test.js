const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testDatabasePath = path.join(
  os.tmpdir(),
  "benchwarmers-ranking-matching-" +
    process.pid +
    ".db"
);

process.env.BENCHWARMERS_DB_FILE =
  testDatabasePath;

const {
  db,
  createDraftPlayer,
  getDraftPlayers,
  importPlayerRankings,
  calculateCombinedRank
} = require("../database");

function addPlayer(
  id,
  name,
  position,
  nflTeam
) {
  createDraftPlayer({
    id,
    name,
    position,
    nflTeam
  });
}

function getPlayer(name) {
  return getDraftPlayers().find(
    player => player.name === name
  );
}

try {
  addPlayer(
    "same",
    "Same Team",
    "RB",
    "DET"
  );
  addPlayer(
    "traded",
    "Traded Player",
    "WR",
    "DAL"
  );
  addPlayer(
    "free-agent",
    "Free Agent Player",
    "RB",
    "MIA"
  );
  addPlayer(
    "duplicate-one",
    "Chris Example",
    "WR",
    "ATL"
  );
  addPlayer(
    "duplicate-two",
    "Chris Example",
    "WR",
    "BUF"
  );
  addPlayer(
    "position-guard",
    "Position Guard",
    "QB",
    "KC"
  );
  addPlayer(
    "punctuation",
    "D’Andre Test Jr.",
    "RB",
    "CHI"
  );
  addPlayer(
    "marquise",
    "Marquise Brown",
    "WR",
    "PHI"
  );
  addPlayer(
    "zonovan",
    "Zonovan Knight",
    "RB",
    "ARI"
  );
  addPlayer(
    "nicholas",
    "Nicholas Singleton",
    "RB",
    "TEN"
  );

  const fantasyProsResult =
    importPlayerRankings(
      [
        {
          RK: "1",
          "PLAYER NAME": "Same Team",
          TEAM: "DET",
          POS: "RB1",
          TIERS: "1",
          "UPSIDE ": "5 out of 5"
        },
        {
          RK: "2",
          "PLAYER NAME":
            "Traded Player",
          TEAM: "WAS",
          POS: "WR1"
        },
        {
          RK: "3",
          "PLAYER NAME":
            "Free Agent Player",
          TEAM: "Free Agent",
          POS: "RB2"
        },
        {
          RK: "4",
          "PLAYER NAME":
            "Chris Example",
          TEAM: "FA",
          POS: "WR2"
        },
        {
          RK: "5",
          "PLAYER NAME":
            "Position Guard",
          TEAM: "KC",
          POS: "TE1"
        },
        {
          RK: "6",
          "PLAYER NAME":
            "D'Andre Test",
          TEAM: "CHI",
          POS: "RB3"
        },
        {
          RK: "7",
          "PLAYER NAME":
            "Hollywood Brown",
          TEAM: "PHI",
          POS: "WR3"
        },
        {
          RK: "8",
          "PLAYER NAME": "Bam Knight",
          TEAM: "ARI",
          POS: "RB4"
        }
      ],
      "fantasypros"
    );

  assert.deepEqual(
    {
      matched:
        fantasyProsResult.matched,
      unmatched:
        fantasyProsResult.unmatched,
      ambiguous:
        fantasyProsResult.ambiguous,
      invalid:
        fantasyProsResult.invalid
    },
    {
      matched: 6,
      unmatched: 1,
      ambiguous: 1,
      invalid: 0
    }
  );

  assert.equal(
    getPlayer("Same Team")
      .fantasyProsRank,
    1
  );

  assert.equal(
    getPlayer("Traded Player")
      .fantasyProsRank,
    2
  );

  assert.equal(
    getPlayer("Traded Player").nflTeam,
    "DAL"
  );

  assert.equal(
    getPlayer("Free Agent Player")
      .fantasyProsRank,
    3
  );

  assert.equal(
    getPlayer("Position Guard")
      .fantasyProsRank,
    null
  );

  assert.equal(
    getPlayer("D’Andre Test Jr.")
      .fantasyProsRank,
    6
  );

  assert.equal(
    getPlayer("Marquise Brown")
      .fantasyProsRank,
    7
  );

  assert.equal(
    getPlayer("Zonovan Knight")
      .fantasyProsRank,
    8
  );

  const teamDisambiguated =
    importPlayerRankings(
      [
        {
          RK: "10",
          "PLAYER NAME":
            "Chris Example",
          TEAM: "ATL",
          POS: "WR5"
        }
      ],
      "fantasypros"
    );

  assert.equal(
    teamDisambiguated.matched,
    1
  );

  assert.equal(
    db.prepare(`
      SELECT rank
      FROM player_rankings
      WHERE player_id =
        'duplicate-one'
        AND source = 'fantasypros'
    `).get().rank,
    10
  );

  assert.equal(
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM player_rankings
      WHERE player_id =
        'duplicate-two'
        AND source = 'fantasypros'
    `).get().count,
    0
  );

  const pfnResult =
    importPlayerRankings(
      [
        {
          Rank: "2",
          Player: "Same Team",
          Position: "RB",
          Team: "DET"
        },
        {
          Rank: "9",
          Player: "Nick Singleton",
          Position: "RB",
          Team: "TEN"
        }
      ],
      "pfn"
    );

  assert.equal(pfnResult.matched, 2);
  assert.equal(pfnResult.unmatched, 0);

  assert.equal(
    getPlayer("Nicholas Singleton")
      .pfnRank,
    9
  );

  assert.equal(
    getPlayer("Same Team")
      .combinedRank,
    calculateCombinedRank(1, 2)
  );

  importPlayerRankings(
    [
      {
        RK: "11",
        "PLAYER NAME": "Same Team",
        TEAM: "DET",
        POS: "RB1"
      }
    ],
    "fantasypros"
  );

  assert.equal(
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM player_rankings
      WHERE player_id = 'same'
        AND source = 'fantasypros'
    `).get().count,
    1
  );

  assert.equal(
    getPlayer("Same Team").combinedRank,
    calculateCombinedRank(11, 2)
  );

  console.log(
    "Shared ranking matcher tests passed."
  );
} finally {
  db.close();

  for (
    const suffix of ["", "-wal", "-shm"]
  ) {
    fs.rmSync(
      testDatabasePath + suffix,
      { force: true }
    );
  }
}
