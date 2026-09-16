import { getAddress, isAddress, isHex } from "viem";

import { config } from "./config.js";

const BASE_URL = "https://api.opensea.io/api/v2";
const REQUEST_TIMEOUT_MS = 5_000;

export interface MintTransaction {
    target: `0x${string}`;
    calldata: `0x${string}`;
    value: bigint;
}

export type MintAttempt =
    | { kind: "available"; transaction: MintTransaction }
    | { kind: "retry"; status: number; retryAfterMs?: number }
    | { kind: "permanent"; status: number };

export interface DropStage {
    stage_type?: string;
    label?: string;
    start_time?: string;
    end_time?: string;
    price?: string;
    max_per_wallet?: string;
}

export interface DropDetails {
    chain?: string;
    contract_address?: string;
    active_stage?: DropStage | null;
    next_stage?: DropStage | null;
    stages?: DropStage[];
}

export class OpenSeaError extends Error {
    constructor(
        readonly status: number,
        readonly retryAfterMs?: number,
    ) {
        super(`OpenSea API request failed with HTTP ${status}`);
        this.name = "OpenSeaError";
    }
}

export class InvalidMintResponseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "InvalidMintResponseError";
    }
}

function retryAfterMs(value: string | null): number | undefined {
    if (!value) return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
    const date = Date.parse(value);
    return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

async function requestJson(path: string, init: RequestInit): Promise<unknown> {
    const response = await fetch(`${BASE_URL}${path}`, {
        ...init,
        headers: {
            "x-api-key": config.openSeaApiKey,
            Accept: "application/json",
            ...init.headers,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const body = await response.text();
    if (!response.ok) {
        throw new OpenSeaError(response.status, retryAfterMs(response.headers.get("retry-after")));
    }

    try {
        return JSON.parse(body) as unknown;
    } catch {
        throw new Error("OpenSea returned malformed JSON");
    }
}

function object(value: unknown, message: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(message);
    }
    return value as Record<string, unknown>;
}

export async function getDropDetails(): Promise<DropDetails> {
    const json = object(
        await requestJson(`/drops/${encodeURIComponent(config.dropSlug)}`, { method: "GET" }),
        "Unexpected OpenSea drop-details response",
    );
    return json as DropDetails;
}

function mintTransaction(json: Record<string, unknown>): MintTransaction {

    // OpenSea's current mint endpoint returns Ethereum transaction fields using
    // their JSON-RPC names (`to` and `data`). Keep the internal names explicit.
    const target = json.to;
    const calldata = json.data;
    const value = json.value;

    if (typeof target !== "string" || !isAddress(target)) {
        throw new Error("OpenSea mint response contains an invalid to address");
    }
    if (typeof calldata !== "string" || !isHex(calldata)) {
        throw new Error("OpenSea mint response contains invalid transaction data");
    }
    if (typeof value !== "string" || !/^\d+$/.test(value)) {
        throw new Error("OpenSea mint response contains an invalid value");
    }

    return { target: getAddress(target), calldata, value: BigInt(value) };
}

export async function tryBuildMintTransaction(signal?: AbortSignal): Promise<MintAttempt> {
    const response = await fetch(`${BASE_URL}/drops/${encodeURIComponent(config.dropSlug)}/mint`, {
        method: "POST",
        headers: {
            "x-api-key": config.openSeaApiKey,
            Accept: "application/json",
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ minter: config.walletAddress, quantity: config.quantity }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const body = await response.text();
    if (response.ok) {
        try {
            return { kind: "available", transaction: mintTransaction(object(body ? JSON.parse(body) : undefined, "Unexpected OpenSea mint response")) };
        } catch (error) {
            throw new InvalidMintResponseError(error instanceof Error ? error.message : "OpenSea mint response is invalid");
        }
    }

    const retryAfter = retryAfterMs(response.headers.get("retry-after"));
    // These responses mean the mint is not available yet or the service is
    // temporarily unable to serve it. The real bot must keep polling for all
    // of them, including wallet-eligibility (422) and drop-inactive (409).
    if (response.status === 409 || response.status === 422 || response.status === 429 || response.status >= 500) {
        return retryAfter === undefined
            ? { kind: "retry", status: response.status }
            : { kind: "retry", status: response.status, retryAfterMs: retryAfter };
    }
    return { kind: "permanent", status: response.status };
}

export async function buildMintTransaction(): Promise<MintTransaction> {
    const result = await tryBuildMintTransaction();
    if (result.kind === "available") return result.transaction;
    throw new OpenSeaError(result.status, result.kind === "retry" ? result.retryAfterMs : undefined);
}
