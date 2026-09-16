import { formatEther, keccak256 } from "viem";

import { config, robinhood } from "./config.js";
import { getDropDetails, tryBuildMintTransaction, type MintTransaction } from "./opensea.js";
import { pollMintUntilAvailable, PollingStoppedError, waitForHotWindow } from "./poll.js";
import { account, publicClient, walletClient } from "./wallet.js";
import { loadState, saveState, type MintState } from "./state.js";

function publicStageStart(drop: Awaited<ReturnType<typeof getDropDetails>>): Date {
    if (drop.chain !== "robinhood") throw new Error(`Drop chain is ${drop.chain ?? "unknown"}, not robinhood`);
    const stage = drop.stages?.find((candidate) => candidate.stage_type === config.publicStageType);
    if (!stage?.start_time) throw new Error("Public stage start time is missing from OpenSea drop details");
    if (!stage.max_per_wallet || !/^\d+$/.test(stage.max_per_wallet)) {
        throw new Error("Public stage wallet limit is missing or invalid");
    }
    if (BigInt(stage.max_per_wallet) < BigInt(config.quantity)) {
        throw new Error(`Public stage wallet limit (${stage.max_per_wallet}) is below requested quantity (${config.quantity})`);
    }
    const start = new Date(stage.start_time);
    if (Number.isNaN(start.getTime())) throw new Error("Public stage start time is invalid");
    return start;
}

async function preflight(): Promise<Date> {
    const [chainId, balance, drop] = await Promise.all([
        publicClient.getChainId(),
        publicClient.getBalance({ address: account.address }),
        getDropDetails(),
    ]);
    if (chainId !== robinhood.id) throw new Error(`RPC returned chain ID ${chainId}, expected ${robinhood.id}`);
    if (balance === 0n) throw new Error("Mint wallet has no ETH for gas");
    return publicStageStart(drop);
}

async function reconcile(state: MintState): Promise<boolean> {
    if (state.status === "confirmed" || state.status === "reverted") {
        console.log(`A previous mint attempt is recorded as ${state.status}: ${state.hash}. No new mint will be submitted.`);
        return true;
    }
    try {
        const receipt = await publicClient.getTransactionReceipt({ hash: state.hash });
        console.log(`Existing transaction ${state.hash} is ${receipt.status}.`);
        await saveState({ ...state, status: receipt.status === "success" ? "confirmed" : "reverted" });
        return true;
    } catch {
        try {
            await publicClient.getTransaction({ hash: state.hash });
            console.log(`Existing transaction is pending: ${state.hash}. No new mint will be submitted.`);
            await publicClient.waitForTransactionReceipt({ hash: state.hash, timeout: 0 });
            return true;
        } catch {
            throw new Error(`Found unresolved signed transaction ${state.hash}. Inspect or explicitly rebroadcast that exact transaction; this bot will not create another mint.`);
        }
    }
}

