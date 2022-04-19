import {
    Account,
    Commitment,
    Connection,
    PublicKey,
} from '@solana/web3.js';
import fs from 'fs';
import os from 'os';
import {
    BookSide,
    BookSideLayout,
    Cluster,
    Config,
    getMultipleAccounts,
    getPerpMarketByBaseSymbol,
    GroupConfig,
    IDS,
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
    loadMangoAccountWithPubkey
} from './utils';
import { Context, Telegraf } from 'telegraf';

declare var lastAccountEquity: number;

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
const telegramChannelId = process.env.TELEGRAM_CHANNEL_ID || '';

const groupIds = config.getGroupWithName(params.group) as GroupConfig;
if (!groupIds) {
    throw new Error(`Group ${params.group} not found`);
}
const cluster = groupIds.cluster as Cluster;
const mangoProgramId = groupIds.mangoProgramId;
const mangoGroupKey = groupIds.publicKey;

const control = { isRunning: true, interval: params.interval };

type MarketContext = {
    marketName: string;
    params: any;
    config: PerpMarketConfig;
    market: PerpMarket;
    marketIndex: number;
    bids: BookSide;
    asks: BookSide;
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
): Promise<{
    cache: MangoCache;
    mangoAccount: MangoAccount;
    marketContexts: MarketContext[];
}> {
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
            marketContexts[i].asks = new BookSide(
                ai.publicKey,
                marketContexts[i].market,
                BookSideLayout.decode(ai.accountInfo.data),
            );
        });

    return {
        cache,
        mangoAccount,
        marketContexts,
    };
}
async function fullScan() {
    console.log(`--- BEGIN FULL SCAN ---`);
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

    const marketContexts: MarketContext[] = [];
    for (const baseSymbol in params.assets) {
        const perpMarketConfig = getPerpMarketByBaseSymbol(
            groupIds,
            baseSymbol,
        ) as PerpMarketConfig;
        const perpMarket = await client.getPerpMarket(
            perpMarketConfig.publicKey,
            perpMarketConfig.baseDecimals,
            perpMarketConfig.quoteDecimals,
        );
        marketContexts.push({
            marketName: perpMarketConfig.name,
            params: params.assets[baseSymbol].perp,
            config: perpMarketConfig,
            market: perpMarket,
            marketIndex: perpMarketConfig.marketIndex,
            bids: await perpMarket.loadBids(connection),
            asks: await perpMarket.loadAsks(connection),
        });
    }

    process.on('SIGINT', function () {
        console.log('Caught keyboard interrupt. End');
        control.isRunning = false;
        onExit(bot);
    });

    // Create your bot and tell it about your context type
    while (control.isRunning) {
        const selfConnection = new Connection(
            process.env.ENDPOINT_URL || config.cluster_urls[cluster]
        );
        const perfSamples = await selfConnection.getRecentPerformanceSamples(3);
        const averageTPS = Math.ceil(
            perfSamples.map((x) => x.numTransactions / x.samplePeriodSecs)
                .reduce((a, b) => a + b, 0) / 3
        );

        try {
            const state = await loadAccountAndMarketState(
                connection,
                mangoGroup,
                mangoAccount,
                marketContexts,
            );
            mangoAccount = state.mangoAccount;
            let message: string = "";
            if (params.isFull === true) {
                message += "\n" + `--- SCAN FULL ---`;
                for (let i = 0; i < marketContexts.length; i++) {
                    const isScan = marketContexts[i].params.isScan === true ? true : false;
                    if (isScan) {
                        const marketMessage = scanFull(
                            mangoGroup,
                            state.cache,
                            mangoAccount,
                            marketContexts[i],
                            bot,
                            message
                        );
                        if (marketMessage !== "") {
                            message += "\n" + marketMessage;
                        }
                    }
                }
                message += "\n" + "---";
                message += "\n" + `Current Average TPS: ${averageTPS.toLocaleString()}`;
                const fairValue = mangoGroup.getPrice(0, state.cache).toNumber();
                const liquidityMiningReward = mangoAccount.mgnoAccruedValue(mangoGroup, state.cache).toNumber();
                message += "\n" + `MNGO Price: ${fairValue.toFixed(4)} - MNGO rewards: ${(liquidityMiningReward / fairValue).toFixed(2)} - $${liquidityMiningReward.toFixed(2)}`;
                message += "\n" + "---";
            }

            if (params.isIOC === true) {
                message += "\n" + `--- IMEDIATELY OR CANCEL ---`;
            }

            if (params.isNeutral === true) {
                message += "\n" + `--- DELTA NEUTRAL ---`;
                for (let i = 0; i < marketContexts.length; i++) {
                    if (marketContexts[i].params.isNeutral) {
                        const marketMessage = scanNeutral(
                            mangoGroup,
                            state.cache,
                            mangoAccount,
                            marketContexts[i],
                            bot,
                            message
                        );
                        if (marketMessage !== "") {
                            message += "\n" + marketMessage;
                        }
                    }
                }
                message += "\n" + "---";
            }

            const accountEquity: number = mangoAccount.getEquityUi(mangoGroup, state.cache) * 1000000;
            if (globalThis.lastAccountEquity === undefined) {
                globalThis.lastAccountEquity = accountEquity;
            }
            message += "\n" + `Last Account Equity: $${globalThis.lastAccountEquity.toLocaleString()}`;
            message += "\n" + `Current Account Equity: $${accountEquity.toLocaleString()}`;
            message += "\n" + `Difference In Account Equity: $${(accountEquity - globalThis.lastAccountEquity).toLocaleString()}`;
            message += "\n" + `--- END ---`;
            const quote = require('inspirational-quotes');
            message += "\n" + quote.getRandomQuote();
            console.log(message);
            bot.telegram.sendMessage(telegramChannelId, message);
            globalThis.lastAccountEquity = accountEquity;
        } catch (e) {
            console.log(e);
        } finally {
            let timeSleep = control.interval;
            // console.log(
            //     `${new Date().toUTCString()} sleeping for ${timeSleep / 1000}s`,
            // );
            await sleep(timeSleep);
        }
    }
}

