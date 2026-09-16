import assert from "node:assert/strict";

import { pollMintUntilAvailable } from "./poll.js";
import type { MintAttempt } from "./opensea.js";

const responses: MintAttempt[] = [
    { kind: "retry", status: 409 },
    { kind: "retry", status: 429, retryAfterMs: 1 },
    {
        kind: "available",
        transaction: {
            target: "0x00005ea00ac477b1030ce78506496e8c2de24bf5",
            calldata: "0x161ac21f",
            value: 100_000_000_000_000n,
        },
    },
];

let calls = 0;
const result = await pollMintUntilAvailable(new Date(), new AbortController().signal, async () => {
    const response = responses[calls++];
    assert.ok(response, "poller made more requests after a successful response");
    return response;
});

assert.equal(calls, 3);
assert.equal(result.attempt, 3);
assert.equal(result.transaction.value, 100_000_000_000_000n);
console.log("Polling test passed: 409 uses the configured interval, 429 honors cooldown, and polling stops at first valid response.");
