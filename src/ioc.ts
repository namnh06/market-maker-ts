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
    makePlacePerpOrder2Instruction,
    MangoAccount,
    MangoAccountLayout,
    MangoCache,
    MangoCacheLayout,
    MangoClient,
    MangoGroup,
    I64_MAX_BN,
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

const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || "";
const telegramChannelId = process.env.TELEGRAM_CHANNEL_ID || "";

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
async function fullImmediatelyOrCancel() {
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
    const telegramBot = new Telegraf<MyContext>(telegramBotToken);

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
        control.isRunning = false;
        onExit();
    });
    while (control.isRunning) {
        try {
            mangoAccount = state.mangoAccount;
            let j = 0;
            let tx = new Transaction();
            for (let i = 0; i < marketContexts.length; i++) {
                const isTrade = marketContexts[i].params.isTrade;
                if (isTrade) {
                    const instrSet = makeMarketInstruction(
                        mangoGroup,
                        state.cache,
                        mangoAccount,
                        marketContexts[i],
                        telegramBot
                    );

                    if (instrSet.length > 0) {
                        instrSet.forEach((ix) => tx.add(ix));
                        j++;
                        if (j === params.batch) {
                            sendDupTxs(client, tx, [], 10);
                            // client.sendTransaction(tx, payer, [], null);
                            tx = new Transaction();
                            j = 0;
                            console.log('Having a good trade, breaking the loop now');
                            break;
                        }
                    }
                }
            }
            if (tx.instructions.length) {
                sendDupTxs(client, tx, [], 10);
                // client.sendTransaction(tx, payer, [], null);
            }
        } catch (e) {
            console.log(e);
        } finally {
            console.log(
                `${new Date().toUTCString()} sleeping for ${control.interval / 1000}s`,
            );
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

function makeMarketInstruction(
    group: MangoGroup,
    cache: MangoCache,
    mangoAccount: MangoAccount,
    marketContext: MarketContext,
    telegramBot
): TransactionInstruction[] {
    // Right now only uses the perp
    const marketIndex = marketContext.marketIndex;
    const market = marketContext.market;
    const bids = marketContext.bids;
    const asks = marketContext.asks;
    const equity = marketContext.params.equity;
    const quoteSize = equity;
    const aggBid = marketContext.aggBid;
    const aggAsk = marketContext.aggAsk;
    if (aggBid === undefined || aggAsk === undefined) {
        console.log(`${marketContext.marketName} No Agg Book`);
        return [];
    }

    const priceLotsToUiConvertor = market.priceLotsToUiConvertor;
    const priceLotsDecimals = priceLotsToUiConvertor.toString().length - (priceLotsToUiConvertor.toString().indexOf('.') + 1);

    const baseLotsToUiConvertor = market.baseLotsToUiConvertor;
    const baseLotsDecimals = baseLotsToUiConvertor.toString().length - (baseLotsToUiConvertor.toString().indexOf('.') + 1);

    const fairValue: number = (aggBid + aggAsk) / 2;
    const perpAccount = mangoAccount.perpAccounts[marketIndex];
    // TODO look at event queue as well for unprocessed fills
    const basePos = perpAccount.getBasePositionUi(market);

    const bidCharge = (marketContext.params.bidCharge || 0.05);
    const askCharge = (marketContext.params.askCharge || 0.05);

    let size = quoteSize / fairValue;

    const bestBid = bids.getBest();
    const bestAsk = asks.getBest();
    const bidPrice = fairValue * (1 - bidCharge);
    const askPrice = fairValue * (1 + askCharge);



    // TODO volatility adjustment
    // Start building the transaction
    const instructions: TransactionInstruction[] = [
        makeCheckAndSetSequenceNumberInstruction(
            marketContext.sequenceAccount,
            payer.publicKey,
            Math.round(getUnixTs() * 1000),
        ),
    ];

    const posAsTradeSizes = basePos / size;

    const valueAcceptable = marketContext.params.valueAcceptable || 50;
    let message: string = '';
    message += `--- [IOC] ${marketContext.marketName} ---`;
    message += `\nfairValue: ${fairValue.toFixed(priceLotsDecimals)} - size: ${size.toFixed(baseLotsDecimals)} - `
        + `aggBid: ${aggBid.toFixed(priceLotsDecimals)} - aggAsk: ${aggAsk.toFixed(priceLotsDecimals)}`;
    message += `\nbidPriceAcceptable: ${bidPrice.toFixed(priceLotsDecimals)} - `
        + `bestBid: ${bestBid?.price.toFixed(priceLotsDecimals)} - size: ${bestBid?.size.toFixed(baseLotsDecimals)}`;
    message += `\naskPriceAcceptable: ${askPrice.toFixed(priceLotsDecimals)} - `
        + `bestAsk: ${bestAsk?.price.toFixed(priceLotsDecimals)} - size: ${bestAsk?.size.toFixed(baseLotsDecimals)}`;

    // when bidding over asking - shorting
    if (
        bestBid !== undefined &&
        bestBid.price >= askPrice &&
        bestBid.price >= aggAsk &&
        (bestBid.price * bestBid.size) >= valueAcceptable
    ) {
        if (basePos !== 0) {
            if (basePos < 0) {
                // fairValue = 10
                // basePos = -5
                // size = 10
                // (100 - (-5*10))/10 => 150/10 => 15
                size = (equity - (Math.abs(basePos) * fairValue)) / fairValue;
            } else {
                // basePos = 5
                // size = 10
                // size = 15?
                size += basePos;
            }
        }

        const [modelBidPrice, nativeBidSize] = market.uiToNativePriceQuantity(
            askPrice,
            size,
        );
        const takerSell = makePlacePerpOrder2Instruction(
            mangoProgramId,
            group.publicKey,
            mangoAccount.publicKey,
            payer.publicKey,
            cache.publicKey,
            market.publicKey,
            market.bids,
            market.asks,
            market.eventQueue,
            mangoAccount.getOpenOrdersKeysInBasketPacked(),
            modelBidPrice,
            nativeBidSize,
            I64_MAX_BN,
            new BN(Date.now()),
            'sell',
            new BN(20),
            'ioc',
            basePos > 0 ? true : false
        );
        message += `\nTaker sell ${marketContext.marketName}`;
        message += `\nbestBidPrice: ${bestBid.price.toFixed(priceLotsDecimals)} - bestBidSize: ${bestBid.size.toFixed(baseLotsDecimals)} - total: ${(bestBid.price * bestBid.size).toFixed(priceLotsDecimals)}`;
        message += `\nacceptableAskPrice: ${askPrice.toFixed(priceLotsDecimals)} - basePos: ${basePos.toFixed(baseLotsDecimals)} - acceptableSize: ${size.toFixed(baseLotsDecimals)}`;
        if (posAsTradeSizes > -1) {
            message += `\nSelling ...`;
            console.log(message);
            instructions.push(takerSell);
        } else {
            message += `\nNo sell due to basePos: ${basePos.toFixed(baseLotsDecimals)} - size: ${(basePos * fairValue).toFixed(priceLotsDecimals)} >= ${size}`;
        }
        if (globalThis.lastSendTelegram === undefined) {
            telegramBot.telegram.sendMessage(telegramChannelId, message);
            globalThis.lastSendTelegram = Date.now() / 1000;
        } else if (((Date.now() / 1000) - globalThis.lastSendTelegram) > 30) {
            telegramBot.telegram.sendMessage(telegramChannelId, message);
            globalThis.lastSendTelegram = Date.now() / 1000;
        }
    }

    // when asking over bidding - longing
    if (
        bestAsk !== undefined &&
        bestAsk.price < bidPrice &&
        bestAsk.price < aggBid &&
        (bestAsk.price * bestAsk.size) >= valueAcceptable
    ) {
        if (basePos !== 0) {
            if (basePos > 0) {
                size = (equity - (Math.abs(basePos) * fairValue)) / fairValue;
            } else {
                size += Math.abs(basePos);
            }
        }

        const [modelAskPrice, nativeAskSize] = market.uiToNativePriceQuantity(
            bidPrice,
            size,
        );
        const takerBuy = makePlacePerpOrder2Instruction(
            mangoProgramId,
            group.publicKey,
            mangoAccount.publicKey,
            payer.publicKey,
            cache.publicKey,
            market.publicKey,
            market.bids,
            market.asks,
            market.eventQueue,
            mangoAccount.getOpenOrdersKeysInBasketPacked(),
            modelAskPrice,
            nativeAskSize,
            I64_MAX_BN,
            new BN(Date.now()),
            'buy',
            new BN(20),
            'ioc',
            basePos < 0 ? true : false
        );
        message += `\nTaker buy ${marketContext.marketName}`;
        message += `\nbestAskPrice: ${bestAsk.price.toFixed(priceLotsDecimals)} - bestAskSize: ${bestAsk.size.toFixed(baseLotsDecimals)} - total: ${(bestAsk.price * bestAsk.size).toFixed(priceLotsDecimals)}`;
        message += `\nacceptableBidPrice: ${bidPrice.toFixed(priceLotsDecimals)} - basePos: ${basePos.toFixed(baseLotsDecimals)} - acceptableSize: ${size.toFixed(baseLotsDecimals)}`;
        if (posAsTradeSizes < 1) {
            message += `\nBuying ...`;
            console.log(message);
            instructions.push(takerBuy);
        } else {
            message += `\nNo buy due to basePos: ${basePos.toFixed(baseLotsDecimals)} - size: ${(basePos * fairValue).toFixed(priceLotsDecimals)} >= ${size}`;
        }
        if (globalThis.lastSendTelegram === undefined) {
            telegramBot.telegram.sendMessage(telegramChannelId, message);
            globalThis.lastSendTelegram = Date.now() / 1000;
        } else if (((Date.now() / 1000) - globalThis.lastSendTelegram) > 30) {
            telegramBot.telegram.sendMessage(telegramChannelId, message);
            globalThis.lastSendTelegram = Date.now() / 1000;
        }
    }
    // console.log(message);
    // if instruction is only the sequence enforcement, then just send empty
    if (instructions.length === 1) {
        return [];
    } else {
        return instructions;
    }
}

async function onExit() {
    process.exit();
}

function startImmediatelyOrCancel() {
    if (control.isRunning) {
        fullImmediatelyOrCancel().finally(startImmediatelyOrCancel);
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

startImmediatelyOrCancel();
