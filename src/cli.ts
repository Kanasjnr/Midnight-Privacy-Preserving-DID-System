import "dotenv/config";
import * as Rx from "rxjs";
import { HDWallet, Roles } from "@midnight-ntwrk/wallet-sdk-hd";
import {
  UnshieldedWallet,
  createKeystore,
  PublicKey,
  InMemoryTransactionHistoryStorage,
} from "@midnight-ntwrk/wallet-sdk-unshielded-wallet";
import { DustWallet } from "@midnight-ntwrk/wallet-sdk-dust-wallet";
import { ShieldedWallet } from "@midnight-ntwrk/wallet-sdk-shielded";
import { WalletFacade, FacadeState } from "@midnight-ntwrk/wallet-sdk-facade";
import {
  ZswapSecretKeys,
  DustSecretKey,
  LedgerParameters
} from "@midnight-ntwrk/ledger-v8";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { WebSocket } from "ws";
import chalk from "chalk";
import Enquirer from "enquirer";
import { EnvironmentManager } from "./utils/environment.js";
import { DIDManager } from "./dids/did-manager.js";

// SHIM: Global shim for all contracts loaded via dynamic import
// This ensures that any Contract class from managed/ has the provableCircuits property
export const applyContractShim = (ContractClass: any) => {
  if (ContractClass.prototype && !ContractClass.prototype.provableCircuits) {
    Object.defineProperty(ContractClass.prototype, 'provableCircuits', {
      get() { return this.circuits; },
      configurable: true
    });
  }
};

// --- POLYFILLS ---
const polyfillIterator = (proto: any) => {
  if (proto && !proto.map) proto.map = function(fn: any) { return Array.from(this).map(fn); };
  if (proto && !proto.toArray) proto.toArray = function() { return Array.from(this); };
};
polyfillIterator(Object.getPrototypeOf(new Map().values()));
polyfillIterator(Object.getPrototypeOf(new Set().values()));
polyfillIterator(Object.getPrototypeOf([].values()));
// --- END POLYFILLS ---

// @ts-ignore
globalThis.WebSocket = WebSocket;
setNetworkId("preview");

async function fetchLedgerParameters(indexerUrl: string): Promise<LedgerParameters> {
  const response = await fetch(indexerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `query { block { ledgerParameters } }`
    }),
  });
  const result = (await response.json()) as any;
  const hex = result.data.block.ledgerParameters;
  return LedgerParameters.deserialize(Buffer.from(hex, "hex"));
}

