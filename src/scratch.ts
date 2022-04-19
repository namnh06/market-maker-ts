import { readFileSync } from 'fs';
import {
  Account,
  Commitment,
  Connection,
  PublicKey,
  Transaction,
} from '@solana/web3.js';
import os from 'os';
import {
  Cluster,
  Config,
  findLargestTokenAccountForOwner,
  GroupConfig,
  IDS,
  makeWithdrawInstruction,
  MangoClient,
  QUOTE_INDEX,
  RootBank,
} from '@blockworks-foundation/mango-client';
import { BN } from 'bn.js';

const config = new Config(IDS);

const groupIds = config.getGroupWithName('devnet.2') as GroupConfig;
if (!groupIds) {
  throw new Error(`Group ${'mainnet.1'} not found`);
}
const cluster = groupIds.cluster as Cluster;
const mangoProgramId = groupIds.mangoProgramId;
const mangoGroupKey = groupIds.publicKey;

async function scratch() {
  const connection = new Connection(
    process.env.ENDPOINT_URL ?? config.cluster_urls[cluster],
    'processed' as Commitment,
  );

  const payer = new Account(
    JSON.parse(
      readFileSync(
        process.env.KEYPAIR ?? os.homedir() + '/.config/solana/devnet.json',
        'utf-8',
      ),
    ),
  );

  const client = new MangoClient(connection, mangoProgramId);
  const group = await client.getMangoGroup(mangoGroupKey);
  const mangoAccountPubkey = new PublicKey(
    '22JS1jkvkLcdxhHo1LpWXUh6sTErkt54j1YaszYWZoCi',
  );

  // Performs parallel request
  const [mangoAccount, rootBanks, tokenAccount] = await Promise.all([
    client.getMangoAccount(
      mangoAccountPubkey,
      groupIds.serumProgramId,
    ),
    group.loadRootBanks(connection),
    findLargestTokenAccountForOwner(
      connection,
      payer.publicKey,
      group.tokens[QUOTE_INDEX].mint,
    )
  ]);

  const { publicKey: quoteRootBankPublicKey, nodeBankAccounts  } = rootBanks[QUOTE_INDEX] as RootBank;
  const { publicKey: quoteNodeBankPublicKey, vault } = nodeBankAccounts[0];
  const { publicKey: groupPublicKey, mangoCache, signerKey } = group;
  const { publicKey: mangoAccountPublicKey, spotOpenOrders } = mangoAccount;

  const instr = makeWithdrawInstruction(
    client.programId,
    groupPublicKey,
    mangoAccountPublicKey,
    payer.publicKey,
    mangoCache,
    quoteRootBankPublicKey,
    quoteNodeBankPublicKey,
    vault,
    tokenAccount.publicKey,
    signerKey,
    spotOpenOrders,
    new BN('100'),
    true,
  );
  const tx = new Transaction();
  tx.add(instr);
  const txid = await client.sendTransaction(tx, payer, []);
  console.log(txid.toString());
}

// Immediately invoked scratch function expression
(async () => {
  await scratch();
})();
