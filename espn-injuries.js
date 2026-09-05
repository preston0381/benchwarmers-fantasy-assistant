const FANTASY_POSITIONS =
  new Set(["QB", "RB", "WR", "TE", "K"]);

const IGNORED_POSITIONS = new Set([
  "CB",
  "S",
  "LB",
  "ILB",
  "OLB",
  "DE",
  "DT",
  "DL",
  "EDGE",
  "NT",
  "OL",
  "OT",
  "G",
  "C",
  "LS",
  "P",
  "FB"
]);

const TEAM_CODES = {
  "arizona cardinals": "ARI",
  "atlanta falcons": "ATL",
  "baltimore ravens": "BAL",
  "buffalo bills": "BUF",
  "carolina panthers": "CAR",
  "chicago bears": "CHI",
  "cincinnati bengals": "CIN",
  "cleveland browns": "CLE",
  "dallas cowboys": "DAL",
  "denver broncos": "DEN",
  "detroit lions": "DET",
  "green bay packers": "GB",
  "houston texans": "HOU",
  "indianapolis colts": "IND",
  "jacksonville jaguars": "JAX",
  "kansas city chiefs": "KC",
  "las vegas raiders": "LV",
  "los angeles chargers": "LAC",
  "los angeles rams": "LAR",
  "miami dolphins": "MIA",
  "minnesota vikings": "MIN",
  "new england patriots": "NE",
  "new orleans saints": "NO",
  "new york giants": "NYG",
  "new york jets": "NYJ",
  "philadelphia eagles": "PHI",
  "pittsburgh steelers": "PIT",
  "san francisco 49ers": "SF",
  "seattle seahawks": "SEA",
  "tampa bay buccaneers": "TB",
  "tennessee titans": "TEN",
  "washington commanders": "WAS"
};

const STATUS_PATTERN =
  /(Questionable|Doubtful|Injured Reserve|Reserve\/PUP|PUP|Out|Suspended|Day-To-Day|Probable)/i;

const POSITION_PATTERN =
  /^(QB|RB|WR|TE|K|CB|S|LB|ILB|OLB|DE|DT|DL|EDGE|NT|OL|OT|G|C|LS|P|FB)$/i;

const BODY_PART_PATTERN =
  /\b(achilles|ankle|back|calf|concussion|elbow|finger|foot|groin|hamstring|hand|head|heel|hip|knee|leg|neck|pectoral|quadriceps|rib|shoulder|toe|undisclosed|wrist)(?:\s*\/\s*(achilles|ankle|back|calf|elbow|finger|foot|groin|hamstring|hand|head|heel|hip|knee|leg|neck|pectoral|quadriceps|rib|shoulder|toe|undisclosed|wrist))?\b/i;

const CLEAR_BODY_PART_PATTERN =
  /\b((?:achilles|ankle|back|calf|concussion|elbow|finger|foot|groin|hamstring|hand|head|heel|hip|knee|leg|neck|pectoral|quadriceps|rib|shoulder|toe|undisclosed|wrist)(?:\s*\/\s*(?:achilles|ankle|back|calf|elbow|finger|foot|groin|hamstring|hand|head|heel|hip|knee|leg|neck|pectoral|quadriceps|rib|shoulder|toe|undisclosed|wrist))?)\s+(?:injury|issue|soreness|strain|sprain|pain|fracture|tear|ailment)\b/i;

function cleanLine(value) {
  return String(value || "")
    .replace(
      /\[([^\]]+)\]\([^\)]+\)/g,
      "$1"
    )
    .replace(/<[^>]+>/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePosition(value) {
  return cleanLine(value).toUpperCase();
}

function getTeamCode(value) {
  const normalized = cleanLine(value)
    .toLowerCase()
    .replace(/\s+injuries?$/, "")
    .trim();

  return TEAM_CODES[normalized] || null;
}

function isHeaderLine(value) {
  const normalized = cleanLine(value)
    .toUpperCase();

  return (
    normalized.includes("NAME") &&
    normalized.includes("POS") &&
    normalized.includes("STATUS")
  );
}

function extractCommentDate(comment) {
  const match = cleanLine(comment).match(
    /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+\d{1,2}:/i
  );

  if (!match) {
    return null;
  }

  return match[0].slice(0, -1);
}

function extractInjuryBodyPart(comment) {
  const cleanedComment = cleanLine(comment);

  if (!cleanedComment) {
    return null;
  }

  const parentheticals =
    cleanedComment.match(/\(([^\)]+)\)/g) || [];

  for (const parenthetical of parentheticals) {
    const bodyPart = parenthetical
      .slice(1, -1)
      .match(BODY_PART_PATTERN);

    if (bodyPart) {
      return bodyPart[0]
        .replace(/\s+/g, "")
        .toLowerCase();
    }
  }

  const explicitBodyPart =
    cleanedComment.match(
      CLEAR_BODY_PART_PATTERN
    );

  return explicitBodyPart
    ? explicitBodyPart[1]
        .replace(/\s+/g, "")
        .toLowerCase()
    : null;
}