async function main() {
  console.log(chalk.blue.bold("\n━".repeat(60)));
  console.log(chalk.blue.bold("🌙  Midnight Privacy-Preserving DID System"));
  console.log(chalk.blue.bold("━".repeat(60) + "\n"));

  try {
    EnvironmentManager.validateEnvironment();
    const networkConfig = EnvironmentManager.getNetworkConfig();
    const walletSeed = process.env.WALLET_SEED!;
    const seed = Uint8Array.from(Buffer.from(walletSeed, "hex"));

    console.log(chalk.cyan("🏗️  Initializing Wallet..."));
    const hdWalletResult = HDWallet.fromSeed(seed);
    if (hdWalletResult.type === "seedError") throw new Error(String((hdWalletResult as any).error));
    const account = hdWalletResult.hdWallet.selectAccount(0);

    const unshieldedKeyResult = account.selectRole(Roles.NightExternal).deriveKeyAt(0);
    const keystore = createKeystore((unshieldedKeyResult as any).key, "preview");
    const publicKeyObj = PublicKey.fromKeyStore(keystore);

    const dustKeyResult = account.selectRole(Roles.Dust).deriveKeyAt(0);
    const dustSecretKey = DustSecretKey.fromSeed((dustKeyResult as any).key);

    const zswapKeyResult = account.selectRole(Roles.Zswap).deriveKeyAt(0);
    const shieldedSecretKeys = ZswapSecretKeys.fromSeed((zswapKeyResult as any).key);

    console.log(chalk.cyan("📡 Fetching LedgerParameters from indexer..."));
    const ledgerParams = await fetchLedgerParameters(networkConfig.indexer);

    const wallet = await WalletFacade.init({
      configuration: {
        networkId: "preview" as any,
        indexerClientConnection: { indexerHttpUrl: networkConfig.indexer, indexerWsUrl: networkConfig.indexerWS },
        relayURL: new URL(networkConfig.node),
        provingServerUrl: new URL(networkConfig.proofServer),
        txHistoryStorage: new InMemoryTransactionHistoryStorage(),
        costParameters: { additionalFeeOverhead: 0n, feeBlocksMargin: 5 },
      },
      shielded: (config) => ShieldedWallet(config).startWithSecretKeys(shieldedSecretKeys),
      unshielded: (config) => UnshieldedWallet({ ...config, txHistoryStorage: new InMemoryTransactionHistoryStorage() }).startWithPublicKey(publicKeyObj),
      dust: (config) => DustWallet(config).startWithSecretKey(dustSecretKey, ledgerParams.dust),
    });

    console.log(chalk.cyan("🔄 Synchronizing with Midnight Network..."));
    await wallet.start(shieldedSecretKeys, dustSecretKey);

    const state = await Rx.firstValueFrom(
      wallet.state().pipe(
        Rx.tap((s: any) => {
          const progress = s.unshielded.state.progress;
          const appliedId = progress.appliedId;
          const targetId = progress.highestTransactionId;
          process.stdout.write(`\r[SYNC] AppliedId: ${appliedId} / ${targetId} | isSynced: ${s.isSynced}   `);
        }),
        Rx.filter((s: any) => s.isSynced || (s.unshielded.state.progress.appliedId >= 1367n && s.unshielded.state.progress.appliedId !== 0n)),
        Rx.take(1)
      )
    ) as FacadeState;
    console.log(chalk.green("\n✅ Wallet Synced!"));
    console.log(chalk.white(`   Address: ${state.shielded.address}\n`));

    const didManager = new DIDManager(wallet, networkConfig, state.shielded.encryptionPublicKey as any, shieldedSecretKeys, dustSecretKey, keystore, walletSeed);

    while (true) {
      const response = await Enquirer.prompt({
        type: "select",
        name: "action",
        message: "Select an action:",
        choices: [
          "Register DID",
          "Update DID Document",
          "Issue Credential (DOB)",
          "Verify Age (Zero-Knowledge Proof)",
          "Exit",
        ],
      }) as any;

      try {
        if (response.action === "Register DID") {
          const { name } = await Enquirer.prompt({ type: "input", name: "name", message: "Enter DID name (e.g., alice.id):" }) as any;
          await didManager.registerDID(name);
        } else if (response.action === "Update DID Document") {
          const { name, doc } = await Enquirer.prompt([
            { type: "input", name: "name", message: "Enter DID name:" },
            { type: "input", name: "doc", message: "Enter new Document Content:" },
          ]) as any;
          await didManager.updateDID(name, doc);
        } else if (response.action === "Issue Credential (DOB)") {
          const { name, dob } = await Enquirer.prompt([
            { type: "input", name: "name", message: "Enter Holder DID name:" },
            { type: "input", name: "dob", message: "Enter Year of Birth (YYYYMMDD):", validate: (v: string) => /^\d{8}$/.test(v) },
          ]) as any;
          await didManager.issueCredential(name, parseInt(dob));
        } else if (response.action === "Verify Age (Zero-Knowledge Proof)") {
          const { dob, threshold } = await Enquirer.prompt([
            { type: "input", name: "dob", message: "Enter your Year of Birth (YYYYMMDD):" },
            { type: "input", name: "threshold", message: "Enter Age Threshold (YYYYMMDD, e.g., 20060000 for 18+):" },
          ]) as any;
          await didManager.verifyAge(parseInt(dob), parseInt(threshold));
        } else if (response.action === "Exit") {
          break;
        }
      } catch (err: any) {
        console.error(chalk.red(`\n❌ Action Failed: ${err.message}\n`));
      }
    }

    await wallet.stop();
    process.exit(0);
  } catch (error: any) {
    console.error(chalk.red("\n❌ Fatal Error:"));
    console.error(chalk.red(error.stack || error.message));
    process.exit(1);
  }
}

main();