function scanFull(
    group: MangoGroup,
    cache: MangoCache,
    mangoAccount: MangoAccount,
    marketContext: MarketContext,
    bot,
    message: string,
): string {
    let marketMessage: string = "";
    // Right now only uses the perp
    const marketIndex = marketContext.marketIndex;
    const market = marketContext.market;

    // TODO look at event queue as well for unprocessed fills
    const mngoPerPeriod = market.liquidityMiningInfo.mngoPerPeriod.toNumber();
    if (mngoPerPeriod > 0) {
        const fairValue = group.getPrice(marketIndex, cache).toNumber();

        const priceLotsToUiConvertor = market.priceLotsToUiConvertor;
        const priceLotsDecimals = priceLotsToUiConvertor.toString().length - (priceLotsToUiConvertor.toString().indexOf('.') + 1);

        const baseLotsToUiConvertor = market.baseLotsToUiConvertor;
        const baseLotsDecimals = baseLotsToUiConvertor.toString().length - (baseLotsToUiConvertor.toString().indexOf('.') + 1);
        const maxDepth = market.liquidityMiningInfo.maxDepthBps.toNumber() * baseLotsToUiConvertor;
        const maxDepthMax: number = marketContext.params.maxDepthMax || 0.6;
        const maxDepthAcceptable = maxDepth * maxDepthMax;
        const priceRange: number = marketContext.params.priceRange || 0.05;
        const bids = marketContext.bids;
        const bidPriceRange: number = fairValue * (1 - priceRange);
        let cumulativeBid: number = 0;
        for (const bid of bids) {
            if (bid.price <= bidPriceRange) {
                break;
            }
            cumulativeBid += bid.size;
        }

        const asks = marketContext.asks;
        const askPriceRange: number = fairValue * (1 + priceRange);
        let cumulativeAsk: number = 0;
        for (const ask of asks) {
            if (ask.price >= askPriceRange) {
                break;
            }
            cumulativeAsk += ask.size;
        }

        if (cumulativeBid < maxDepthAcceptable || cumulativeAsk < maxDepthAcceptable) {
            marketMessage += `---`;
            marketMessage += "\n" + `${marketContext.marketName}` +
                "\n" +
                `maxDepth: ${maxDepth.toLocaleString()} - ` +
                `cumulativeBid: ${cumulativeBid.toFixed(baseLotsDecimals)} - ` +
                `cumulativeAsk: ${cumulativeAsk.toFixed(baseLotsDecimals)}` +
                "\n" +
                `fairValue: ${fairValue.toFixed(priceLotsDecimals)} - ` +
                `bidPriceRange: ${bidPriceRange.toFixed(priceLotsDecimals)} - ` +
                `askPriceRange: ${askPriceRange.toFixed(priceLotsDecimals)}`;
        }
    }

    return marketMessage;
}

function scanNeutral(
    group: MangoGroup,
    cache: MangoCache,
    mangoAccount: MangoAccount,
    marketContext: MarketContext,
    bot,
    message: string,
): string {
    let marketMessage: string = "";
    // Right now only uses the perp
    const marketIndex = marketContext.marketIndex;
    const market = marketContext.market;

    // TODO look at event queue as well for unprocessed fills
    marketMessage += `---` + "\n" + `${marketContext.marketName}`;
    const currentFundingRate = market.getCurrentFundingRate(group, cache, marketIndex, marketContext.bids, marketContext.asks);
    marketMessage += "\n" + `1 hour funding rate: ${(currentFundingRate * 100).toFixed(4)}%`;
    marketMessage += "\n" + `APR funding rate: ${(currentFundingRate * 100 * 24 * 365).toFixed(2)}%`;
    return marketMessage;
}

function startScan() {
    if (control.isRunning) {
        fullScan().finally(startScan);
    }
}

async function onExit(
    bot,
) {
    console.log('Exiting ...');
    await sleep(control.interval);
    process.once('SIGINT', () => bot.stop('SIGINT'))
    process.once('SIGTERM', () => bot.stop('SIGTERM'))
    process.exit();
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

startScan();