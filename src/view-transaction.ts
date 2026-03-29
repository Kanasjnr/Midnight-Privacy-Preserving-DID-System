import "dotenv/config";
import chalk from "chalk";
import { EnvironmentManager } from "./utils/environment.js";

async function fetchTransactionDetails(indexerUrl: string, txHash: string) {
  const query = `
    query Transaction($hash: HexEncoded!) {
      transactions(offset: { hash: $hash }) {
        hash
        protocolVersion
        id
        block {
          hash
          height
          timestamp
        }
        unshieldedCreatedOutputs {
          owner
          value
          outputIndex
        }
        unshieldedSpentOutputs {
          owner
          value
        }
        dustLedgerEvents {
          id
          raw
          maxId
        }
        zswapLedgerEvents {
          id
          raw
          maxId
        }
      }
    }
  `;

  const response = await fetch(indexerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      variables: { hash: txHash },
    }),
  });

  const result = (await response.json()) as any;
  if (result.errors) {
    throw new Error(result.errors.map((e: any) => e.message).join(", "));
  }
  return result.data.transactions?.[0];
}

async function main() {
  const txHash = process.argv[2];
  if (!txHash) {
    console.error(chalk.red("Usage: npm run view-tx <transaction-hash>"));
    process.exit(1);
  }

  console.log(chalk.blue.bold("━".repeat(60)));
  console.log(chalk.blue.bold("🔍 Midnight Transaction Detail Viewer"));
  console.log(chalk.blue.bold("━".repeat(60)) + "\n");

  try {
    const networkConfig = EnvironmentManager.getNetworkConfig();
    console.log(chalk.gray(`Network: ${networkConfig.name}`));
    console.log(chalk.gray(`Indexer: ${networkConfig.indexer}`));
    console.log(chalk.cyan(`📡 Fetching details for hash: ${txHash}...\n`));

    const tx = await fetchTransactionDetails(networkConfig.indexer, txHash);

    if (!tx) {
      console.error(chalk.red("❌ Transaction not found."));
      process.exit(1);
    }

    console.log(chalk.blue.bold("Transaction Detail"));
    console.log(chalk.gray("View transaction details and information\n"));

    console.log(chalk.white.bold("Hash"));
    console.log(chalk.cyan(tx.hash) + "\n");

    console.log(chalk.white.bold("Identifiers"));
    if (tx.id) console.log(chalk.gray(tx.id));
    const identifiers = new Set<string>();
    [...(tx.dustLedgerEvents || []), ...(tx.zswapLedgerEvents || [])].forEach(
      (e: any) => {
        const matches = e.raw.match(/[0-9a-fA-F]{64}/g);
        if (matches) matches.forEach((m: string) => identifiers.add(m));
      },
    );
    identifiers.delete(tx.hash);
    identifiers.delete(tx.id);
    identifiers.forEach((id) => console.log(chalk.gray(id)));
    if (!tx.id && identifiers.size === 0) console.log(chalk.gray("None found"));
    console.log("");

    console.log(chalk.blue.bold("Transaction Overview"));
    console.log(
      `${chalk.white.bold("Block Hash")}      ${chalk.gray(tx.block?.hash || "N/A")}`,
    );
    console.log(
      `${chalk.white.bold("Block Height")}    ${chalk.gray("#" + (tx.block?.height || "N/A"))}`,
    );
    console.log(
      `${chalk.white.bold("Timestamp")}       ${chalk.gray(tx.block?.timestamp ? new Date(tx.block.timestamp).toLocaleString() : "N/A")}`,
    );
    console.log(
      `${chalk.white.bold("Protocol Version")} ${chalk.gray(tx.protocolVersion || "N/A")}`,
    );
    console.log("");

    console.log(chalk.blue.bold("Transaction Summary"));
    const totalInput =
      tx.unshieldedSpentOutputs?.reduce(
        (acc: bigint, i: any) => acc + BigInt(i.value || 0),
        0n,
      ) || 0n;
    const totalOutput =
      tx.unshieldedCreatedOutputs?.reduce(
        (acc: bigint, o: any) => acc + BigInt(o.value || 0),
        0n,
      ) || 0n;

    console.log(
      `${chalk.white.bold("Total Input")}     ${chalk.green(totalInput.toString())} NIGHT`,
    );
    console.log(
      `${chalk.white.bold("Total Output")}    ${chalk.green(totalOutput.toString())} NIGHT\n`,
    );

    if (tx.unshieldedSpentOutputs?.length > 0) {
      console.log(
        chalk.blue.bold(`Inputs (${tx.unshieldedSpentOutputs.length})`),
      );
      tx.unshieldedSpentOutputs.forEach((input: any, index: number) => {
        console.log(chalk.white(`#${index + 1}`));
        console.log(chalk.cyan(input.owner || "Unknown Address"));
        console.log(`${chalk.green(input.value || "0")} NIGHT`);
        console.log("");
      });
    }

    if (tx.unshieldedCreatedOutputs?.length > 0) {
      console.log(
        chalk.blue.bold(`Outputs (${tx.unshieldedCreatedOutputs.length})`),
      );
      tx.unshieldedCreatedOutputs.forEach((output: any, index: number) => {
        console.log(chalk.white(`#${output.outputIndex ?? index}`));
        console.log(chalk.cyan(output.owner || "Unknown Address"));
        console.log(`${chalk.green(output.value || "0")} NIGHT`);
        console.log("");
      });
    }

    if (tx.dustLedgerEvents && tx.dustLedgerEvents.length > 0) {
      console.log(chalk.blue.bold("Dust Ledger Events"));
      tx.dustLedgerEvents.forEach((event: any) => {
        console.log(
          `${chalk.white.bold("Event ID:")} ${chalk.yellow(event.id)}`,
        );
        console.log(
          `${chalk.white.bold("Max ID:")}   ${chalk.gray(event.maxId || "N/A")}`,
        );
        console.log(chalk.gray(event.raw));
        console.log("");
      });
    }

    if (tx.zswapLedgerEvents && tx.zswapLedgerEvents.length > 0) {
      console.log(chalk.blue.bold("Zswap Ledger Events"));
      tx.zswapLedgerEvents.forEach((event: any) => {
        console.log(
          `${chalk.white.bold("Event ID:")} ${chalk.yellow(event.id)}`,
        );
        console.log(
          `${chalk.white.bold("Max ID:")}   ${chalk.gray(event.maxId || "N/A")}`,
        );
        console.log(chalk.gray(event.raw));
        console.log("");
      });
    }

    console.log(chalk.blue.bold("━".repeat(60)) + "\n");
  } catch (error: any) {
    console.error(
      chalk.red(`\n❌ Error fetching transaction: ${error.message}`),
    );
    process.exit(1);
  }
}

main().catch(console.error);
