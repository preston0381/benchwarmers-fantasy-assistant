const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testDatabasePath = path.join(
  os.tmpdir(),
  `benchwarmers-ranking-import-${process.pid}.db`
);

process.env.BENCHWARMERS_DB_FILE =
  testDatabasePath;

const {
  db,
  createDraftPlayer,
  getDraftPlayers,
  importPlayerRankings,
  calculateCombinedRank,
  parseRankedPosition
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

function playerByName(name) {
  return getDraftPlayers().find(
    player => player.name === name
  );
}

function assertFantasyProsFields(
  player,
  expected
) {
  for (
    const [field, value]
    of Object.entries(expected)
  ) {
    assert.equal(
      player[field],
      value,
      `${player.name} ${field}`
    );
  }
}

try {
  addPlayer("gibbs", "Jahmyr Gibbs", "RB", "DET");
  addPlayer("chase", "Ja'Marr Chase", "WR", "CIN");
  addPlayer("bijan", "Bijan Robinson", "RB", "ATL");
  addPlayer("allen", "Josh Allen", "QB", "BUF");
  addPlayer(
    "seattle",
    "Seattle Seahawks",
    "DEF",
    "SEA"
  );
  addPlayer(
    "missing",
    "Missing Fields",
    "TE",
    "NYG"
  );

  const fantasyProsRows = [
    {
      RK: "1",
      TIERS: "1",
      "PLAYER NAME": "Jahmyr Gibbs",
      TEAM: "DET",
      POS: "RB1",
      "BYE WEEK": "6",
      "UPSIDE ": "5 out of 5",
      "BUST ": "1 out of 5",
      "SOS SEASON": "5 out of 5 stars",
      "ECR VS. ADP": "0"
    },
    {
      RK: "2",
      TIERS: "1",
      "PLAYER NAME": "Ja'Marr Chase",
      TEAM: "CIN",
      POS: "WR1",
      "BYE WEEK": "6",
      "UPSIDE ": "5 out of 5",
      "BUST ": "1 out of 5",
      "SOS SEASON": "4 out of 5 stars",
      "ECR VS. ADP": "+1"
    },
    {
      RK: "3",
      TIERS: "1",
      "PLAYER NAME": "Bijan Robinson",
      TEAM: "ATL",
      POS: "RB2",
      "BYE WEEK": "11",
      "UPSIDE ": "5 out of 5",
      "BUST ": "1 out of 5",
      "SOS SEASON": "2 out of 5 stars",
      "ECR VS. ADP": "-1"
    },
    {
      RK: "23",
      TIERS: "4",
      "PLAYER NAME": "Josh Allen",
      TEAM: "BUF",
      POS: "QB1",
      "BYE WEEK": "7",
      "UPSIDE ": "5 out of 5",
      "BUST ": "1 out of 5",
      "SOS SEASON": "3 out of 5 stars",
      "ECR VS. ADP": "-5"
    },
    {
      RK: "100",
      TIERS: "10",
      "PLAYER NAME": "Seattle Seahawks",
      TEAM: "SEA",
      POS: "DST1",
      "BYE WEEK": "8",
      "UPSIDE ": "3 out of 5",
      "BUST ": "2 out of 5",
      "SOS SEASON": "4 out of 5 stars",
      "ECR VS. ADP": "+12"
    },
    {
      RK: "200",
      "PLAYER NAME": "Missing Fields",
      TEAM: "NYG",
      POS: "TE20"
    }
  ];

  const firstImport =
    importPlayerRankings(
      fantasyProsRows,
      "fantasypros"
    );

  assert.deepEqual(
    {
      matched: firstImport.matched,
      unmatched: firstImport.unmatched,
      ambiguous: firstImport.ambiguous,
      invalid: firstImport.invalid,
      rankedPlayers:
        firstImport.rankedPlayers
    },
    {
      matched: 6,
      unmatched: 0,
      ambiguous: 0,
      invalid: 0,
      rankedPlayers: 6
    }
  );

  assertFantasyProsFields(
    playerByName("Jahmyr Gibbs"),
    {
      fantasyProsRank: 1,
      fantasyProsTier: 1,
      fantasyProsPositionRank: 1,
      fantasyProsBye: 6,
      fantasyProsUpside: 5,
      fantasyProsBust: 1,
      fantasyProsSos: 5,
      fantasyProsEcrVsAdp: 0
    }
  );

  assertFantasyProsFields(
    playerByName("Ja'Marr Chase"),
    {
      fantasyProsRank: 2,
      fantasyProsTier: 1,
      fantasyProsPositionRank: 1,
      fantasyProsUpside: 5,
      fantasyProsBust: 1,
      fantasyProsSos: 4,
      fantasyProsEcrVsAdp: 1
    }
  );

  assertFantasyProsFields(
    playerByName("Bijan Robinson"),
    {
      fantasyProsRank: 3,
      fantasyProsTier: 1,
      fantasyProsPositionRank: 2,
      fantasyProsUpside: 5,
      fantasyProsBust: 1,
      fantasyProsSos: 2,
      fantasyProsEcrVsAdp: -1
    }
  );

  assertFantasyProsFields(
    playerByName("Josh Allen"),
    {
      fantasyProsRank: 23,
      fantasyProsTier: 4,
      fantasyProsPositionRank: 1,
      fantasyProsBye: 7,
      fantasyProsUpside: 5,
      fantasyProsBust: 1,
      fantasyProsSos: 3,
      fantasyProsEcrVsAdp: -5
    }
  );

  assert.deepEqual(
    parseRankedPosition("DST1"),
    {
      position: "DEF",
      positionRank: 1
    }
  );

  const seattle =
    playerByName("Seattle Seahawks");

  assert.equal(seattle.position, "DEF");
  assert.equal(
    seattle.fantasyProsPositionRank,
    1
  );

  assertFantasyProsFields(
    playerByName("Missing Fields"),
    {
      fantasyProsTier: null,
      fantasyProsPositionRank: 20,
      fantasyProsBye: null,
      fantasyProsUpside: null,
      fantasyProsBust: null,
      fantasyProsSos: null,
      fantasyProsEcrVsAdp: null
    }
  );

  const reimport =
    importPlayerRankings(
      [
        {
          RK: "10",
          TIERS: "2",
          "PLAYER NAME": "Jahmyr Gibbs",
          TEAM: "DET",
          POS: "RB3",
          "BYE WEEK": "9",
          "UPSIDE ": "4 out of 5",
          "BUST ": "2 out of 5",
          "SOS SEASON":
            "3 out of 5 stars",
          "ECR VS. ADP": "-4"
        }
      ],
      "fantasypros"
    );

  assert.equal(reimport.rankedPlayers, 6);

  assertFantasyProsFields(
    playerByName("Jahmyr Gibbs"),
    {
      fantasyProsRank: 10,
      fantasyProsTier: 2,
      fantasyProsPositionRank: 3,
      fantasyProsBye: 9,
      fantasyProsUpside: 4,
      fantasyProsBust: 2,
      fantasyProsSos: 3,
      fantasyProsEcrVsAdp: -4
    }
  );

  const duplicateCount = db
    .prepare(`
      SELECT COUNT(*) AS count
      FROM player_rankings
      WHERE player_id = 'gibbs'
        AND source = 'fantasypros'
    `)
    .get()
    .count;

  assert.equal(duplicateCount, 1);

  const pfnImport =
    importPlayerRankings(
      [
        {
          Rank: "2",
          Player: "Jahmyr Gibbs",
          Position: "RB",
          Team: "DET"
        },
        {
          Rank: "4",
          Player: "Ja'Marr Chase",
          Position: "WR",
          Team: "CIN"
        }
      ],
      "pfn"
    );

  assert.equal(pfnImport.matched, 2);
  assert.equal(pfnImport.rankedPlayers, 2);

  const pfnRow = db
    .prepare(`
      SELECT *
      FROM player_rankings
      WHERE player_id = 'gibbs'
        AND source = 'pfn'
    `)
    .get();

  for (
    const field of [
      "tier",
      "position_rank",
      "bye_week",
      "upside_score",
      "bust_score",
      "sos_score",
      "ecr_vs_adp"
    ]
  ) {
    assert.equal(pfnRow[field], null);
  }

  assert.equal(
    calculateCombinedRank(10, 2),
    6
  );

  assert.equal(
    playerByName("Jahmyr Gibbs")
      .combinedRank,
    6
  );

  importPlayerRankings(
    [
      {
        RK: "12",
        "PLAYER NAME": "Ja'Marr Chase",
        TEAM: "CIN",
        POS: "WR1"
      }
    ],
    "fantasypros"
  );

  assertFantasyProsFields(
    playerByName("Ja'Marr Chase"),
    {
      fantasyProsRank: 12,
      fantasyProsTier: null,
      fantasyProsPositionRank: 1,
      fantasyProsBye: null,
      fantasyProsUpside: null,
      fantasyProsBust: null,
      fantasyProsSos: null,
      fantasyProsEcrVsAdp: null
    }
  );

  console.log(
    "FantasyPros rich ranking import tests passed."
  );
} finally {
  db.close();

  for (
    const suffix of ["", "-wal", "-shm"]
  ) {
    fs.rmSync(
      `${testDatabasePath}${suffix}`,
      { force: true }
    );
  }
}
