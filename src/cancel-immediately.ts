import {
    Account,
    Commitment,
    Connection,
    PublicKey,
    Transaction,
    TransactionInstruction,
    TransactionSignature,
} from '@solana/web3.js';
import fs from 'fs';
import os from 'os';
import child_process from 'child_process';
import { BN } from 'bn.js';
import {
    BookSide,
    BookSideLayout,
    Cluster,
    Config,
    getMultipleAccounts,
    getPerpMarketByBaseSymbol,
    getUnixTs,
    GroupConfig,
    IDS,
    makeCancelAllPerpOrdersInstruction,
    MangoAccount,
    MangoAccountLayout,
    MangoCache,
    MangoCacheLayout,
    MangoClient,
    MangoGroup,
    PerpMarket,
    PerpMarketConfig,
    sleep,
    zeroKey,
} from '@blockworks-foundation/mango-client';
import { OpenOrders } from '@project-serum/serum';
import path from 'path';
import {
    loadMangoAccountWithName,
    loadMangoAccountWithPubkey,
    makeCheckAndSetSequenceNumberInstruction,
    makeInitSequenceInstruction,
    seqEnforcerProgramId,
    listenersArray,
} from './utils';
import { findProgramAddressSync } from '@project-serum/anchor/dist/cjs/utils/pubkey';
import { Context, Telegraf } from 'telegraf';

declare var lastSendTelegram: number;

// Define your own context type
interface MyContext extends Context {
    myProp?: string
    myOtherProp?: number
}

const paramsFileName = process.env.PARAMS || 'default.json';
const params = JSON.parse(
    fs.readFileSync(
        path.resolve(__dirname, `../params/${paramsFileName}`),
        'utf-8',
    ),
);

const payer = new Account(
    JSON.parse(
        fs.readFileSync(
            process.env.KEYPAIR || os.homedir() + '/.config/solana/id.json',
            'utf-8',
        ),
    ),
);

const config = new Config(IDS);

const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || '';

const groupIds = config.getGroupWithName(params.group) as GroupConfig;
if (!groupIds) {
    throw new Error(`Group ${params.group} not found`);
}
const cluster = groupIds.cluster as Cluster;
const mangoProgramId = groupIds.mangoProgramId;
const mangoGroupKey = groupIds.publicKey;

const control = { isRunning: true, interval: params.interval };

type State = {
    cache: MangoCache;
    mangoAccount: MangoAccount;
    lastMangoAccountUpdate: number;
    marketContexts: MarketContext[];
};
type MarketContext = {
    marketName: string;
    params: any;
    config: PerpMarketConfig;
    market: PerpMarket;
    marketIndex: number;
    bids: BookSide;
    asks: BookSide;
    lastBookUpdate: number;

    aggBid: number | undefined;
    aggAsk: number | undefined;
    ftxMid: number | undefined;

    sequenceAccount: PublicKey;
    sequenceAccountBump: number;

    sentBidPrice: number;
    sentAskPrice: number;
    lastOrderUpdate: number;
};
type ListenerMessage = {
    marketName: string;
    aggBid: number;
    aggAsk: number;
    ftxMid: number;
};

/**
 * Load MangoCache, MangoAccount and Bids and Asks for all PerpMarkets using only
 * one RPC call.
 */
