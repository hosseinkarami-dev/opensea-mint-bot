import { createPublicClient, createWalletClient, http, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { config, robinhood } from "./config.js";

const account = privateKeyToAccount(config.privateKey);

if (getAddress(account.address) !== config.walletAddress) {
    throw new Error("PRIVATE_KEY does not derive WALLET_ADDRESS");
}

const transport = http(config.rpcUrl, { retryCount: 1, timeout: 10_000 });

export const publicClient = createPublicClient({
    chain: robinhood,
    transport,
    pollingInterval: 1_000,
});

export const walletClient = createWalletClient({
    account,
    chain: robinhood,
    transport,
});

export { account };
