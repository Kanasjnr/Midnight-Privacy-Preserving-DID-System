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
import { WalletFacade } from "@midnight-ntwrk/wallet-sdk-facade";
import {
  ZswapSecretKeys,
  DustSecretKey,
  LedgerParameters,
  Signature,
  unshieldedToken,
} from "@midnight-ntwrk/ledger-v8";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { WebSocket } from "ws";
import * as Rx from "rxjs";
import chalk from "chalk";
import { EnvironmentManager } from "./utils/environment.js";

// @ts-ignore
globalThis.WebSocket = WebSocket;

// --- POLYFILLS ---
const polyfillIterator = (proto: any) => {
  if (proto && !proto.map) proto.map = function(fn: any) { return Array.from(this).map(fn); };
  if (proto && !proto.toArray) proto.toArray = function() { return Array.from(this); };
};
polyfillIterator(Object.getPrototypeOf(new Map().values()));
polyfillIterator(Object.getPrototypeOf(new Set().values()));
polyfillIterator(Object.getPrototypeOf([].values()));
// --- END POLYFILLS ---

async function fetchLedgerParameters(indexerUrl: string): Promise<LedgerParameters> {
  const response = await fetch(indexerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: `query { block { ledgerParameters } }` }),
  });
  const result = (await response.json()) as any;
  const hex = result.data.block.ledgerParameters;
  return LedgerParameters.deserialize(Buffer.from(hex, "hex"));
}

