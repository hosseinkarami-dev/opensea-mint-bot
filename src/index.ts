import { mint } from "./mint.js";

async function main() {
    const dryRun = process.argv.includes("--dry-run");
    const probeMintApi = process.argv.includes("--probe-mint-api");
    if (probeMintApi && !dryRun) throw new Error("--probe-mint-api requires --dry-run");
    await mint({ dryRun, probeMintApi });
}

main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown bot error";
    console.error(`BOT ERROR: ${message}`);
    process.exitCode = 1;
});
