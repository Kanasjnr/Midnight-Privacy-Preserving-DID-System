import { WebSocket } from "ws";
import * as Rx from "rxjs";
import { Buffer } from "buffer";
import chalk from "chalk";
import * as dotenv from "dotenv";
import {
  setNetworkId,
  getNetworkId,
} from "@midnight-ntwrk/midnight-js-network-id";
import { toHex } from "@midnight-ntwrk/midnight-js-utils";
import * as ledger from "@midnight-ntwrk/ledger-v8";
import { unshieldedToken } from "@midnight-ntwrk/ledger-v8";
import { WalletFacade } from "@midnight-ntwrk/wallet-sdk-facade";
import { DustWallet } from "@midnight-ntwrk/wallet-sdk-dust-wallet";
import { HDWallet, Roles } from "@midnight-ntwrk/wallet-sdk-hd";
import { ShieldedWallet } from "@midnight-ntwrk/wallet-sdk-shielded";
import {
  createKeystore,
  InMemoryTransactionHistoryStorage,
  PublicKey,
  UnshieldedWallet,
} from "@midnight-ntwrk/wallet-sdk-unshielded-wallet";

dotenv.config();

// --- POLYFILLS (Required for some SDK versions) ---
const polyfillIterator = (proto: any) => {
  if (proto && !proto.map)
    proto.map = function (fn: any) {
      return Array.from(this).map(fn);
    };
  if (proto && !proto.toArray)
    proto.toArray = function () {
      return Array.from(this);
    };
};
polyfillIterator(Object.getPrototypeOf(new Map().values()));
polyfillIterator(Object.getPrototypeOf(new Set().values()));
polyfillIterator(Object.getPrototypeOf([].values()));

// @ts-expect-error Required for wallet sync
globalThis.WebSocket = WebSocket;

setNetworkId("preprod");

const CONFIG = {
  indexer: "https://indexer.preprod.midnight.network/api/v3/graphql",
  indexerWS: "wss://indexer.preprod.midnight.network/api/v3/graphql/ws",
  node: "wss://rpc.preprod.midnight.network",
  proofServer: "http://127.0.0.1:6300",
};

function deriveKeys(seed: string) {
  const hdWallet = HDWallet.fromSeed(Buffer.from(seed, "hex"));
  if (hdWallet.type !== "seedOk") throw new Error("Invalid seed");
  const result = hdWallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  if (result.type !== "keysDerived") throw new Error("Key derivation failed");
  hdWallet.hdWallet.clear();
  return result.keys;
}

