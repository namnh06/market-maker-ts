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
    percentageVolatility
} from './utils';
import { findProgramAddressSync } from '@project-serum/anchor/dist/cjs/utils/pubkey';
import { Context, Telegraf } from 'telegraf';

declare var lastSendTelegram: number;
declare var lastFairValue;

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

async function initSeqEnfAccounts(
    client: MangoClient,
    marketContexts: MarketContext[],
) {
    // Initialize all the sequence accounts
    const seqAccInstrs = marketContexts.map((mc) =>
        makeInitSequenceInstruction(
            mc.sequenceAccount,
            payer.publicKey,
            mc.sequenceAccountBump,
            mc.marketName,
        ),
    );
    const seqAccTx = new Transaction();
    seqAccTx.add(...seqAccInstrs);

    while (true) {
        try {
            const seqAccTxid = await client.sendTransaction(seqAccTx, payer, []);
        } catch (e) {
            console.log('failed to initialize sequence enforcer');
            console.log(e);
            continue;
        }
        break;
    }
}
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
    initSeqEnfAccounts(client, marketContexts);
    const symbolToContext = Object.fromEntries(
        marketContexts.map((mc) => [mc.marketName, mc]),
    );
    const mdListeners: child_process.ChildProcess[] = listenersArray(params.processes, Object.keys(params.assets)).map((assetArray) => {
        const listener = child_process.fork(require.resolve('./listen'), [assetArray.map((a) => `${a}-PERP`).join(',')]);
        listener.on('message', (m: ListenerMessage) => {
            symbolToContext[m.marketName].aggBid = m.aggBid;
            symbolToContext[m.marketName].aggAsk = m.aggAsk;
            symbolToContext[m.marketName].ftxMid = m.ftxMid;
        });
        return listener;
    })

    const state = await loadAccountAndMarketState(
        connection,
        mangoGroup,
        mangoAccount,
        marketContexts,
    );
    // listenState(client, state);
    const stateRefreshInterval = params.stateRefreshInterval || 500;
    listenAccountAndMarketState(
        connection,
        mangoGroup,
        state,
        stateRefreshInterval,
        mdListeners
    );

    process.on('SIGINT', function () {
        console.log('Caught keyboard interrupt. Canceling orders');
        control.isRunning = false;
        onExit(client, payer, mangoGroup, mangoAccount, marketContexts);
    });

    while (control.isRunning) {
        try {
            // client.cancelAllPerpOrders(mangoGroup, perpMarkets, mangoAccount, payer);

            // Customize Calculate Average TPS
            const selfConnection = new Connection(
                process.env.ENDPOINT_URL || config.cluster_urls[cluster]
            );
            const perfSamples = await selfConnection.getRecentPerformanceSamples(3);
            const averageTPS = Math.ceil(
                perfSamples.map((x) => x.numTransactions / x.samplePeriodSecs)
                    .reduce((a, b) => a + b, 0) / 3
            );

            mangoAccount = state.mangoAccount;
            let j = 0;
            let tx = new Transaction();
            for (let i = 0; i < marketContexts.length; i++) {
                if (marketContexts[i].params.isCancel) {
                    const instrSet = makeMarketUpdateInstructions(
                        mangoGroup,
                        state.cache,
                        mangoAccount,
                        marketContexts[i],
                        averageTPS,
                        bot,
                    );

                    if (instrSet.length > 0) {
                        instrSet.forEach((ix) => tx.add(ix));
                        j++;
                        if (j === params.batch) {
                            if (averageTPS < params.averageTPS) {
                                sendDupTxs(client, tx, [], 10);
                            } else {
                                client.sendTransaction(tx, payer, [], null);
                            }
                            tx = new Transaction();
                            j = 0;
                        }
                    }
                }
            }
            if (tx.instructions.length) {
                if (averageTPS < params.averageTPS) {
                    sendDupTxs(client, tx, [], 10);
                } else {
                    client.sendTransaction(tx, payer, [], null);
                }
            }
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

/**
 * Periodically fetch the account and market state
 */
async function listenAccountAndMarketState(
    connection: Connection,
    group: MangoGroup,
    state: State,
    stateRefreshInterval: number,
    mdListeners: child_process.ChildProcess[]
) {
    while (control.isRunning) {
        try {
            const inBasketOpenOrders = state.mangoAccount
                .getOpenOrdersKeysInBasket()
                .filter((pk) => !pk.equals(zeroKey));

            const allAccounts = [
                group.mangoCache,
                state.mangoAccount.publicKey,
                ...inBasketOpenOrders,
                ...state.marketContexts.map(
                    (marketContext) => marketContext.market.bids,
                ),
                ...state.marketContexts.map(
                    (marketContext) => marketContext.market.asks,
                ),
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
            const openOrdersAis = accountInfos.slice(
                2,
                2 + inBasketOpenOrders.length,
            );
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
                    2 + inBasketOpenOrders.length + state.marketContexts.length,
                )
                .forEach((ai, i) => {
                    state.marketContexts[i].bids = new BookSide(
                        ai.publicKey,
                        state.marketContexts[i].market,
                        BookSideLayout.decode(ai.accountInfo.data),
                    );
                });

            accountInfos
                .slice(
                    2 + inBasketOpenOrders.length + state.marketContexts.length,
                    2 + inBasketOpenOrders.length + 2 * state.marketContexts.length,
                )
                .forEach((ai, i) => {
                    state.marketContexts[i].lastBookUpdate = ts;
                    state.marketContexts[i].asks = new BookSide(
                        ai.publicKey,
                        state.marketContexts[i].market,
                        BookSideLayout.decode(ai.accountInfo.data),
                    );
                });

            state.mangoAccount = mangoAccount;
            state.cache = cache;
            state.lastMangoAccountUpdate = ts;

            const equity = mangoAccount.computeValue(group, cache).toNumber();
            mdListeners.map((mdListener) => mdListener.send({ equity: equity }));
        } catch (e) {
            console.error(
                `${new Date().getUTCDate().toString()} failed when loading state`,
                e,
            );
        } finally {
            await sleep(stateRefreshInterval);
        }
    }
}

function listenState(
    mangoClient: MangoClient,

    state: State,
) {
    const subscriptionId = mangoClient.connection.onAccountChange(
        state.mangoAccount.publicKey,
        (info) => {
            const decodedMangoAccount = MangoAccountLayout.decode(info?.data);
            state.mangoAccount = new MangoAccount(
                state.mangoAccount.publicKey,
                decodedMangoAccount,
            );
            state.lastMangoAccountUpdate = getUnixTs();
        },
        'processed',
    );

    for (const mc of state.marketContexts) {
        mangoClient.connection.onAccountChange(mc.market.bids, (info) => {
            mc.bids = new BookSide(
                mc.market.bids,
                mc.market,
                BookSideLayout.decode(info.data),
            );
            mc.lastBookUpdate = getUnixTs();
        });
        mangoClient.connection.onAccountChange(mc.market.asks, (info) => {
            mc.asks = new BookSide(
                mc.market.asks,
                mc.market,
                BookSideLayout.decode(info.data),
            );
            mc.lastBookUpdate = getUnixTs();
        });
    }
}

async function sendDupTxs(
    client: MangoClient,
    transaction: Transaction,
    signers: Account[],
    n: number,
) {
    await client.signTransaction({
        transaction,
        payer,
        signers,
    });

    const rawTransaction = transaction.serialize();
    const transactions: Promise<TransactionSignature>[] = [];
    for (let i = 0; i < n; i++) {
        transactions.push(
            client.connection.sendRawTransaction(rawTransaction, {
                skipPreflight: true,
            }),
        );
    }

    await Promise.all(transactions);
}

function makeMarketUpdateInstructions(
    group: MangoGroup,
    cache: MangoCache,
    mangoAccount: MangoAccount,
    marketContext: MarketContext,
    averageTPS: number,
    bot,

): TransactionInstruction[] {
    let message: string = '---';
    message += `\nCurrent TPS: ${averageTPS}`;
    message += `\n--- ${process.env.SERVER_IP || "No IP"} ---`;
    // Right now only uses the perp
    const marketIndex = marketContext.marketIndex;
    const market = marketContext.market;
    const marketName = marketContext.marketName;
    message += `\n${marketName}`;

    const priceLotsToUiConvertor = market.priceLotsToUiConvertor;
    const priceLotsDecimals = priceLotsToUiConvertor.toString().length - (priceLotsToUiConvertor.toString().indexOf('.') + 1);

    const baseLotsToUiConvertor = market.baseLotsToUiConvertor;
    const baseLotsDecimals = baseLotsToUiConvertor.toString().length - (baseLotsToUiConvertor.toString().indexOf('.') + 1);

    const bids = marketContext.bids;
    const asks = marketContext.asks;

    const aggBid = marketContext.aggBid;
    const aggAsk = marketContext.aggAsk;
    if (aggBid === undefined || aggAsk === undefined) {
        return [];
    }
    const fairValue: number = (aggBid + aggAsk) / 2;
    if (globalThis.lastFairValue === undefined) {
        globalThis.lastFairValue = [];
    }

    if (globalThis.lastFairValue[marketName] === undefined) {
        globalThis.lastFairValue[marketName] = fairValue;
    }

    const volatility = Math.abs(fairValue - globalThis.lastFairValue[marketName]);
    const volatilityPercentage = percentageVolatility(fairValue, globalThis.lastFairValue[marketName]);
    const aggSpread: number = (aggAsk - aggBid) / fairValue;

    let bidCharge = (marketContext.params.bidCharge || 0.05) + aggSpread / 2;
    let askCharge = (marketContext.params.askCharge || 0.05) + aggSpread / 2;
    if (averageTPS < 500 || volatilityPercentage > 0.5) {
        bidCharge += 0.01;
        askCharge += 0.01;
        message += `\nAverage TPS: ${averageTPS} < 500 || Volatility: ${volatilityPercentage.toFixed(2)} > 0.5`;
    } else if (averageTPS < 1000 || volatilityPercentage > 0.3) {
        bidCharge += 0.005;
        askCharge += 0.005;
        message += `\nAverage TPS: ${averageTPS} < 1000 || Volatility: ${volatilityPercentage.toFixed(2)} > 0.3`;
    } else if (averageTPS < 1500 || volatilityPercentage > 0.2) {
        bidCharge += 0.002;
        askCharge += 0.002;
        message += `\nAverage TPS: ${averageTPS} < 1500 || Volatility: ${volatilityPercentage.toFixed(2)} > 0.2`;
    }
    globalThis.lastFairValue[marketName] = fairValue;
    let bidPrice = fairValue * (1 - bidCharge);
    let askPrice = fairValue * (1 + askCharge);

    // Re-calculate Order Price if too volatility
    if (bidPrice > aggBid) {
        bidPrice = aggBid * (1 - bidCharge);
    }
    if (askPrice < aggAsk) {
        askPrice = aggAsk * (1 + askCharge);
    }

    // Start building the transaction
    const instructions: TransactionInstruction[] = [
        makeCheckAndSetSequenceNumberInstruction(
            marketContext.sequenceAccount,
            payer.publicKey,
            Math.round(getUnixTs() * 1000),
        ),
    ];

    const cancelAllInstr = makeCancelAllPerpOrdersInstruction(
        mangoProgramId,
        group.publicKey,
        mangoAccount.publicKey,
        payer.publicKey,
        market.publicKey,
        market.bids,
        market.asks,
        new BN(20),
    );

    const currentTimeInSecond = Date.now() / 1000;
    const timeToLive = marketContext.params.timeToLive || 3600;
    message += `\nBids Count: ${bids.leafCount} - Asks Count: ${asks.leafCount}`;
    const maxDepth = market.liquidityMiningInfo.maxDepthBps.toNumber() * baseLotsToUiConvertor;
    if (bids.leafCount < asks.leafCount) {
        let bidCount = 0;
        for (const bid of bids) {
            if (bidCount === 20) break;
            bidCount++;
            if (bid?.owner.toString() === mangoAccount.publicKey.toString()) {
                bidCount = 20;
                // Case 1: On OrderBook too long
                const diffInSeconds = currentTimeInSecond - bid?.timestamp.toNumber();
                if (diffInSeconds > timeToLive) {
                    const checkRoom = marketContext.params.checkRoom;
                    message += `\nCase 1: On OrderBook too long - time to live: ${timeToLive}`;
                    message += `\nCurrent Time: ${new Date(currentTimeInSecond * 1000).toLocaleString()}`;
                    message += `\nBid Time: ${new Date(bid?.timestamp.toNumber() * 1000).toLocaleString()}`;
                    message += `\nCheck Room: ${checkRoom}`
                    if (checkRoom === true) {
                        let cumulativeToBidPrice = 0;
                        for (const b of bids) {
                            // Ignore owner account
                            if (b.owner.toString() === mangoAccount.publicKey.toString()) {
                                break;
                            }
                            if (cumulativeToBidPrice > (maxDepth * marketContext.params.room)) {
                                break;
                            }
                            cumulativeToBidPrice += b.size;
                        }
                        message += `\nCumulative To Bid Price: ${cumulativeToBidPrice.toFixed(baseLotsDecimals)} - Max Depth: ${maxDepth} - Accept: ${maxDepth * marketContext.params.room}`;
                        // if (cumulativeToBidPrice < (maxDepth * marketContext.params.room)) {
                            message += `\nHas room to cancel.`;
                            instructions.push(cancelAllInstr);
                        // } else {
                        //     message += `\nNo room to cancel.`;
                        //     console.log(message);
                        // }
                    } else {
                        instructions.push(cancelAllInstr);
                    }
                } else if (bid.price > bidPrice || bid.price > aggBid) {
                    // Case 2: Bid is not good - might be hang
                    message += `\nCase 2: Bid is not good - might be hang`;
                    message += `\nFair Value: ${fairValue.toFixed(priceLotsDecimals)}`;
                    message += `\nBid Price: ${bidPrice.toFixed(priceLotsDecimals)} - Bidding: ${bid.price.toFixed(priceLotsDecimals)} - bidCharge: ${(bidCharge * 100).toFixed(2)}%`;
                    instructions.push(cancelAllInstr);
                }
            }
        }
    } else {
        let askCount = 0;
        for (const ask of asks) {
            if (askCount === 20) break;
            askCount++;
            if (ask?.owner.toString() === mangoAccount.publicKey.toString()) {
                askCount = 20;
                // Case 1: On OrderBook too long
                const diffInSeconds = currentTimeInSecond - ask?.timestamp.toNumber();
                if (diffInSeconds > timeToLive) {
                    const checkRoom = marketContext.params.checkRoom;
                    // Case 2: Ask is not good - might be hang
                    message += `\nCase 1: On OrderBook too long - time to live: ${timeToLive}`;
                    message += `\nCurrent Time: ${new Date(currentTimeInSecond * 1000).toLocaleString()}`;
                    message += `\nAsk Time: ${new Date(ask?.timestamp.toNumber() * 1000).toLocaleString()}`;
                    if (checkRoom === true) {
                        let cumulativeToAskPrice = 0;
                        for (const a of asks) {
                            // Ignore owner account
                            if (a.owner.toString() === mangoAccount.publicKey.toString()) {
                                break;
                            }
                            if (cumulativeToAskPrice > (maxDepth * marketContext.params.room)) {
                                break;
                            }
                            cumulativeToAskPrice += a.size;
                        }
                        message += `\nCumulative To Ask Price: ${cumulativeToAskPrice.toFixed(baseLotsDecimals)} - Max Depth: ${maxDepth} - Accept: ${maxDepth * marketContext.params.room}`;
                        // if (cumulativeToAskPrice < (maxDepth * marketContext.params.room)) {
                            message += `\nHas room to cancel.`;
                            instructions.push(cancelAllInstr);
                        // } else {
                            // message += `\nNo room to cancel.`;
                            // console.log(message);
                        // }
                    } else {
                        instructions.push(cancelAllInstr);
                    }
                } else if (ask.price < askPrice || ask.price < aggAsk) {
                    // Case 2: Ask is not good - might be hang
                    message += `\nCase 2: Ask is not good - might be hang`;
                    message += `\nFair Value: ${fairValue.toFixed(priceLotsDecimals)}`;
                    message += `\nAsk Price: ${askPrice.toFixed(priceLotsDecimals)} - Asking: ${ask.price.toFixed(priceLotsDecimals)} - askCharge: ${(askCharge * 100).toFixed(2)}%`;
                    instructions.push(cancelAllInstr);
                }
            }
        }
    }
    // if instruction is only the sequence enforcement, then just send empty
    if (instructions.length === 1) {
        return [];
    } else {
        message += `\nCancelling ...`;
        console.log(message);
        if (globalThis.lastSendTelegram === undefined) {
            bot.telegram.sendMessage(process.env.TELEGRAM_CHANNEL_ID, message);
            globalThis.lastSendTelegram = Date.now() / 1000;
        } else if (((Date.now() / 1000) - globalThis.lastSendTelegram) > 15) {
            bot.telegram.sendMessage(process.env.TELEGRAM_CHANNEL_ID, message);
            globalThis.lastSendTelegram = Date.now() / 1000;
        }
        return instructions;
    }
}

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
