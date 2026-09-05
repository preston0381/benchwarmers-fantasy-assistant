const assert = require("node:assert/strict");

const {
  createInjuryBadge,
  getInjuryBadgeStatus,
  getInjuryTooltipLines
} = require("./next-pick.test");

function tooltipText(player) {
  return Array.from(getInjuryTooltipLines(player)).map(
    line => line.text
  );
}

const questionable = {
  name: "Questionable Player",
  espnInjuryStatus: "Questionable",
  espnInjuryBodyPart: "Knee",
  espnEstimatedReturn: "Week 1",
  espnInjuryComment:
    "On track to be ready for the opener.",
  espnInjuryCommentDate: "2026-08-29"
};

assert.equal(
  createInjuryBadge(questionable).textContent,
  "Q",
  "A Questionable player should receive a Q badge."
);
assert.deepEqual(
  tooltipText(questionable),
  [
    "Questionable",
    "Knee",
    "Estimated return: Week 1",
    "On track to be ready for the opener.",
    "Aug 29"
  ],
  "The complete tooltip should preserve the requested field order."
);

const injuredReserve = {
  name: "IR Player",
  espnInjuryStatus: "Reserve/PUP",
  espnEstimatedReturn: "Week 5"
};

assert.equal(
  createInjuryBadge(injuredReserve).textContent,
  "IR",
  "Reserve/PUP should map to IR."
);
assert.deepEqual(
  tooltipText(injuredReserve),
  ["Injured Reserve", "Estimated return: Week 5"],
  "Partial records should omit unavailable tooltip fields."
);

assert.equal(
  getInjuryBadgeStatus("Out").label,
  "OUT",
  "Out should map to OUT."
);
assert.equal(
  getInjuryBadgeStatus("Doubtful").label,
  "D",
  "Doubtful should map to D."
);
assert.equal(
  createInjuryBadge({
    name: "No Record"
  }),
  null,
  "A player without an ESPN status should have no badge."
);

const externalCharacters = `< > & " '`;
const unsafeLookingPlayer = {
  name: "External Text",
  espnInjuryStatus: "Questionable",
  espnInjuryComment: externalCharacters
};
const unsafeLookingLines = getInjuryTooltipLines(
  unsafeLookingPlayer
);

assert.equal(
  unsafeLookingLines.at(-1).text,
  externalCharacters,
  "Imported characters should remain plain text for textContent rendering."
);

const source = require("node:fs").readFileSync(
  require("node:path").join(
    __dirname,
    "..",
    "public",
    "index.html"
  ),
  "utf8"
);

assert.match(
  source,
  /item\.textContent = line\.text;/,
  "Tooltip lines must be rendered with textContent."
);
assert.match(
  source,
  /badge\.tabIndex = 0;/,
  "Injury badges should be keyboard focusable."
);
assert.match(
  source,
  /addEventListener\("focus"/,
  "Keyboard focus should show the tooltip."
);
assert.match(
  source,
  /\.injury-tooltip[\s\S]*?pointer-events: none;/,
  "The tooltip should not block Draft Board controls."
);

console.log("Injury badge scenarios A-F passed.");