async function loadAccountAndMarketState(
    connection: Connection,
    group: MangoGroup,
    oldMangoAccount: MangoAccount,
    marketContexts: MarketContext[],
): Promise<State> {
    const inBasketOpenOrders = oldMangoAccount
        .getOpenOrdersKeysInBasket()
        .filter((pk) => !pk.equals(zeroKey));

    const allAccounts = [
        group.mangoCache,
        oldMangoAccount.publicKey,
        ...inBasketOpenOrders,
        ...marketContexts.map((marketContext) => marketContext.market.bids),
        ...marketContexts.map((marketContext) => marketContext.market.asks),
    ];

    const ts = getUnixTs();
    const accountInfos = await getMultipleAccounts(connection, allAccounts);

    const cache = new MangoCache(
        accountInfos[0].publicKey,
        MangoCacheLayout.decode(accountInfos[0].accountInfo.data),
    );

    const mangoAccount = new MangoAccount(
        accountInfos[1].publicKey,
        MangoAccountLayout.decode(accountInfos[1].accountInfo.data),
    );
    const openOrdersAis = accountInfos.slice(2, 2 + inBasketOpenOrders.length);
    for (let i = 0; i < openOrdersAis.length; i++) {
        const ai = openOrdersAis[i];
        const marketIndex = mangoAccount.spotOpenOrders.findIndex((soo) =>
            soo.equals(ai.publicKey),
        );
        mangoAccount.spotOpenOrdersAccounts[marketIndex] =
            OpenOrders.fromAccountInfo(
                ai.publicKey,
                ai.accountInfo,
                group.dexProgramId,
            );
    }

    accountInfos
        .slice(
            2 + inBasketOpenOrders.length,
            2 + inBasketOpenOrders.length + marketContexts.length,
        )
        .forEach((ai, i) => {
            marketContexts[i].bids = new BookSide(
                ai.publicKey,
                marketContexts[i].market,
                BookSideLayout.decode(ai.accountInfo.data),
            );
        });

    accountInfos
        .slice(
            2 + inBasketOpenOrders.length + marketContexts.length,
            2 + inBasketOpenOrders.length + 2 * marketContexts.length,
        )
        .forEach((ai, i) => {
            marketContexts[i].lastBookUpdate = ts;
            marketContexts[i].asks = new BookSide(
                ai.publicKey,
                marketContexts[i].market,
                BookSideLayout.decode(ai.accountInfo.data),
            );
        });

    return {
        cache,
        mangoAccount,
        lastMangoAccountUpdate: ts,
        marketContexts,
    };
}

// async function initSeqEnfAccounts(
//     client: MangoClient,
//     marketContexts: MarketContext[],
// ) {
//     // Initialize all the sequence accounts
//     const seqAccInstrs = marketContexts.map((mc) =>
//         makeInitSequenceInstruction(
//             mc.sequenceAccount,
//             payer.publicKey,
//             mc.sequenceAccountBump,
//             mc.marketName,
//         ),
//     );
//     const seqAccTx = new Transaction();
//     seqAccTx.add(...seqAccInstrs);