async function signAndBroadcast(tx: MintTransaction, mintStart: Date | undefined, successfulResponseAt: Date): Promise<void> {
    const signStartedAt = new Date();
    const baseGasPrice = config.gasMode === "manual" ? config.manualGasPrice! : await publicClient.getGasPrice();
    const gasPrice =
        config.gasMode === "manual" ? baseGasPrice : (baseGasPrice * config.gasPriceMultiplierBps + 9_999n) / 10_000n;
    const gas = await publicClient.estimateGas({ account: account.address, to: tx.target, data: tx.calldata, value: tx.value });
    const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
    const request = await walletClient.prepareTransactionRequest({
        account,
        to: tx.target,
        data: tx.calldata,
        value: tx.value,
        nonce,
        gas,
        gasPrice,
        chain: robinhood,
    });
    // `prepareTransactionRequest` returns a discriminated transaction union that
    // `walletClient.signTransaction` preserves without widening its fee fields.
    const serializedTransaction = await walletClient.signTransaction(request);
    const hash = keccak256(serializedTransaction);
    await saveState({ version: 1, status: "signed", hash, serializedTransaction, nonce, createdAt: new Date().toISOString() });

    const returnedHash = await walletClient.sendRawTransaction({ serializedTransaction });
    if (returnedHash.toLowerCase() !== hash.toLowerCase()) throw new Error("RPC returned a hash different from the signed transaction");
    await saveState({ version: 1, status: "broadcast", hash, serializedTransaction, nonce, createdAt: new Date().toISOString() });
    const broadcastAt = new Date();
    console.log(`[BROADCAST] Tx hash: ${hash}`);
    console.log(`[PERFORMANCE] Mint start: ${mintStart?.toISOString() ?? "immediate"}`);
    console.log(`[PERFORMANCE] OpenSea transaction received: ${successfulResponseAt.toISOString()}`);
    console.log(`[PERFORMANCE] Signing started: ${signStartedAt.toISOString()}`);
    console.log(`[PERFORMANCE] Broadcast: ${broadcastAt.toISOString()}`);
    console.log(`[GAS] Mode: ${config.gasMode}; gas limit: ${gas}; gas price: ${gasPrice} wei`);
    if (mintStart) console.log(`[PERFORMANCE] Mint start -> OpenSea response: ${successfulResponseAt.getTime() - mintStart.getTime()} ms`);
    console.log(`[PERFORMANCE] OpenSea response -> broadcast: ${broadcastAt.getTime() - successfulResponseAt.getTime()} ms`);

    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
    const confirmationAt = new Date();
    await saveState({
        version: 1,
        status: receipt.status === "success" ? "confirmed" : "reverted",
        hash,
        serializedTransaction,
        nonce,
        createdAt: new Date().toISOString(),
    });
    const gasFee = receipt.gasUsed * receipt.effectiveGasPrice;
    console.log("==================================================");
    console.log(receipt.status === "success" ? "[MINT SUCCESS]" : "[MINT REVERTED]");
    console.log("==================================================");
    console.log(`Tx hash: ${hash}`);
    console.log(`Block: ${receipt.blockNumber}`);
    console.log(`Gas used: ${receipt.gasUsed}`);
    console.log(`Effective gas price: ${receipt.effectiveGasPrice} wei`);
    console.log(`Gas fee: ${formatEther(gasFee)} ETH`);
    console.log(`Mint value: ${formatEther(tx.value)} ETH`);
    console.log(`Total cost: ${formatEther(gasFee + tx.value)} ETH`);
    console.log(`Confirmation: ${confirmationAt.toISOString()}`);
    console.log("==================================================");
}

export async function mint(options: { dryRun: boolean; probeMintApi: boolean }): Promise<void> {
    if (options.probeMintApi) {
        const result = await tryBuildMintTransaction();
        if (result.kind === "available") {
            console.log(`Mint API probe succeeded. Target: ${result.transaction.target}; value: ${result.transaction.value}`);
            return;
        }
        if (result.kind === "retry") {
            throw new Error(`Mint API probe returned retryable HTTP ${result.status}`);
        }
        throw new Error(`Mint API probe returned HTTP ${result.status}`);
    }

    if (!options.dryRun) {
        const existing = await loadState();
        if (existing) {
            await reconcile(existing);
            return;
        }
    }

    const dropStart = await preflight();
    const mintStart = config.pollStartMode === "immediate" ? undefined : config.mintStartTime ?? dropStart;
    console.log(`Wallet: ${account.address}`);
    console.log(`Public stage begins: ${dropStart.toISOString()}`);
    console.log(`Drop slug: ${config.dropSlug}`);

    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
        const hotStartedAt = await waitForHotWindow(mintStart, controller.signal);
        const result = await pollMintUntilAvailable(hotStartedAt, controller.signal);
        if (options.dryRun) {
            console.log("Dry run complete. No transaction was signed or broadcast.");
            return;
        }
        await signAndBroadcast(result.transaction, mintStart, result.successAt);
    } catch (error) {
        if (error instanceof PollingStoppedError) {
            console.log("[STOPPED] Mint polling stopped without signing or broadcasting a transaction.");
            return;
        }
        throw error;
    } finally {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
    }
}
