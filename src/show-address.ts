import "dotenv/config";
import { HDWallet, Roles } from "@midnight-ntwrk/wallet-sdk-hd";
import { createKeystore } from "@midnight-ntwrk/wallet-sdk-unshielded-wallet";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import chalk from "chalk";

async function main() {
  const seed = process.env.WALLET_SEED;
  if (!seed) throw new Error("WALLET_SEED not found");

  const network = process.env.MIDNIGHT_NETWORK || "preprod";
  // @ts-ignore
  setNetworkId(network);

  const seedBytes = Uint8Array.from(Buffer.from(seed, "hex"));
  const hdWallet = HDWallet.fromSeed(seedBytes);
  if (hdWallet.type === "seedError") throw new Error("Invalid seed");
  
  const account = hdWallet.hdWallet.selectAccount(0);
  const unshieldedKeyResult = account.selectRole(Roles.NightExternal).deriveKeyAt(0);
  // @ts-ignore
  const keystore = createKeystore(unshieldedKeyResult.key, network);
  const address = keystore.getBech32Address();

  console.log("\n" + chalk.green.bold("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
  console.log(chalk.white.bold("🌙 NEW PREPROD WALLET DETAILS"));
  console.log(chalk.green.bold("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
  console.log(`${chalk.yellow("Seed:")}    ${seed}`);
  console.log(`${chalk.yellow("Network:")} ${network.toUpperCase()}`);
  console.log(`${chalk.yellow("Address:")} ${chalk.cyan.underline(address)}`);
  console.log(chalk.green.bold("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"));
}

main().catch(console.error);
