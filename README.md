# OpenSea Mint Bot

A lightweight TypeScript/Node.js bot for interacting with OpenSea Drop mint endpoints.

The bot polls an OpenSea Drop until minting becomes available, receives the transaction payload from OpenSea, signs it locally with the configured wallet, and broadcasts the transaction directly to the target EVM network.

## Features

* OpenSea Drops API integration
* Automated mint polling
* Configurable polling interval
* Handles OpenSea `409`, `422`, and `429` responses
* Uses the transaction data returned by OpenSea
* Local transaction signing with `viem`
* Configurable gas strategy
* Supports scheduled or immediate polling
* Dry-run / API probe mode
* Transaction receipt tracking
* Persistent mint state to help prevent accidental duplicate submissions
* TypeScript with strict type checking
* Environment-based configuration

## Requirements

* Node.js 22+
* npm
* An OpenSea API key
* An EVM-compatible wallet
* An RPC endpoint for the target network
* Sufficient native-token balance for minting and transaction fees

## Installation

Clone the repository:

```bash
git clone https://github.com/hosseinkarami-dev/opensea-mint-bot.git
cd opensea-mint-bot
```

Install dependencies:

```bash
npm install
```

Build the project:

```bash
npm run build
```

## Configuration

Create a `.env` file in the project root:

```env
OPENSEA_API_KEY=your_opensea_api_key
PRIVATE_KEY=your_wallet_private_key
WALLET_ADDRESS=0xYourWalletAddress

RH_RPC_URL=https://your-rpc-endpoint

DROP_SLUG=your-drop-slug
QUANTITY=1

MINT_START_TIME=2026-09-17T14:00:00.000Z
POLL_START_MODE=scheduled
PRESTART_BUFFER_MS=5000

POLL_INTERVAL_MS=100
POLL_CONCURRENCY=1
POLL_TIMEOUT_MS=0

GAS_MODE=auto
GAS_PRICE_GWEI=
GAS_PRICE_MULTIPLIER=1.2
GAS_LIMIT_MULTIPLIER=1.10
```

The exact environment variables depend on the current configuration implementation. Do not commit `.env` to Git.

## Usage

### Build

```bash
npm run build
```

### Start the bot

```bash
npm start
```

The production build will start polling according to the configured schedule.

### Development mode

```bash
npm run dev
```

### Dry run

```bash
npm run dry-run
```

Dry-run mode does not sign or broadcast a blockchain transaction.

### OpenSea API probe

```bash
npm run probe
```

The probe mode calls the OpenSea mint endpoint immediately and is useful for testing the API integration and verifying the returned transaction payload without broadcasting a transaction.

## Mint Flow

The bot follows this general flow:

```text
Load configuration
       │
       ▼
Validate wallet and RPC
       │
       ▼
Wait for configured start time
       │
       ▼
Poll OpenSea mint endpoint
       │
       ├── 409 → retry
       ├── 422 → retry
       ├── 429 → respect Retry-After
       │
       ▼
OpenSea returns transaction
       │
       ▼
Validate transaction payload
       │
       ▼
Estimate/configure gas
       │
       ▼
Sign transaction locally
       │
       ▼
Broadcast transaction
       │
       ▼
Wait for receipt
       │
       ▼
Save successful mint state
```

The transaction target, calldata, and value are taken from OpenSea's mint response rather than being constructed manually by the bot.

## HTTP Response Handling

The bot treats common OpenSea responses differently:

| Status | Meaning                    | Bot behavior       |
| ------ | -------------------------- | ------------------ |
| `200`  | Mint transaction available | Sign and broadcast |
| `      |                            |                    |
