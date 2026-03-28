import "dotenv/config";
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
  LedgerParameters,
  nativeToken
} from "@midnight-ntwrk/ledger-v8";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { WebSocket } from "ws";
import * as Rx from "rxjs";
import chalk from "chalk";
import { EnvironmentManager } from "./utils/environment.js";

// --- POLYFILL START ---
if (!Object.getPrototypeOf(new Map().values()).map) {
  Object.defineProperty(Object.getPrototypeOf(new Map().values()), 'map', {
    value: function (fn: any) {
      return Array.from(this).map(fn);
    },
    configurable: true,
    enumerable: false,
    writable: true
  });
}
// --- POLYFILL END ---

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
  try {
    const networkConfig = EnvironmentManager.getNetworkConfig();
    const walletSeed = process.env.WALLET_SEED!;
    const seed = Uint8Array.from(Buffer.from(walletSeed, "hex"));

    const hdWalletResult = HDWallet.fromSeed(seed);
    if (hdWalletResult.type === "seedError") throw new Error(String((hdWalletResult as any).error));
    const account = hdWalletResult.hdWallet.selectAccount(0);

    // Setup Unshielded Wallet
    const unshieldedKeyResult = account.selectRole(Roles.NightExternal).deriveKeyAt(0);
    const keystore = createKeystore((unshieldedKeyResult as any).key, "preview");
    const publicKeyObj = PublicKey.fromKeyStore(keystore);

    // Setup Dust Wallet
    const dustKeyResult = account.selectRole(Roles.Dust).deriveKeyAt(0);
    const dustSecretKey = DustSecretKey.fromSeed((dustKeyResult as any).key);

    // Setup Shielded Wallet
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
        costParameters: {
          additionalFeeOverhead: 0n,
          feeBlocksMargin: 5,
        },
      },
      shielded: (config) => ShieldedWallet(config).startWithSecretKeys(shieldedSecretKeys),
      unshielded: (config) => UnshieldedWallet({ ...config, txHistoryStorage: new InMemoryTransactionHistoryStorage() }).startWithPublicKey(publicKeyObj),
      dust: (config) => DustWallet(config).startWithSecretKey(dustSecretKey, ledgerParams.dust),
    });

    console.log(chalk.cyan("🔄 Initializing and synchronizing wallet..."));
    await wallet.start(shieldedSecretKeys, dustSecretKey);

    const state = await Rx.firstValueFrom(wallet.state().pipe(Rx.filter((s) => s.isSynced))) as FacadeState;

    console.log();
    console.log(chalk.cyan.bold("📍 Wallet Addresses:"));
    console.log(chalk.white(`   Unshielded:  ${state.unshielded.address}`));
    console.log(chalk.white(`   Shielded:    ${state.shielded.address}`));
    console.log(chalk.white(`   Dust:        ${state.dust.address}`));
    
    let balance = state.shielded.balances[nativeToken().tag] || 0n;
    console.log(chalk.white(`   Balance:     ${balance} tNight`));
    console.log();

    await wallet.stop();
  } catch (error: any) {
    console.error(chalk.red(error.stack || error.message));
    process.exit(1);
  }
}

main();
