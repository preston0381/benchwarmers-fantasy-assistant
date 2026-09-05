const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  createDraftStateSignature,
  getDraftSyncConflict,
  pollDraftState
} = require("./next-pick.test");

const initialState = [
  {
    id: "player-1",
    status: "available",
    draftedBy: null
  },
  {
    id: "player-2",
    status: "drafted",
    draftedBy: "other"
  }
];

assert.equal(
  createDraftStateSignature(initialState),
  createDraftStateSignature(
    [...initialState].reverse()
  ),
  "Change detection should not depend on API ordering."
);

assert.notEqual(
  createDraftStateSignature(initialState),
  createDraftStateSignature([
    {
      ...initialState[0],
      status: "drafted",
      draftedBy: "preston"
    },
    initialState[1]
  ]),
  "Drafting a player should change the sync signature."
);

assert.notEqual(
  createDraftStateSignature(initialState),
  createDraftStateSignature([
    initialState[0],
    {
      ...initialState[1],
      status: "available",
      draftedBy: null
    }
  ]),
  "Making a player available should change the sync signature."
);

assert.notEqual(
  createDraftStateSignature(initialState),
  createDraftStateSignature([
    ...initialState,
    {
      id: "player-3",
      status: "available",
      draftedBy: null
    }
  ]),
  "Adding a player should change the sync signature."
);

const draftAction = {
  playerId: "player-1",
  status: "drafted",
  draftedBy: "preston"
};

assert.equal(
  getDraftSyncConflict(draftAction, initialState),
  null,
  "An available player should not invalidate a draft confirmation."
);

assert.deepEqual(
  JSON.parse(JSON.stringify(
    getDraftSyncConflict(
      draftAction,
      [
        {
          id: "player-1",
          status: "drafted",
          draftedBy: "trena"
        }
      ]
    )
  )),
  {
    message:
      "This player was drafted on another device.",
    buttonLabel: "Already Drafted"
  },
  "A remote draft should invalidate the local confirmation."
);

const html = fs.readFileSync(
  path.join(__dirname, "..", "public", "index.html"),
  "utf8"
);
const serverSource = fs.readFileSync(
  path.join(__dirname, "..", "server.js"),
  "utf8"
);

assert.match(
  html,
  /const DRAFT_SYNC_INTERVAL_MS = 2000;/,
  "Polling must run at exactly two-second intervals."
);
assert.match(
  html,
  /if \(draftSyncInFlight\) \{\s*return false;/,
  "Overlapping polls should be skipped."
);
assert.match(
  html,
  /if \(!draftSyncFailureWarned\)/,
  "Repeated poll failures should be warning-throttled."
);
assert.match(
  serverSource,
  /req\.query\.view === "draft-state"/,
  "The existing player endpoint should expose the lightweight sync view."
);

async function testPollingResilience() {
  let releaseRequest;
  const stalledRequest = () =>
    new Promise(resolve => {
      releaseRequest = resolve;
    });

  const firstPoll = pollDraftState(
    stalledRequest
  );
  const overlappingPoll =
    await pollDraftState(async () => {
      throw new Error(
        "An overlapping request should not start."
      );
    });

  assert.equal(
    overlappingPoll,
    false,
    "A second poll should be skipped while the first is in flight."
  );

  releaseRequest({ ok: false });

  assert.equal(
    await firstPoll,
    false,
    "A failed poll should leave the current board untouched."
  );

  const recoveredPoll = await pollDraftState(
    async () => ({
      ok: true,
      async json() {
        return { players: initialState };
      }
    })
  );

  assert.equal(
    recoveredPoll,
    false,
    "The next successful state check should recover without forcing a render."
  );
}

testPollingResilience()
  .then(() => {
    console.log(
      "Draft-board polling and conflict tests passed."
    );
  })
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
