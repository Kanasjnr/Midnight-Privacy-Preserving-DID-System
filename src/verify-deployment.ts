import "dotenv/config";
import * as Rx from "rxjs";
import { HDWallet, Roles } from "@midnight-ntwrk/wallet-sdk-hd";
import {
  UnshieldedWallet,
  createKeystore,
  PublicKey,
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
import { Buffer } from "buffer";
import { EnvironmentManager } from "./utils/environment.js";
import { DIDManager } from "./dids/did-manager.js";
import { getPersistentStorage } from "./utils/storage.js";

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
  const maxRetries = 3;
  let lastError: any;
  for (let i = 0; i < maxRetries; i++) {
    try {
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
    } catch (error) {
      lastError = error;
      console.log(chalk.yellow(`\n⚠️ Fetch failed (attempt ${i + 1}/${maxRetries}). Retrying in 2s...`));
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  throw lastError;
}

async function main() {
  console.log(chalk.blue.bold("━".repeat(60)));
  console.log(chalk.blue.bold("🌙  Midnight DID System Verification"));
  console.log(chalk.blue.bold("━".repeat(60) + "\n"));

  try {
    EnvironmentManager.validateEnvironment();
    const networkConfig = EnvironmentManager.getNetworkConfig();
    const networkId = networkConfig.name.toLowerCase() as any;
    setNetworkId(networkId);
    
    const walletSeed = process.env.WALLET_SEED!;
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

    const ledgerParams = await fetchLedgerParameters(networkConfig.indexer);

    const storage = getPersistentStorage("verify");

    const wallet = await WalletFacade.init({
      configuration: {
        networkId,
        indexerClientConnection: { 
          indexerHttpUrl: networkConfig.indexer, 
          indexerWsUrl: networkConfig.indexerWS 
        },
        relayURL: new URL(networkConfig.node.replace(/^http/, "ws")),
        provingServerUrl: new URL(networkConfig.proofServer),
        txHistoryStorage: storage,
        costParameters: { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 },
      },
      shielded: (config) => ShieldedWallet(config).startWithSecretKeys(shieldedSecretKeys),
      unshielded: (config) => UnshieldedWallet({ ...config, txHistoryStorage: storage }).startWithPublicKey(publicKeyObj),
      dust: (config) => DustWallet(config).startWithSecretKey(dustSecretKey, ledgerParams.dust),
    });

    console.log(chalk.cyan("🔄 Synchronizing wallet..."));
    await wallet.start(shieldedSecretKeys, dustSecretKey);

    const state = await Rx.firstValueFrom(
      wallet.state().pipe(
        Rx.tap((s: any) => {
          process.stdout.write(`\r🔄 Synchronizing wallet... [${s.isSynced ? 'DONE' : 'Loading'}]   `);
        }),
        Rx.filter((s: any) => s.isSynced),
        Rx.take(1)
      )
    ) as FacadeState;
    console.log(chalk.green("\n✅ Wallet Synced!"));

    const didManager = new DIDManager(wallet, networkConfig, state.shielded.encryptionPublicKey as any, shieldedSecretKeys, dustSecretKey, unshieldedKeystore, walletSeed);

    const testDID = `test-${Date.now().toString().slice(-6)}.night`;
    
    // 1. Register DID
    console.log(chalk.yellow(`\n📝 Step 1: Registering DID '${testDID}'...`));
    await didManager.registerDID(testDID);

    // 2. Update DID Document
    console.log(chalk.yellow(`\n📝 Step 2: Updating DID Document for '${testDID}'...`));
    await didManager.updateDID(testDID, "v=did:midnight:test-document-v1");

    // 3. Issue Credential
    console.log(chalk.yellow(`\n📝 Step 3: Issuing Credential (DOB: 19950101) for '${testDID}'...`));
    await didManager.issueCredential(testDID, 19950101);

    // 4. Verify Age
    console.log(chalk.yellow(`\n📝 Step 4: Verifying Age (Threshold: 18+)...`));
    await didManager.verifyAge(testDID, 19950101, 18);

    console.log(chalk.green.bold("\n✨ ALL VERIFICATION STEPS PASSED SUCCESSFULLY! ✨"));

    await wallet.stop();
  } catch (error: any) {
    console.error(chalk.red("\n❌ Verification Failed:"));
    console.error(chalk.red(error.stack || error.message));
    process.exit(1);
  }
}

main();
