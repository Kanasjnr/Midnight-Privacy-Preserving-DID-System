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
  unshieldedToken,
} from "@midnight-ntwrk/ledger-v8";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import * as Rx from "rxjs";
import chalk from "chalk";
import { EnvironmentManager } from "./utils/environment.js";
import { initializePolyfills } from "./utils/polyfills.js";


function formatMidnight(amount: bigint): string {
  const units = Number(amount) / 1_000_000;
  return units.toLocaleString(undefined, {
    minimumFractionDigits: 6,
    maximumFractionDigits: 6,
  });
}

/**
 * Initializes the required SDK-level polyfills for iterator and WebSocket compatibility.
 */
initializePolyfills();

/**
 * Fetches the current ledger parameters from the Midnight indexer.
 * Required for initializing the Dust wallet and calculating transaction costs.
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
  console.log(chalk.blue.bold("━".repeat(60)));
  console.log(chalk.blue.bold("🌙  Midnight Wallet Balance Checker"));
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
        costParameters: { additionalFeeOverhead: 0n, feeBlocksMargin: 5 },
      },
      shielded: (config) => ShieldedWallet(config).startWithSecretKeys(shieldedSecretKeys),
      unshielded: (config) => UnshieldedWallet({ ...config, txHistoryStorage: new InMemoryTransactionHistoryStorage() }).startWithPublicKey(publicKeyObj),
      dust: (config) => DustWallet(config).startWithSecretKey(dustSecretKey, ledgerParams.dust),
    });

    console.log(chalk.cyan("🔄 Initializing system..."));
    await wallet.start(shieldedSecretKeys, dustSecretKey);

    const nightTokenRaw = unshieldedToken().raw;

    const state = await Rx.firstValueFrom(
      wallet.state().pipe(
        Rx.tap((s: any) => {
          process.stdout.write(
            `\r🔄 Synchronizing wallet... [Loading.....] (This may take a few minutes)   `,
          );
        }),
        Rx.filter((s: any) => s.isSynced),
        Rx.take(1)
      )
    );
    
    process.stdout.write(
      `\r🔄 Synchronizing wallet... [DONE]                                  \n`,
    );

    const balance = (state as any).unshielded.balances[nightTokenRaw] ?? 0n;
    const dustBalance = (state as any).dust.balance(new Date());
    const address = keystore.getBech32Address().toString();

    console.log(chalk.green("\n✅ Wallet synchronization complete!"));
    console.log(`📍 Address: ${chalk.cyan(address)}`);
    console.log(`💰 tNight:  ${chalk.green(formatMidnight(balance))}`);
    console.log(`✨ DUST:    ${chalk.green(dustBalance.toLocaleString())}`);
    
    if (dustBalance === 0n) {
      console.log(chalk.yellow("\n⚠️  No DUST tokens detected. Run 'npm run register-dust' if needed."));
    }

    await wallet.stop();
  } catch (error: any) {
    console.error(chalk.red("\n❌ Error:"));
    console.error(chalk.red(error.stack || error.message));
    process.exit(1);
  }
}

main().catch(console.error);
