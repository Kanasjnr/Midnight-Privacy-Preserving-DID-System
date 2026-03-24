import "dotenv/config";
import { HDWallet, Roles } from "@midnight-ntwrk/wallet-sdk-hd";

const seed = Uint8Array.from(Buffer.from(process.env.WALLET_SEED!, 'hex'));
const hdWalletResult = HDWallet.fromSeed(seed);
const account = (hdWalletResult as any).hdWallet.selectAccount(0);
console.log(account.selectRole(Roles.Zswap).deriveKeyAt(0));