function normalizeStatus(value) {
  const match = cleanLine(value).match(
    STATUS_PATTERN
  );

  return match ? match[1] : null;
}

function buildRecord({
  playerName,
  team,
  position,
  estimatedReturn,
  status,
  comment
}) {
  const cleanedComment = cleanLine(comment);

  return {
    source: "ESPN",
    playerName: cleanLine(playerName),
    team: team || null,
    position: normalizePosition(position),
    status: normalizeStatus(status),
    estimatedReturn:
      cleanLine(estimatedReturn) || null,
    comment: cleanedComment || null,
    injuryBodyPart:
      extractInjuryBodyPart(cleanedComment),
    commentDate:
      extractCommentDate(cleanedComment),
    snapshotImportedAt: null
  };
}

function splitTableLine(line) {
  if (line.includes("|")) {
    return line
      .replace(/^\s*\|/, "")
      .replace(/\|\s*$/, "")
      .split("|")
      .map(cleanLine);
  }

  if (line.includes("\t")) {
    return line
      .split(/\t+/)
      .map(cleanLine);
  }

  return null;
}

function parseColumns(
  columns,
  team
) {
  if (!columns || columns.length < 2) {
    return null;
  }

  const positionIndex =
    columns.findIndex(
      value =>
        POSITION_PATTERN.test(
          normalizePosition(value)
        )
    );

  if (positionIndex < 1) {
    return null;
  }

  const statusIndex =
    columns.findIndex(
      (value, index) =>
        index > positionIndex &&
        STATUS_PATTERN.test(value)
    );

  if (statusIndex === -1) {
    return {
      invalid: true,
      playerName: columns[0],
      position:
        normalizePosition(
          columns[positionIndex]
        ),
      rawText: columns.join(" | ")
    };
  }

  return buildRecord({
    playerName: columns
      .slice(0, positionIndex)
      .join(" "),
    team,
    position: columns[positionIndex],
    estimatedReturn: columns
      .slice(positionIndex + 1, statusIndex)
      .join(" "),
    status: columns[statusIndex],
    comment: columns
      .slice(statusIndex + 1)
      .join(" ")
  });
}

function parseLooseLine(line, team) {
  const positionMatch = line.match(
    /\s(QB|RB|WR|TE|K|CB|S|LB|ILB|OLB|DE|DT|DL|EDGE|NT|OL|OT|G|C|LS|P|FB)\s/i
  );

  const statusMatch = line.match(
    STATUS_PATTERN
  );

  if (
    !positionMatch ||
    !statusMatch ||
    statusMatch.index <= positionMatch.index
  ) {
    return null;
  }

  const positionEnd =
    positionMatch.index +
    positionMatch[0].length;

  return buildRecord({
    playerName: line.slice(
      0,
      positionMatch.index
    ),
    team,
    position: positionMatch[1],
    estimatedReturn: line.slice(
      positionEnd,
      statusMatch.index
    ),
    status: statusMatch[0],
    comment: line.slice(
      statusMatch.index +
        statusMatch[0].length
    )
  });
}

