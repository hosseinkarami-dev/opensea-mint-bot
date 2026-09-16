import { readFile, rename, writeFile } from "node:fs/promises";

import { config } from "./config.js";

export interface MintState {
    version: 1;
    status: "signed" | "broadcast" | "confirmed" | "reverted";
    hash: `0x${string}`;
    serializedTransaction: `0x${string}`;
    nonce: number;
    createdAt: string;
}

export async function loadState(): Promise<MintState | undefined> {
    try {
        const state = JSON.parse(await readFile(config.stateFile, "utf8")) as MintState;
        if (state.version !== 1 || !state.hash || !state.serializedTransaction) throw new Error("invalid state");
        return state;
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw new Error("Mint state file is invalid; refusing to risk a duplicate mint");
    }
}

export async function saveState(state: MintState): Promise<void> {
    const temporary = `${config.stateFile}.tmp`;
    await writeFile(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, config.stateFile);
}
