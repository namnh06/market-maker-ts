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
import { Context, Telegraf } from 'telegraf'
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
async function fullCheckHit() {
    console.log(`--- BEGIN CHECK HIT ---`);
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
        let message: string = "";
        try {
            const state = await loadAccountAndMarketState(
                connection,
                mangoGroup,
                mangoAccount,
                marketContexts,
            );
            mangoAccount = state.mangoAccount;
            let check: boolean = false;
            for (let i = 0; i < marketContexts.length; i++) {
                const marketMessage: string = checkHit(
                    mangoGroup,
                    state.cache,
                    mangoAccount,
                    marketContexts[i],
                    bot
                );
                if (marketMessage !== '') {
                    message += marketMessage;
                    check = true;
                }
            }
            if (check) {
                message += `\nAccount: ${mangoAccount.name} - ${mangoAccount.publicKey.toString()}`;
                console.log(message);
                if (globalThis.lastSendTelegram === undefined) {
                    bot.telegram.sendMessage(telegramChannelId, message);
                    globalThis.lastSendTelegram = Date.now() / 1000;
                } else if (((Date.now() / 1000) - globalThis.lastSendTelegram) > 30) {
                    bot.telegram.sendMessage(telegramChannelId, message);
                    globalThis.lastSendTelegram = Date.now() / 1000;
                }

            }
        } catch (e) {
            console.log(e);
        } finally {
            let timeSleep = control.interval;
            // console.log(
            //   `${new Date().toUTCString()} sleeping for ${timeSleep / 1000}s`,
            // );
            await sleep(timeSleep);
        }
    }
}

function checkHit(
    group: MangoGroup,
    cache: MangoCache,
    mangoAccount: MangoAccount,
    marketContext: MarketContext,
    bot
): string {

    // Right now only uses the perp
    const marketIndex = marketContext.marketIndex;
    const market = marketContext.market;
    const marketName = marketContext.marketName;

    const perpAccount = mangoAccount.perpAccounts[marketIndex];
    const priceLotsToUiConvertor = market.priceLotsToUiConvertor;
    const priceLotsDecimals = priceLotsToUiConvertor.toString().length - (priceLotsToUiConvertor.toString().indexOf('.') + 1);

    const baseLotsToUiConvertor = market.baseLotsToUiConvertor;
    const baseLotsDecimals = baseLotsToUiConvertor.toString().length - (baseLotsToUiConvertor.toString().indexOf('.') + 1);
    // TODO look at event queue as well for unprocessed fills
    const basePos = perpAccount.getBasePositionUi(market).toFixed(baseLotsDecimals);
    const baseSize = (marketContext.params.size || 0);
    if (basePos !== baseSize.toFixed(baseLotsDecimals)) {
        let marketMessage: string = "\n---";
        marketMessage += `\n${marketName}`;
        marketMessage += `\n${marketContext.marketName}`;
        marketMessage += `\nBase Position: ${basePos} - Base Size: ${baseSize}`;
        return marketMessage;
    }
    return '';
}

function startCheckHit() {
    if (control.isRunning) {
        fullCheckHit().finally(startCheckHit);
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

startCheckHit();