function parseStackedRecord(
  lines,
  startIndex,
  team
) {
  const playerName = cleanLine(
    lines[startIndex]
  );

  const position = normalizePosition(
    lines[startIndex + 1]
  );

  if (
    !playerName ||
    !POSITION_PATTERN.test(position)
  ) {
    return null;
  }

  let statusIndex = -1;

  for (
    let index = startIndex + 2;
    index < Math.min(
      lines.length,
      startIndex + 6
    );
    index += 1
  ) {
    if (STATUS_PATTERN.test(lines[index])) {
      statusIndex = index;
      break;
    }
  }

  if (statusIndex === -1) {
    return null;
  }

  const nextLine =
    cleanLine(lines[statusIndex + 1]);

  const hasComment =
    /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+\d{1,2}:/i
      .test(nextLine);

  return {
    record: buildRecord({
      playerName,
      team,
      position,
      estimatedReturn: lines
        .slice(
          startIndex + 2,
          statusIndex
        )
        .map(cleanLine)
        .join(" "),
      status: lines[statusIndex],
      comment: hasComment
        ? nextLine
        : ""
    }),
    consumedThrough:
      hasComment
        ? statusIndex + 1
        : statusIndex
  };
}

function parseEspnInjuryText(text) {
  if (typeof text !== "string") {
    throw new TypeError(
      "ESPN injury text must be a string."
    );
  }

  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(line => line.trim());

  const records = [];
  const ignored = [];
  const invalid = [];
  const seenRecords = new Set();
  let currentTeam = null;
  let pendingRecord = null;

  function addRecord(record) {
    if (!record) {
      return;
    }

    if (record.invalid) {
      invalid.push({
        playerName:
          cleanLine(record.playerName) || null,
        position:
          normalizePosition(record.position) ||
          null,
        rawText:
          cleanLine(record.rawText) || null,
        matchStatus: "invalid"
      });
      return;
    }

    if (!record.playerName || !record.status) {
      invalid.push({
        playerName:
          record.playerName || null,
        position:
          record.position || null,
        rawText: null,
        matchStatus: "invalid"
      });
      return;
    }

    const destination =
      FANTASY_POSITIONS.has(record.position)
        ? records
        : IGNORED_POSITIONS.has(record.position)
          ? ignored
          : invalid;

    const matchStatus =
      destination === ignored
        ? "ignored"
        : destination === invalid
          ? "invalid"
          : null;

    const key = [
      record.playerName.toLowerCase(),
      record.team || "",
      record.position,
      record.status,
      record.estimatedReturn || "",
      record.comment || ""
    ].join("|");

    if (seenRecords.has(key)) {
      return;
    }

    seenRecords.add(key);
    destination.push(
      matchStatus
        ? {
            ...record,
            matchStatus
          }
        : record
    );

    if (destination === records) {
      pendingRecord =
        records[records.length - 1];
    }
  }

  for (
    let index = 0;
    index < lines.length;
    index += 1
  ) {
    const rawLine = lines[index];
    const line = cleanLine(rawLine);

    if (!line) {
      continue;
    }

    const teamCode = getTeamCode(line);

    if (teamCode) {
      currentTeam = teamCode;
      pendingRecord = null;
      continue;
    }

    if (
      isHeaderLine(line) ||
      /^[-:|\s]+$/.test(line)
    ) {
      continue;
    }

    if (
      pendingRecord &&
      /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+\d{1,2}:/i
        .test(line)
    ) {
      pendingRecord.comment = cleanLine(
        [pendingRecord.comment, line]
          .filter(Boolean)
          .join(" ")
      );
      pendingRecord.commentDate =
        extractCommentDate(
          pendingRecord.comment
        );
      pendingRecord.injuryBodyPart =
        extractInjuryBodyPart(
          pendingRecord.comment
        );
      continue;
    }

    const columns = splitTableLine(rawLine);

    if (columns) {
      addRecord(
        parseColumns(columns, currentTeam)
      );
      continue;
    }

    const looseRecord =
      parseLooseLine(line, currentTeam);

    if (looseRecord) {
      addRecord(looseRecord);
      continue;
    }

    const stacked = parseStackedRecord(
      lines,
      index,
      currentTeam
    );

    if (stacked) {
      addRecord(stacked.record);
      index = stacked.consumedThrough;
    }
  }

  return {
    records,
    ignored,
    invalid
  };
}

module.exports = {
  FANTASY_POSITIONS,
  IGNORED_POSITIONS,
  parseEspnInjuryText,
  extractInjuryBodyPart,
  extractCommentDate
};
