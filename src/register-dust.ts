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
import { initializePolyfills } from "./utils/polyfills.js";

/**
 * Initializes required SDK polyfills for environment compatibility.
 */
initializePolyfills();

/**
 * Fetches current ledger parameters from the Midnight indexer.
 * Required for DUST utility transaction fee calculations.
 */
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
  console.log(chalk.blue.bold("🌙  Midnight DUST Registration Utility"));
  console.log(chalk.blue.bold("━".repeat(60) + "\n"));

  try {
    EnvironmentManager.validateEnvironment();
    const networkConfig = EnvironmentManager.getNetworkConfig();
    const networkId = networkConfig.name.toLowerCase() as any;
    setNetworkId(networkId);

    const walletSeed = process.env.WALLET_SEED!;
    const seed = Buffer.from(walletSeed, "hex");

    const hdWalletResult = HDWallet.fromSeed(seed);
    if (hdWalletResult.type !== "seedOk") throw new Error("Invalid seed");
    const account = hdWalletResult.hdWallet.selectAccount(0);

    const keys = account
      .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
      .deriveKeysAt(0);
    if (keys.type !== "keysDerived") throw new Error("Key derivation failed");

    const keystore = createKeystore(keys.keys[Roles.NightExternal], networkId);
    const publicKeyObj = PublicKey.fromKeyStore(keystore);
    const dustSecretKey = DustSecretKey.fromSeed(keys.keys[Roles.Dust]);
    const shieldedSecretKeys = ZswapSecretKeys.fromSeed(keys.keys[Roles.Zswap]);

    console.log(chalk.cyan("📡 Fetching network status..."));
    const ledgerParams = await fetchLedgerParameters(networkConfig.indexer);

    const wallet = await WalletFacade.init({
      configuration: {
        networkId,
        indexerClientConnection: { indexerHttpUrl: networkConfig.indexer, indexerWsUrl: networkConfig.indexerWS },
        relayURL: new URL(networkConfig.node.replace(/^http/, "ws")),
        provingServerUrl: new URL(networkConfig.proofServer),
        txHistoryStorage: new InMemoryTransactionHistoryStorage(),
        costParameters: { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 },
      },
      shielded: (config) => ShieldedWallet(config).startWithSecretKeys(shieldedSecretKeys),
      unshielded: (config) => UnshieldedWallet({ ...config, txHistoryStorage: new InMemoryTransactionHistoryStorage() }).startWithPublicKey(publicKeyObj),
      dust: (config) => DustWallet(config).startWithSecretKey(dustSecretKey, ledgerParams.dust),
    });

    console.log(chalk.cyan("🔄 Synchronizing with network..."));
    await wallet.start(shieldedSecretKeys, dustSecretKey);

    const nightTokenRaw = unshieldedToken().raw;

    const state = await Rx.firstValueFrom(
      wallet.state().pipe(
        Rx.tap((s: any) => {
          process.stdout.write(`\r🔄 Synchronizing wallet... [${s.isSynced ? 'DONE' : 'Loading'}]   `);
        }),
        Rx.filter((s: any) => s.isSynced),
        Rx.take(1)
      )
    );

    const balance = (state as any).unshielded.balances[nightTokenRaw] ?? 0n;
    if (balance === 0n) {
      console.log(chalk.red("\n\n❌ Wallet has no tNight. Please fund it at https://faucet.preprod.midnight.network/"));
      process.exit(1);
    }

    const unregisteredUtxos = (state as any).unshielded.availableCoins.filter((c: any) => !c.meta?.registeredForDustGeneration);
    
    if (unregisteredUtxos.length > 0) {
      console.log(chalk.yellow(`\n\n🚀 Found ${unregisteredUtxos.length} unregistered UTXOs. Submitting registration...`));
      const recipe = await wallet.registerNightUtxosForDustGeneration(
        unregisteredUtxos,
        keystore.getPublicKey(),
        (payload) => keystore.signData(payload) as Signature
      );
      const finalizedTx = await wallet.finalizeRecipe(recipe);
      const txId = await wallet.submitTransaction(finalizedTx);
      console.log(chalk.green(`✅ Registration Transaction Submitted: ${txId}`));
      console.log(chalk.cyan("⏳ Please wait ~2 minutes for DUST to appear."));
    } else {
      const dustBalance = (state as any).dust.balance(new Date());
      console.log(chalk.green(`\n\n✅ All UTXOs are already registered. Current DUST: ${dustBalance.toLocaleString()}`));
    }

    await wallet.stop();
  } catch (error: any) {
    console.error(chalk.red("\n❌ Error:"));
    console.error(chalk.red(error.stack || error.message));
    process.exit(1);
  }
}

main().catch(console.error);
