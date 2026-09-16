import dotenv from "dotenv";
import { defineChain, getAddress, isAddress, parseGwei } from "viem";

dotenv.config({ quiet: true });

function required(name: string): string {
    const value = process.env[name]?.trim();

    if (!value) {
        throw new Error(`Missing environment variable: ${name}`);
    }

    return value;
}

function address(name: string, fallback?: string): `0x${string}` {
    const value = process.env[name]?.trim() || fallback;

    if (!value || !isAddress(value)) {
        throw new Error(`Invalid Ethereum address in ${name}`);
    }

    return getAddress(value);
}

function quantity(): 1 {
    const value = required("QUANTITY");

    if (value !== "1") {
        throw new Error("QUANTITY must be exactly 1");
    }

    return 1;
}

function nonNegativeInteger(name: string, fallback: number): number {
    const value = process.env[name]?.trim();
    if (!value) return fallback;
    if (!/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative integer`);
    return Number(value);
}

function positiveInteger(name: string, fallback: number): number {
    const value = nonNegativeInteger(name, fallback);
    if (value < 1) throw new Error(`${name} must be at least 1`);
    return value;
}

function optionalIsoTime(name: string): Date | undefined {
    const value = process.env[name]?.trim();
    if (!value) return undefined;
    if (!/(Z|[+-]\d\d:\d\d)$/i.test(value)) throw new Error(`${name} must use an explicit UTC offset, such as Z`);
    const time = new Date(value);
    if (Number.isNaN(time.getTime())) throw new Error(`${name} must be a valid ISO-8601 timestamp`);
    return time;
}

function gasMultiplierBps(): bigint {
    const value = process.env.GAS_PRICE_MULTIPLIER?.trim() || "1.2";
    if (!/^\d+(?:\.\d{1,4})?$/.test(value)) throw new Error("GAS_PRICE_MULTIPLIER must be a positive decimal with at most four decimals");
    const parts = value.split(".");
    const whole = parts[0] ?? "0";
    const fraction = parts[1] ?? "";
    const bps = BigInt(whole) * 10_000n + BigInt((fraction + "0000").slice(0, 4));
    if (bps < 10_000n) throw new Error("GAS_PRICE_MULTIPLIER must be at least 1");
    return bps;
}

const privateKey = required("PRIVATE_KEY");
if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("PRIVATE_KEY must be a 32-byte 0x-prefixed hex value");
}

const rpcUrl = required("RH_RPC_URL");
try {
    const parsed = new URL(rpcUrl);
    if (parsed.protocol !== "https:") {
        throw new Error();
    }
} catch {
    throw new Error("RH_RPC_URL must be a valid HTTPS URL");
}

export const robinhood = defineChain({
    id: 4663,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    blockTime: 1_000,
});

export const config = {
    openSeaApiKey: required("OPENSEA_API_KEY"),
    privateKey: privateKey as `0x${string}`,
    walletAddress: address("WALLET_ADDRESS"),
    rpcUrl,
    dropSlug: required("DROP_SLUG"),
    quantity: quantity(),
    publicStageType: "public_sale",
    stateFile: process.env.MINT_STATE_FILE?.trim() || ".mint-state.json",
    pollStartMode: process.env.POLL_START_MODE?.trim() || "scheduled",
    mintStartTime: optionalIsoTime("MINT_START_TIME"),
    prestartBufferMs: nonNegativeInteger("PRESTART_BUFFER_MS", 5_000),
    pollIntervalMs: positiveInteger("POLL_INTERVAL_MS", 100),
    // Polling remains sequential by default; a higher setting is intentionally
    // rejected until a bounded concurrent scheduler is implemented.
    pollConcurrency: positiveInteger("POLL_CONCURRENCY", 1),
    pollTimeoutMs: nonNegativeInteger("POLL_TIMEOUT_MS", 0),
    gasMode: process.env.GAS_MODE?.trim() || "auto",
    gasPriceMultiplierBps: gasMultiplierBps(),
    manualGasPrice: process.env.GAS_PRICE_GWEI?.trim() ? parseGwei(process.env.GAS_PRICE_GWEI.trim()) : undefined,
};

if (config.pollStartMode !== "scheduled" && config.pollStartMode !== "immediate") {
    throw new Error("POLL_START_MODE must be scheduled or immediate");
}
if (config.pollConcurrency !== 1) {
    throw new Error("POLL_CONCURRENCY currently supports only 1 to prevent overlapping mint requests");
}
if (config.gasMode !== "auto" && config.gasMode !== "manual") {
    throw new Error("GAS_MODE must be auto or manual");
}
if (config.gasMode === "manual" && !config.manualGasPrice) {
    throw new Error("GAS_PRICE_GWEI is required when GAS_MODE=manual");
}
