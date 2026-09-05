const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testDatabasePath = path.join(
  os.tmpdir(),
  "benchwarmers-espn-injuries-" +
    process.pid +
    ".db"
);

process.env.BENCHWARMERS_DB_FILE =
  testDatabasePath;

const {
  parseEspnInjuryText,
  extractInjuryBodyPart
} = require("../espn-injuries");

const {
  db,
  createDraftPlayer,
  getDraftPlayers,
  previewEspnInjurySnapshot,
  replaceEspnInjurySnapshot,
  getEspnInjurySnapshotStatus
} = require("../database");

const sampleText = `
NFL Injuries
Scores
Advertisement

Arizona Cardinals
| NAME | POS | EST. RETURN DATE | STATUS | COMMENT |
| --- | --- | --- | --- | --- |
| [James Conner](https://espn.example/conner) | RB | Aug 28 | Questionable | |
Aug 26: Coach said Conner (foot) remains uncertain for Week 1.
| Trey Benson | RB | Nov 2 | Injured Reserve | Aug 25: Benson underwent a procedure on his (knee). |
| Garrett Williams | CB | Sep 7 | Questionable | Aug 24: Williams has an ankle issue. |

NAME | POS | EST. RETURN DATE | STATUS | COMMENT
Navigation

Cincinnati Bengals Injuries
| [Ja'Marr Chase](https://espn.example/chase) | WR | Sep 7 | Questionable | Aug 29: Chase (knee) was limited. |
| Broken Prospect | RB | Sep 7 | | Missing status |

Kansas City Chiefs
Patrick Mahomes
QB
Sep 7
Questionable
Aug 29: Mahomes (knee) returned to practice.

San Francisco 49ers
George Kittle TE Sep 7 Questionable Aug 28: Kittle is managing an Achilles injury.
Fred Warner LB Sep 7 Questionable Aug 28: Warner has a foot injury.

Baltimore Ravens
Justin Tucker\tK\tSep 7\tQuestionable\t

Pittsburgh Steelers
T.J. Watt | DE | Sep 7 | Out | Aug 28: Watt has a knee injury.
Minkah Fitzpatrick | S | Sep 7 | Questionable | Aug 28: Fitzpatrick has a shoulder injury.

Cleveland Browns
Imaginary Runner | RB | Sep 7 | Questionable | Aug 27: Runner (hamstring/finger) was limited.
`;

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

function findParsed(parsed, name) {
  return parsed.records.find(
    record => record.playerName === name
  );
}

function findPlayer(name) {
  return getDraftPlayers().find(
    player => player.name === name
  );
}

try {
  addPlayer(
    "conner",
    "James Conner",
    "RB",
    "ARI"
  );
  addPlayer(
    "benson",
    "Trey Benson",
    "RB",
    "ARI"
  );
  addPlayer(
    "chase",
    "Ja'Marr Chase",
    "WR",
    "CIN"
  );
  addPlayer(
    "mahomes",
    "Patrick Mahomes",
    "QB",
    "KC"
  );
  addPlayer(
    "kittle",
    "George Kittle",
    "TE",
    "SF"
  );
  addPlayer(
    "tucker",
    "Justin Tucker",
    "K",
    "BAL"
  );

  const parsed =
    parseEspnInjuryText(sampleText);

  assert.equal(
    extractInjuryBodyPart(
      "The player is back at practice."
    ),
    null
  );

  assert.equal(parsed.records.length, 7);
  assert.equal(parsed.ignored.length, 4);
  assert.equal(parsed.invalid.length, 1);

  const conner =
    findParsed(parsed, "James Conner");

  assert.equal(conner.status, "Questionable");
  assert.equal(conner.injuryBodyPart, "foot");
  assert.equal(conner.commentDate, "Aug 26");
  assert.match(conner.comment, /remains uncertain/);

  const benson =
    findParsed(parsed, "Trey Benson");

  assert.equal(
    benson.status,
    "Injured Reserve"
  );
  assert.equal(
    benson.injuryBodyPart,
    "knee"
  );

  assert.equal(
    findParsed(
      parsed,
      "Ja'Marr Chase"
    ).injuryBodyPart,
    "knee"
  );

  assert.equal(
    findParsed(
      parsed,
      "Patrick Mahomes"
    ).injuryBodyPart,
    "knee"
  );

  assert.equal(
    findParsed(
      parsed,
      "George Kittle"
    ).injuryBodyPart,
    "achilles"
  );

  const kicker =
    findParsed(parsed, "Justin Tucker");

  assert.equal(kicker.position, "K");
  assert.equal(kicker.comment, null);

  assert.ok(
    parsed.ignored.every(
      record =>
        ["CB", "LB", "DE", "S"]
          .includes(record.position)
    )
  );

  assert.equal(
    parsed.records.some(
      record =>
        record.playerName.includes("[")
    ),
    false
  );

  const preview =
    previewEspnInjurySnapshot(
      parsed.records
    );

  assert.deepEqual(
    {
      matched: preview.matched,
      unmatched: preview.unmatched,
      ambiguous: preview.ambiguous
    },
    {
      matched: 6,
      unmatched: 1,
      ambiguous: 0
    }
  );

  assert.equal(
    getEspnInjurySnapshotStatus().count,
    0
  );

  const firstApply =
    replaceEspnInjurySnapshot(
      parsed.records
    );

  assert.equal(firstApply.applied, 6);
  assert.equal(
    getEspnInjurySnapshotStatus().count,
    6
  );

  assert.deepEqual(
    {
      status:
        findPlayer("James Conner")
          .espnInjuryStatus,
      estimatedReturn:
        findPlayer("James Conner")
          .espnEstimatedReturn,
      bodyPart:
        findPlayer("James Conner")
          .espnInjuryBodyPart,
      commentDate:
        findPlayer("James Conner")
          .espnInjuryCommentDate
    },
    {
      status: "Questionable",
      estimatedReturn: "Aug 28",
      bodyPart: "foot",
      commentDate: "Aug 26"
    }
  );

  assert.equal(
    findPlayer("George Kittle")
      .espnInjuryBodyPart,
    "achilles"
  );

  const storedKicker =
    findPlayer("Justin Tucker");

  assert.equal(
    storedKicker.espnInjuryStatus,
    "Questionable"
  );
  assert.equal(
    storedKicker.espnInjuryComment,
    null
  );

  const unmatchedRow =
    preview.rows.find(
      row =>
        row.playerName ===
        "Imaginary Runner"
    );

  assert.equal(
    unmatchedRow.matchStatus,
    "unmatched"
  );

  assert.equal(
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM espn_injury_snapshot
      WHERE player_name =
        'Imaginary Runner'
    `).get().count,
    0
  );

  const secondParsed =
    parseEspnInjuryText(`
      Cincinnati Bengals
      Ja'Marr Chase | WR | Sep 14 | Out |
      Aug 30: Chase (knee) will be reevaluated.
    `);

  const secondApply =
    replaceEspnInjurySnapshot(
      secondParsed.records
    );

  assert.equal(secondApply.applied, 1);
  assert.equal(
    getEspnInjurySnapshotStatus().count,
    1
  );

  assert.equal(
    findPlayer("James Conner")
      .espnInjuryStatus,
    null
  );

  assert.equal(
    findPlayer("Ja'Marr Chase")
      .espnInjuryStatus,
    "Out"
  );

  console.log(
    "ESPN injury snapshot tests passed: " +
    "6 matched, 1 unmatched, 0 ambiguous, " +
    "4 ignored, 1 invalid."
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