async function main() {
  console.log(chalk.bold.cyan("\n🌙 Midnight DUST Registration Utility"));
  console.log(
    chalk.gray(
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n",
    ),
  );

  const seed = process.env.WALLET_SEED;
  if (!seed) {
    console.error(chalk.red("❌ WALLET_SEED not found in .env"));
    process.exit(1);
  }

  console.log(chalk.yellow("📡 Initializing wallet..."));
  const keys = deriveKeys(seed);
  const networkId = getNetworkId();
  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(
    keys[Roles.NightExternal],
    networkId,
  );

  const walletConfig = {
    networkId,
    indexerClientConnection: {
      indexerHttpUrl: CONFIG.indexer,
      indexerWsUrl: CONFIG.indexerWS,
    },
    relayURL: new URL(CONFIG.node),
    provingServerUrl: new URL(CONFIG.proofServer),
    txHistoryStorage: new InMemoryTransactionHistoryStorage(),
    costParameters: {
      additionalFeeOverhead: 300_000_000_000_000n,
      feeBlocksMargin: 5,
    },
  };

  const wallet = await WalletFacade.init({
    configuration: walletConfig,
    shielded: (config) =>
      ShieldedWallet(config).startWithSecretKeys(shieldedSecretKeys),
    unshielded: (config) =>
      UnshieldedWallet(config).startWithPublicKey(
        PublicKey.fromKeyStore(unshieldedKeystore),
      ),
    dust: (config) =>
      DustWallet(config).startWithSecretKey(
        dustSecretKey,
        ledger.LedgerParameters.initialParameters().dust,
      ),
  });

  console.log(chalk.yellow("🔄 Starting background sync..."));
  await wallet.start(shieldedSecretKeys, dustSecretKey);

  console.log(
    chalk.yellow("⏳ Syncing with network (this may take a few minutes)..."),
  );
  const state = await Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.throttleTime(5000),
      Rx.tap((s: any) => {
        const u = s.unshielded.state.progress;
        const balance = s.unshielded.balances[unshieldedToken().raw] ?? 0n;
        process.stdout.write(
          `\r[SYNC] U:${u.appliedId}/${u.highestTransactionId} | SYNCED: ${s.isSynced} | 💰 Balance: ${balance.toLocaleString()} tNight   `,
        );
      }),
      Rx.filter((s) => s.isSynced),
      Rx.take(1),
    ),
  );

  const balance = state.unshielded.balances[unshieldedToken().raw] ?? 0n;
  const address = unshieldedKeystore.getBech32Address();
  console.log(chalk.green(`\n\n✅ Wallet Synced!`));
  console.log(`📍 Address: ${chalk.blue(address)}`);
  console.log(`💰 Balance: ${chalk.green(balance.toLocaleString())} tNight`);

  if (balance === 0n) {
    console.error(
      chalk.red(
        "\n❌ Wallet is empty. Please fund it at https://faucet.preprod.midnight.network/",
      ),
    );
    process.exit(1);
  }

  console.log(chalk.cyan("\n🔍 Checking DUST status..."));
  const dustBalance = state.dust.balance(new Date());
  console.log(`✨ Current DUST: ${chalk.green(dustBalance.toLocaleString())}`);

  if (dustBalance === 0n) {
    const nightUtxos = state.unshielded.availableCoins.filter(
      (c: any) => !c.meta?.registeredForDustGeneration,
    );

    if (nightUtxos.length > 0) {
      console.log(
        chalk.yellow(
          `\n🚀 Found ${nightUtxos.length} unregistered UTXOs. Submitting registration...`,
        ),
      );
      try {
        const recipe = await wallet.registerNightUtxosForDustGeneration(
          nightUtxos,
          unshieldedKeystore.getPublicKey(),
          (payload) => unshieldedKeystore.signData(payload),
        );
        const txId = await wallet.submitTransaction(
          await wallet.finalizeRecipe(recipe),
        );
        console.log(chalk.green(`\n✅ Registration transaction submitted!`));
        console.log(`🔗 Transaction Hash: ${chalk.cyan(txId)}`);

        console.log(
          chalk.yellow(
            "\n⏳ Now wait for DUST to appear (this usually takes 1-2 blocks)...",
          ),
        );
        console.log(
          chalk.gray("   You can run this script again in 2 minutes to check."),
        );
      } catch (err: any) {
        console.error(chalk.red(`\n❌ Registration failed: ${err.message}`));
        if (err.cause) {
          console.error(
            chalk.red(`   Cause: ${JSON.stringify(err.cause, null, 2)}`),
          );
        }
        if (err.data) {
          console.error(
            chalk.red(`   Data: ${JSON.stringify(err.data, null, 2)}`),
          );
        }
        console.error(chalk.gray(`\n   Full Error Trace:`));
        console.error(err);
      }
    } else {
      console.log(
        chalk.green(
          "\n✅ All UTXOs are already registered for DUST generation.",
        ),
      );
      console.log(
        chalk.gray(
          "   If you recently registered, please wait for the network to mint your DUST.",
        ),
      );
    }
  } else {
    console.log(
      chalk.green(
        "\n🎉 You already have DUST tokens! You are ready for deployment.",
      ),
    );
  }

  await wallet.stop();
  process.exit(0);
}

main().catch((err) => {
  console.error(chalk.red("\n🔥 Fatal error:"));
  console.error(err);
  process.exit(1);
});