//     while (true) {
//         try {
//             const seqAccTxid = await client.sendTransaction(seqAccTx, payer, []);
//         } catch (e) {
//             console.log('failed to initialize sequence enforcer');
//             console.log(e);
//             continue;
//         }
//         break;
//     }
// }
async function mainCancel() {
    const connection = new Connection(
        process.env.ENDPOINT_URL || config.cluster_urls[cluster],
        'processed' as Commitment,
    );
    const client = new MangoClient(connection, mangoProgramId);
    // load group
    const mangoGroup = await client.getMangoGroup(mangoGroupKey);

    // load mangoAccount
    let mangoAccount: MangoAccount;
    if (params.mangoAccountName) {
        mangoAccount = await loadMangoAccountWithName(
            client,
            mangoGroup,
            payer,
            params.mangoAccountName,
        );
    } else if (params.mangoAccountPubkey) {
        mangoAccount = await loadMangoAccountWithPubkey(
            client,
            mangoGroup,
            payer,
            new PublicKey(params.mangoAccountPubkey),
        );
    } else {
        throw new Error(
            'Please add mangoAccountName or mangoAccountPubkey to params file',
        );
    }
    const bot = new Telegraf<MyContext>(telegramBotToken);

    const perpMarkets = await Promise.all(
        Object.keys(params.assets).map((baseSymbol) => {
            const perpMarketConfig = getPerpMarketByBaseSymbol(
                groupIds,
                baseSymbol,
            ) as PerpMarketConfig;

            return client.getPerpMarket(
                perpMarketConfig.publicKey,
                perpMarketConfig.baseDecimals,
                perpMarketConfig.quoteDecimals,
            );
        }),
    );
    // client.cancelAllPerpOrders(mangoGroup, perpMarkets, mangoAccount, payer);
    const marketContexts: MarketContext[] = [];
    for (const baseSymbol in params.assets) {
        const perpMarketConfig = getPerpMarketByBaseSymbol(
            groupIds,
            baseSymbol,
        ) as PerpMarketConfig;

        const [sequenceAccount, sequenceAccountBump] = findProgramAddressSync(
            [new Buffer(perpMarketConfig.name, 'utf-8'), payer.publicKey.toBytes()],
            seqEnforcerProgramId,
        );

        const perpMarket = perpMarkets.find((pm) =>
            pm.publicKey.equals(perpMarketConfig.publicKey),
        );
        if (perpMarket === undefined) {
            throw new Error('Cannot find perp market');
        }
        marketContexts.push({
            marketName: perpMarketConfig.name,
            params: params.assets[baseSymbol].perp,
            config: perpMarketConfig,
            market: perpMarket,
            marketIndex: perpMarketConfig.marketIndex,
            bids: await perpMarket.loadBids(connection),
            asks: await perpMarket.loadAsks(connection),
            lastBookUpdate: 0,
            aggBid: undefined,
            aggAsk: undefined,
            ftxMid: undefined,

            sequenceAccount,
            sequenceAccountBump,
            sentBidPrice: 0,
            sentAskPrice: 0,
            lastOrderUpdate: 0,
        });
    }
    // initSeqEnfAccounts(client, marketContexts);
    // const symbolToContext = Object.fromEntries(
    //     marketContexts.map((mc) => [mc.marketName, mc]),
    // );
    // const mdListeners: child_process.ChildProcess[] = listenersArray(params.processes, Object.keys(params.assets)).map((assetArray) => {
    //     const listener = child_process.fork(require.resolve('./listen'), [assetArray.map((a) => `${a}-PERP`).join(',')]);
    //     listener.on('message', (m: ListenerMessage) => {
    //         symbolToContext[m.marketName].aggBid = m.aggBid;
    //         symbolToContext[m.marketName].aggAsk = m.aggAsk;
    //         symbolToContext[m.marketName].ftxMid = m.ftxMid;
    //     });
    //     return listener;
    // })

    const state = await loadAccountAndMarketState(
        connection,
        mangoGroup,
        mangoAccount,
        marketContexts,
    );
    // listenState(client, state);
    const stateRefreshInterval = params.stateRefreshInterval || 500;
    // listenAccountAndMarketState(
    //     connection,
    //     mangoGroup,
    //     state,
    //     stateRefreshInterval,
    //     mdListeners
    // );

    process.on('SIGINT', function () {
        console.log('Caught keyboard interrupt. Canceling orders');
        control.isRunning = false;
        onExit(client, payer, mangoGroup, mangoAccount, marketContexts);
    });

    while (control.isRunning) {
        try {
            console.log('Cancelling ...');
            client.cancelAllPerpOrders(mangoGroup, perpMarkets, mangoAccount, payer);
        } catch (e) {
            console.log(e);
        } finally {
            // console.log(
            // `${new Date().toUTCString()} sleeping for ${control.interval / 1000}s`,
            // );
            await sleep(control.interval);
        }
    }
}

// /**
//  * Periodically fetch the account and market state
//  */
// async function listenAccountAndMarketState(
//     connection: Connection,
//     group: MangoGroup,
//     state: State,
//     stateRefreshInterval: number,
//     mdListeners: child_process.ChildProcess[]
// ) {
//     while (control.isRunning) {
//         try {
//             const inBasketOpenOrders = state.mangoAccount
//                 .getOpenOrdersKeysInBasket()
//                 .filter((pk) => !pk.equals(zeroKey));

//             const allAccounts = [
//                 group.mangoCache,
//                 state.mangoAccount.publicKey,
//                 ...inBasketOpenOrders,
//                 ...state.marketContexts.map(
//                     (marketContext) => marketContext.market.bids,
//                 ),
//                 ...state.marketContexts.map(
//                     (marketContext) => marketContext.market.asks,
//                 ),
//             ];

//             const ts = getUnixTs();
//             const accountInfos = await getMultipleAccounts(connection, allAccounts);

