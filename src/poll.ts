import { performance } from "node:perf_hooks";

import { config } from "./config.js";
import { InvalidMintResponseError, type MintAttempt, type MintTransaction, tryBuildMintTransaction } from "./opensea.js";

export interface PollResult {
    transaction: MintTransaction;
    attempt: number;
    hotPollingStartedAt: Date;
    successAt: Date;
    responseLatencyMs: number;
}

export class PollingStoppedError extends Error {
    constructor() {
        super("Mint polling stopped");
        this.name = "PollingStoppedError";
    }
}

const sleep = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(new PollingStoppedError());
        const timer = setTimeout(resolve, Math.max(0, ms));
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(new PollingStoppedError());
            },
            { once: true },
        );
    });

function timestamp(date = new Date()): string {
    return date.toISOString();
}

function retryMessage(attempt: number, result: Extract<MintAttempt, { kind: "retry" }>): string {
    if (result.status === 409) return `[WARN] Attempt #${attempt} - HTTP 409 - drop inactive`;
    if (result.status === 422) return `[WARN] Attempt #${attempt} - HTTP 422 - mint precondition failed`;
    if (result.status === 429) return `[RATE_LIMIT] Attempt #${attempt} - HTTP 429`;
    return `[WAIT] Attempt #${attempt} - HTTP ${result.status}`;
}

export async function waitForHotWindow(mintStart: Date | undefined, signal: AbortSignal): Promise<Date> {
    console.log(`Current UTC time: ${timestamp()}`);
    if (!mintStart || config.pollStartMode === "immediate") {
        console.log("Configured mint start: immediate");
        console.log("Hot polling starts: immediate");
        return new Date();
    }

    const hotStart = new Date(mintStart.getTime() - config.prestartBufferMs);
    console.log(`Configured mint start: ${timestamp(mintStart)}`);
    console.log(`Hot polling starts: ${timestamp(hotStart)}`);
    if (Date.now() < hotStart.getTime()) {
        console.log("[WAIT] Sleeping until hot polling window...");
        await sleep(hotStart.getTime() - Date.now(), signal);
    }
    return new Date();
}

export async function pollMintUntilAvailable(
    hotPollingStartedAt: Date,
    signal: AbortSignal,
    request: (signal: AbortSignal) => Promise<MintAttempt> = tryBuildMintTransaction,
): Promise<PollResult> {
    const startedMonotonic = performance.now();
    let attempt = 0;
    console.log(`[HOT] High-frequency polling started (interval: ${config.pollIntervalMs}ms, concurrency: 1)`);

    for (;;) {
        if (signal.aborted) throw new PollingStoppedError();
        if (config.pollTimeoutMs > 0 && performance.now() - startedMonotonic >= config.pollTimeoutMs) {
            throw new Error(`Polling timed out after ${config.pollTimeoutMs}ms`);
        }

        attempt += 1;
        const requestStarted = performance.now();
        console.log(`[HOT] Attempt #${attempt}`);
        let result: MintAttempt;
        try {
            result = await request(signal);
        } catch (error) {
            if (signal.aborted || error instanceof PollingStoppedError) throw new PollingStoppedError();
            if (error instanceof InvalidMintResponseError) throw error;
            const latency = performance.now() - requestStarted;
            console.log(`[WAIT] Attempt #${attempt} - request error: ${error instanceof Error ? error.message : "unknown"}`);
            await sleep(config.pollIntervalMs, signal);
            continue;
        }

        const latency = performance.now() - requestStarted;
        if (result.kind === "available") {
            const successAt = new Date();
            console.log("==================================================");
            console.log("[MINT AVAILABLE]");
            console.log("==================================================");
            console.log(`Timestamp: ${timestamp(successAt)}`);
            console.log(`Attempt: ${attempt}`);
            console.log(`Elapsed since hot polling start: ${Math.round(performance.now() - startedMonotonic)} ms`);
            console.log(`Response latency: ${Math.round(latency)} ms`);
            console.log(`Target: ${result.transaction.target}`);
            console.log(`Value: ${result.transaction.value}`);
            console.log("==================================================");
            return { transaction: result.transaction, attempt, hotPollingStartedAt, successAt, responseLatencyMs: latency };
        }
        if (result.kind === "permanent") {
            if (result.status === 422) console.log(`[WARN] Attempt #${attempt} - HTTP 422 - mint precondition failed`);
            throw new Error(`Mint endpoint returned permanent HTTP ${result.status} on attempt #${attempt}`);
        }

        console.log(retryMessage(attempt, result));
        const cooldown = result.status === 429 ? result.retryAfterMs ?? config.pollIntervalMs : config.pollIntervalMs;
        if (result.status === 429) console.log(`[RATE_LIMIT] Cooling down for ${cooldown}ms...`);
        else console.log(`[HOT] Retrying in ${cooldown}ms...`);
        await sleep(cooldown, signal);
        if (result.status === 429) console.log("[HOT] Resuming high-frequency polling");
    }
}