async function main() {
  console.log("\n" + chalk.blue.bold("━".repeat(60)));
  console.log(chalk.blue.bold("🌙  Midnight Wallet Setup & DUST Registration"));
  console.log(chalk.blue.bold("━".repeat(60)) + "\n");

  try {
    const networkConfig = EnvironmentManager.getNetworkConfig();
    const networkId = networkConfig.name.toLowerCase() as any;
    setNetworkId(networkId);

    const walletSeed = process.env.WALLET_SEED!;
    const seed = Uint8Array.from(Buffer.from(walletSeed, "hex"));

    console.log(chalk.gray("Building wallet components..."));
    const hdWalletResult = HDWallet.fromSeed(seed);
    if (hdWalletResult.type === "seedError") throw new Error("Invalid seed");
    const account = hdWalletResult.hdWallet.selectAccount(0);

    const unshieldedKeyResult = account.selectRole(Roles.NightExternal).deriveKeyAt(0);
    const keystore = createKeystore((unshieldedKeyResult as any).key, networkId);
    const publicKeyObj = PublicKey.fromKeyStore(keystore);

    const dustSecretKey = DustSecretKey.fromSeed(seed);
    const shieldedSecretKeys = ZswapSecretKeys.fromSeed(seed);

    console.log(chalk.cyan("📡 Fetching LedgerParameters..."));
    const ledgerParams = await fetchLedgerParameters(networkConfig.indexer);

    console.log(chalk.cyan("📡 Wallet Facade Initializing..."));
    const wallet = await WalletFacade.init({
      configuration: {
        networkId,
        indexerClientConnection: { indexerHttpUrl: networkConfig.indexer, indexerWsUrl: networkConfig.indexerWS },
        relayURL: new URL(networkConfig.node),
        provingServerUrl: new URL(networkConfig.proofServer),
        txHistoryStorage: new InMemoryTransactionHistoryStorage(),
        costParameters: { additionalFeeOverhead: 20_000_000n, feeBlocksMargin: 10 },
      },
      shielded: (config) => ShieldedWallet(config).startWithSecretKeys(shieldedSecretKeys),
      unshielded: (config) => UnshieldedWallet({ ...config, txHistoryStorage: new InMemoryTransactionHistoryStorage() }).startWithPublicKey(publicKeyObj),
      dust: (config) => DustWallet(config).startWithSecretKey(dustSecretKey, ledgerParams.dust),
    });

    console.log(chalk.cyan("🔄 Starting background sync..."));
    try {
      await wallet.start(shieldedSecretKeys, dustSecretKey);
      console.log(chalk.green("✅ Wallet started successfully!"));
    } catch (startErr: any) {
      console.error(chalk.red(`❌ Wallet start failed: ${startErr.message}`));
      throw startErr;
    }

    console.log(chalk.yellow("⏳ Synchronizing... (waiting for funds to appear)"));
    const nightTokenRaw = unshieldedToken().raw;

    const state = await Rx.firstValueFrom(
      wallet.state().pipe(
        Rx.tap((s: any) => {
          const u = s.unshielded.state.progress;
          const sd = s.shielded.state.progress;
          const d = s.dust.state.progress;
          const balance = s.unshielded.balances[nightTokenRaw] ?? 0n;
          process.stdout.write(`\r[SYNC] U:${u.appliedId}/${u.highestTransactionId} S:${sd.appliedId}/${sd.highestTransactionId} D:${d.appliedId}/${d.highestTransactionId} | SYNCED: ${s.isSynced} | 💰 tNight: ${balance.toLocaleString()}   `);
        }),
        Rx.filter((s: any) => {
          const u = s.unshielded.state.progress;
          const balance = s.unshielded.balances[nightTokenRaw] ?? 0n;
          const caughtUp = u.highestTransactionId > 0 && u.appliedId >= u.highestTransactionId;
          return (s.isSynced || caughtUp) && balance > 0n;
        }),
        Rx.take(1)
      )
    );
    console.log(chalk.green("\n\n✅ Balance detected!"));

    const balance = (state as any).unshielded.balances[nightTokenRaw];
    const address = keystore.getBech32Address().toString();
    console.log(`📍 Address: ${chalk.cyan(address)}`);
    console.log(`💰 Balance: ${chalk.green(balance.toLocaleString())} tNight`);

    // DUST Registration
    const dustBalance = (state as any).dust.balance(new Date());
    if (dustBalance === 0n) {
      const unregisteredUtxos = (state as any).unshielded.availableCoins.filter((c: any) => !c.meta?.registeredForDustGeneration);
      
      if (unregisteredUtxos.length > 0) {
        console.log(chalk.yellow(`\n🚀 Found ${unregisteredUtxos.length} unregistered UTXOs. Registering for DUST generation...`));
        console.log(chalk.gray(`   UTXO 0 Sample: ${JSON.stringify(unregisteredUtxos[0], (k, v) => typeof v === 'bigint' ? v.toString() : v, 2)}`));
        const recipe = await wallet.registerNightUtxosForDustGeneration(
          unregisteredUtxos,
          keystore.getPublicKey(),
          (payload) => keystore.signData(payload) as Signature
        );
        const finalizedTx = await wallet.finalizeRecipe(recipe);
        const txId = await wallet.submitTransaction(finalizedTx);
        console.log(chalk.green(`✅ Registration Transaction Submitted: ${txId}`));
      }

      console.log(chalk.cyan("⏳ Waiting for DUST arrival (~2 mins)..."));
      await Rx.firstValueFrom(
        wallet.state().pipe(
          Rx.filter((s: any) => s.dust.balance(new Date()) > 0n),
          Rx.take(1)
        )
      );
      console.log(chalk.green("✨ DUST Tokens Arrived!"));
    } else {
      console.log(chalk.green(`✨ DUST already available: ${dustBalance.toLocaleString()}`));
    }

    console.log(chalk.green.bold("\n🎉 READY! Run 'npm run deploy' to launch your contract.\n"));
    await wallet.stop();
  } catch (error: any) {
    console.error(chalk.red("\n❌ Error:"));
    console.error(chalk.red(error.stack || error.message));
    if (error.cause) {
      console.error(chalk.red("Cause:"));
      console.error(chalk.red(error.cause.stack || error.cause.message || error.cause));
    }
    process.exit(1);
  }
}

main().catch(console.error);
