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
import { setNetworkId, getNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { WebSocket } from "ws";
import chalk from "chalk";
import Enquirer from "enquirer";
import { Buffer } from "buffer";
import { EnvironmentManager } from "./utils/environment.js";
import { DIDManager } from "./dids/did-manager.js";

// --- COMPREHENSIVE ITERATOR POLYFILLS ---
const polyfillIterator = (proto: any) => {
  if (!proto) return;
  const methods = ['map', 'filter', 'every', 'some', 'find', 'reduce', 'forEach', 'toArray'];
  for (const method of methods) {
    if (!proto[method]) {
      proto[method] = function (this: any, ...args: any[]) {
        const arr = Array.from(this);
        if (method === 'toArray') return arr;
        return (arr[method as any] as any)(...args);
      };
    }
  }
};

polyfillIterator(Object.getPrototypeOf(new Map().values()));
polyfillIterator(Object.getPrototypeOf(new Map().entries()));
polyfillIterator(Object.getPrototypeOf(new Map().keys()));
polyfillIterator(Object.getPrototypeOf(new Set().values()));
polyfillIterator(Object.getPrototypeOf([].values()));

if (!(Array.prototype as any).toArray) {
  Object.defineProperty(Array.prototype, 'toArray', {
    value: function () { return this; },
    enumerable: false,
    configurable: true
  });
}

// @ts-ignore
globalThis.WebSocket = WebSocket;

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
  console.log(chalk.blue.bold("━".repeat(60)));
  console.log(chalk.blue.bold("🌙  Midnight Privacy-Preserving DID System"));
  console.log(chalk.blue.bold("━".repeat(60) + "\n"));

  try {
    EnvironmentManager.validateEnvironment();
    const networkConfig = EnvironmentManager.getNetworkConfig();
    const networkId = networkConfig.name.toLowerCase() as any;
    setNetworkId(networkId);
    
    const walletSeed = process.env.WALLET_SEED!;
    console.log(chalk.cyan("🏗️  Initializing Wallet..."));
    
    const hdWallet = HDWallet.fromSeed(Buffer.from(walletSeed, "hex"));
    if (hdWallet.type !== "seedOk") throw new Error("Invalid seed");
    const keys = hdWallet.hdWallet
      .selectAccount(0)
      .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
      .deriveKeysAt(0);
    if (keys.type !== "keysDerived") throw new Error("Key derivation failed");
    
    const unshieldedKeystore = createKeystore(keys.keys[Roles.NightExternal], networkId);
    const publicKeyObj = PublicKey.fromKeyStore(unshieldedKeystore);
    const dustSecretKey = DustSecretKey.fromSeed(keys.keys[Roles.Dust]);
    const shieldedSecretKeys = ZswapSecretKeys.fromSeed(keys.keys[Roles.Zswap]);

    console.log(chalk.cyan("📡 Fetching LedgerParameters from indexer..."));
    const ledgerParams = await fetchLedgerParameters(networkConfig.indexer);

    const wallet = await WalletFacade.init({
      configuration: {
        networkId,
        indexerClientConnection: { 
          indexerHttpUrl: networkConfig.indexer, 
          indexerWsUrl: networkConfig.indexerWS 
        },
        relayURL: new URL(networkConfig.node.replace(/^http/, "ws")),
        provingServerUrl: new URL(networkConfig.proofServer),
        txHistoryStorage: new InMemoryTransactionHistoryStorage(),
        costParameters: { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 },
      },
      shielded: (config) => ShieldedWallet(config).startWithSecretKeys(shieldedSecretKeys),
      unshielded: (config) => UnshieldedWallet({ ...config, txHistoryStorage: new InMemoryTransactionHistoryStorage() }).startWithPublicKey(publicKeyObj),
      dust: (config) => DustWallet(config).startWithSecretKey(dustSecretKey, ledgerParams.dust),
    });

    console.log(chalk.cyan("🔄 Synchronizing with Midnight Network..."));
    await wallet.start(shieldedSecretKeys, dustSecretKey);

    const state = await Rx.firstValueFrom(
      wallet.state().pipe(
        Rx.throttleTime(1000),
        Rx.tap((s: any) => {
          process.stdout.write(`\r🔄 Synchronizing wallet... [${s.isSynced ? 'DONE' : 'Loading'}]   `);
        }),
        Rx.filter((s: any) => s.isSynced),
        Rx.take(1)
      )
    ) as FacadeState;
    console.log(chalk.green("\n✅ Wallet Synced!"));
    console.log(chalk.white(`   Address: ${state.shielded.address}\n`));

    const didManager = new DIDManager(wallet, networkConfig, state.shielded.encryptionPublicKey as any, shieldedSecretKeys, dustSecretKey, unshieldedKeystore, walletSeed);

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
          const { name } = await Enquirer.prompt({ type: "input", name: "name", message: "Enter DID name (e.g., alice.night):" }) as any;
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
          const { id, dob, threshold } = await Enquirer.prompt([
            { type: "input", name: "id", message: "Enter DID name (e.g., alice.night):" },
            { type: "input", name: "dob", message: "Enter your Year of Birth (YYYYMMDD):", validate: (v: string) => /^\d{8}$/.test(v) },
            { type: "input", name: "threshold", message: "Enter Age Threshold (in years, e.g., 18):", validate: (v: string) => /^\d+$/.test(v) },
          ]) as any;
          await didManager.verifyAge(id, parseInt(dob), parseInt(threshold));
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