//             const cache = new MangoCache(
//                 accountInfos[0].publicKey,
//                 MangoCacheLayout.decode(accountInfos[0].accountInfo.data),
//             );

//             const mangoAccount = new MangoAccount(
//                 accountInfos[1].publicKey,
//                 MangoAccountLayout.decode(accountInfos[1].accountInfo.data),
//             );
//             const openOrdersAis = accountInfos.slice(
//                 2,
//                 2 + inBasketOpenOrders.length,
//             );
//             for (let i = 0; i < openOrdersAis.length; i++) {
//                 const ai = openOrdersAis[i];
//                 const marketIndex = mangoAccount.spotOpenOrders.findIndex((soo) =>
//                     soo.equals(ai.publicKey),
//                 );
//                 mangoAccount.spotOpenOrdersAccounts[marketIndex] =
//                     OpenOrders.fromAccountInfo(
//                         ai.publicKey,
//                         ai.accountInfo,
//                         group.dexProgramId,
//                     );
//             }

//             accountInfos
//                 .slice(
//                     2 + inBasketOpenOrders.length,
//                     2 + inBasketOpenOrders.length + state.marketContexts.length,
//                 )
//                 .forEach((ai, i) => {
//                     state.marketContexts[i].bids = new BookSide(
//                         ai.publicKey,
//                         state.marketContexts[i].market,
//                         BookSideLayout.decode(ai.accountInfo.data),
//                     );
//                 });

//             accountInfos
//                 .slice(
//                     2 + inBasketOpenOrders.length + state.marketContexts.length,
//                     2 + inBasketOpenOrders.length + 2 * state.marketContexts.length,
//                 )
//                 .forEach((ai, i) => {
//                     state.marketContexts[i].lastBookUpdate = ts;
//                     state.marketContexts[i].asks = new BookSide(
//                         ai.publicKey,
//                         state.marketContexts[i].market,
//                         BookSideLayout.decode(ai.accountInfo.data),
//                     );
//                 });

//             state.mangoAccount = mangoAccount;
//             state.cache = cache;
//             state.lastMangoAccountUpdate = ts;

//             const equity = mangoAccount.computeValue(group, cache).toNumber();
//             mdListeners.map((mdListener) => mdListener.send({ equity: equity }));
//         } catch (e) {
//             console.error(
//                 `${new Date().getUTCDate().toString()} failed when loading state`,
//                 e,
//             );
//         } finally {
//             await sleep(stateRefreshInterval);
//         }
//     }
// }

async function onExit(
    client: MangoClient,
    payer: Account,
    group: MangoGroup,
    mangoAccount: MangoAccount,
    marketContexts: MarketContext[],
) {
    await sleep(control.interval);
    mangoAccount = await client.getMangoAccount(
        mangoAccount.publicKey,
        group.dexProgramId,
    );
    let tx = new Transaction();
    const txProms: any[] = [];
    for (let i = 0; i < marketContexts.length; i++) {
        const mc = marketContexts[i];
        const cancelAllInstr = makeCancelAllPerpOrdersInstruction(
            mangoProgramId,
            group.publicKey,
            mangoAccount.publicKey,
            payer.publicKey,
            mc.market.publicKey,
            mc.market.bids,
            mc.market.asks,
            new BN(20),
        );
        tx.add(cancelAllInstr);
        if (tx.instructions.length === params.batch) {
            // txProms.push(client.sendTransaction(tx, payer, []));
            tx = new Transaction();
        }
    }

    if (tx.instructions.length) {
        // txProms.push(client.sendTransaction(tx, payer, []));
    }
    const txids = await Promise.all(txProms);
    txids.forEach((txid) => {
        console.log(`cancel successful: ${txid.toString()}`);
    });
    process.exit();
}

function startCancelling() {
    if (control.isRunning) {
        mainCancel().finally(startCancelling);
    }
}

process.on('unhandledRejection', function (err, promise) {
    console.error(
        'Unhandled rejection (promise: ',
        promise,
        ', reason: ',
        err,
        ').',
    );
});

startCancelling();
