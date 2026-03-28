# Midnight Privacy-Preserving DID System

A decentralized identity system built on the Midnight Network, leveraging zero-knowledge proofs to provide privacy-preserving verifiable credentials and identity management.

## Project Overview

This system allows users to:

- **Register DIDs**: Create and manage decentralized identifiers on the Midnight ledger.
- **Issue Credentials**: Authorized issuers can issue verifiable credentials (e.g., age verification) to holders.
- **Privacy-Preserving Verification**: Holders can prove specific claims (like being over 18) using zero-knowledge witnesses without disclosing their actual date of birth or other private data.

## Privacy Features

This project demonstrates Midnight's core privacy capabilities:

- **Witnesses**: Used in `proof-verifier.compact` to prove age requirements without disclosing the underlying `dateOfBirth` or `salt`.
- **State Commitments**: DIDs and credentials are represented as commitments on the public ledger, keeping sensitive identity data off-chain while maintaining verifiable integrity.
- **Private State**: Integrated with the Midnight SDK to manage holder secrets and private credential data.

## Getting Started

### Prerequisites

- **Node.js**: Version 18 or higher.
- **Docker**: Required for running the local Midnight proof server.
- **Midnight Compact**: Ensure the Compact compiler is installed.

### Setup

1. **Install Dependencies**:

   ```bash
   npm install
   ```

2. **Configure Environment**:
   Copy `.env.example` to `.env` and provide your configuration:

   ```bash
   cp .env.example .env
   ```

   _Note: `npm run setup` will help generate a wallet seed if one is not provided._

3. **Compile, Build, and Deploy**:
   ```bash
   npm run setup
   ```
   This command sequentially:
   - Compiles the Compact contracts (`contracts/*.compact`)
   - Builds the TypeScript source into the `dist/` directory
   - Deploys the contracts to the Midnight network

### Manual Compilation and Building

If you wish to run steps individually:

- **Compile Contracts**: `npm run compile`
- **Build TypeScript**: `npm run build`
- **Deploy**: `npm run deploy`

### Usage

1. **Interactive CLI**:

   ```bash
   npm run cli
   ```

   Use the CLI to register DIDs, issue credentials, and run privacy-preserving proofs.

2. **Check Balance**:
   ```bash
   npm run check-balance
   ```

## Project Structure

- `contracts/`: Midnight Compact smart contracts.
  - `did-registry.compact`: Manages DID registration and state roots.
  - `credential-issuer.compact`: Handles the issuance and revocation of credentials.
  - `proof-verifier.compact`: Contains ZK circuits for private credential verification (e.g., `verifyAge`).
- `src/`: TypeScript application logic using the Midnight SDK.
  - `dids/`: DID generation and management logic.
  - `providers/`: Midnight network and wallet providers.
  - `cli.ts`: Main entry point for the interactive user experience.

## Verification

To verify the installation, ensure all contracts compile correctly:

```bash
npm run compile
```

And check that the build succeeds:

```bash
npm run build
```

---

Built with 🌙 Midnight Network.


Midnight preview faucet
This faucet dispenses a small amount of test tokens called tNight. tNight is intended for testing purposes on Midnight's preview only.

