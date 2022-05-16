import {
    Account,
    Commitment,
    Connection,
    PublicKey,
    Transaction,
} from '@solana/web3.js';
import fs from 'fs';
import os from 'os';
import {
    Cluster,
    Config,
    getMultipleAccounts,
    getPerpMarketByBaseSymbol,
    getUnixTs,
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
    SpotMarketConfig,
    sleep,
    zeroKey,
    getSpotMarketByBaseSymbol,
} from '@blockworks-foundation/mango-client';
import { Market, OpenOrders } from '@project-serum/serum';
import path from 'path';
import {
    loadMangoAccountWithName,
    loadMangoAccountWithPubkey,
    makeInitSequenceInstruction,
    seqEnforcerProgramId,
} from './utils';
import { findProgramAddressSync } from '@project-serum/anchor/dist/cjs/utils/pubkey';

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
    spotConfig: SpotMarketConfig,
    spotMarket: Market;
    marketIndex: number;

    sequenceAccount: PublicKey;
    sequenceAccountBump: number;
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
async function hedging() {
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

    const spotMarkets = await Promise.all(
        groupIds.spotMarkets.map((spotMarket) => {
            return Market.load(
                connection,
                spotMarket.publicKey,
                undefined,
                groupIds.serumProgramId,
            );
        }),
    );

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

        const spotMarketConfig = getSpotMarketByBaseSymbol(
            groupIds,
            baseSymbol
        ) as SpotMarketConfig;
        const spotMarket = spotMarkets.find((pm) =>
            pm.publicKey.equals(spotMarketConfig.publicKey),
        );
        if (spotMarket === undefined) {
            throw new Error('Cannot find spot market');
        }

        marketContexts.push({
            marketName: perpMarketConfig.name,
            params: params.assets[baseSymbol].perp,
            config: perpMarketConfig,
            market: perpMarket,
            spotConfig: spotMarketConfig,
            spotMarket: spotMarket,
            marketIndex: perpMarketConfig.marketIndex,

            sequenceAccount,
            sequenceAccountBump,
        });
    }
    initSeqEnfAccounts(client, marketContexts);
    const symbolToContext = Object.fromEntries(
        marketContexts.map((mc) => [mc.marketName, mc]),
    );

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
    );

    process.on('SIGINT', function () {
        console.log('Caught keyboard interrupt. Canceling orders');
        control.isRunning = false;
        onExit(client, payer, mangoGroup, mangoAccount, marketContexts);
    });

    while (control.isRunning) {
        try {
            mangoAccount = state.mangoAccount;
            let j = 0;
            let tx = new Transaction();
            console.log(`--- Begin Hedge ---`);
            for (let i = 0; i < marketContexts.length; i++) {
                const isHedge = marketContexts[i].params.isHedge === true ? true : false;
                if (isHedge) {
                    makeMarketUpdateInstructions(
                        mangoGroup,
                        state.cache,
                        mangoAccount,
                        marketContexts[i],
                        client,
                    );
                }
            }
        } catch (e) {
            console.log(e);
        } finally {
            console.log(`--- End Hedge ---`);
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

            state.mangoAccount = mangoAccount;
            state.cache = cache;
            state.lastMangoAccountUpdate = ts;
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

enum sideEnum {
    BID = "buy",
    ASK = "sell"
}

async function makeMarketUpdateInstructions(
    group: MangoGroup,
    cache: MangoCache,
    mangoAccount: MangoAccount,
    marketContext: MarketContext,
    client: MangoClient
) {
    // Right now only uses the perp
    const marketIndex = marketContext.marketIndex;
    const market = marketContext.market;
    const marketName = marketContext.marketName;

    const priceLotsToUiConvertor = market.priceLotsToUiConvertor;
    const priceLotsDecimals = priceLotsToUiConvertor.toString().length - (priceLotsToUiConvertor.toString().indexOf('.') + 1);

    const baseLotsToUiConvertor = market.baseLotsToUiConvertor;
    const baseLotsDecimals = baseLotsToUiConvertor.toString().length - (baseLotsToUiConvertor.toString().indexOf('.') + 1);

    const decimalNumber = marketContext.params.decimals;
    if (decimalNumber === undefined) {
        console.log('No decimals for this market');
        return [];
    }

    const perpAccount = mangoAccount.perpAccounts[marketIndex];
    const posPercentage = marketContext.params.posPercentage || 0.5;
    let perpBasePos = Number(perpAccount.getBasePositionUi(market).toFixed(decimalNumber)) * posPercentage;
    if (perpBasePos > 0) {
        perpBasePos = Math.floor(perpBasePos);
    } else {
        perpBasePos = Math.ceil(perpBasePos);
    }
    const spotBasePos = Number(mangoAccount
        .getUiDeposit(cache.rootBankCache[marketIndex], group, marketIndex)
        .sub(
            mangoAccount.getUiBorrow(
                cache.rootBankCache[marketIndex],
                group,
                marketIndex,
            ),
        ).toFixed(decimalNumber));

    console.log(`--- ${marketName} - posPercentage: ${posPercentage} ---`);

    const sum = perpBasePos + spotBasePos;
    let side: sideEnum;
    let size: number;
    if (sum !== 0) {
        // perp + spot !== 0
        if (perpBasePos === 0) {
            // perp === 0
            if (spotBasePos > 0) {
                // perp 0 - spot 10
                side = sideEnum.ASK;
                size = spotBasePos;
                console.log(`3. Side: ${side} - Size: ${size.toLocaleString()}`);
            } else {
                // perp 0 - spot (-10)
                side = sideEnum.BID;
                size = Math.abs(spotBasePos);
                console.log(`4. Side: ${side} - Size: ${size.toLocaleString()}`);
            }
        } else {
            // perp !== 0
            if (perpBasePos > 0) {
                // perp > 0
                if (spotBasePos === 0) {
                    // perp > 0
                    // perp === 10 - spot === 0
                    side = sideEnum.ASK;
                    size = perpBasePos;
                    console.log(`5. Side: ${side} - Size: ${size.toLocaleString()}`);
                } else {
                    // perp > 0
                    // perp > 0 && spot !== 0
                    if (spotBasePos > 0) {
                        // perp > 0
                        // perp > 0 && spot > 0
                        // perp === 10 && spot === 10 => sell 20
                        // perp === 10 && spot === 5 => sell 15
                        // perp === 10 && spot === 15 => sell 25
                        side = sideEnum.ASK;
                        size = sum;
                        console.log(`6,7,8. Side: ${side} - Size: ${size.toLocaleString()}`);
                    } else {
                        // perp > 0 && spot < 0
                        if (perpBasePos > Math.abs(spotBasePos)) {
                            // perp > 0
                            // spot < 0
                            // perp > Math.abs(spot)
                            // perp === 10 && spot === -5 => sell 5
                            side = sideEnum.ASK;
                            size = sum;
                            console.log(`9. Side: ${side} - Size: ${size.toLocaleString()}`);
                        } else {
                            // perp > 0
                            // spot < 0
                            // perp < Math.abs(spot)
                            // perp === 10 && spot === -15 => buy 5
                            side = sideEnum.BID;
                            size = Math.abs(sum);
                            console.log(`10. Side: ${side} - Size: ${size.toLocaleString()}`);
                        }
                    }
                }
            } else {
                // sum !== 0
                // perp !== 0
                // perp < 0
                if (Math.abs(perpBasePos) > spotBasePos) {
                    // perp === -10 && spot === 5 => buy 5
                    // perp === -10 && spot === 0 => buy 10
                    // perp === -10 && spot === -5 => buy 15
                    side = sideEnum.BID;
                    size = Math.abs(sum);
                    console.log(`11, 12. Side: ${side} - Size: ${size.toLocaleString()}`);
                } else {
                    // perp === -10 && spot === 15 => sell 5
                    side = sideEnum.ASK
                    size = sum;
                    console.log(`13. Side: ${side} - Size: ${size.toLocaleString()}`);
                }
            }
        }
        let price: number;
        const fairValue = group.getPrice(marketIndex, cache).toNumber();
        let charge: number = marketContext.params.charge || 0.005;
        if (charge > 0.01) {
            console.warn(`[Warning] Charge is larger than 1%`);
            charge = 0.01;
        }
        if (side === sideEnum.BID) {
            price = fairValue * (1 + charge);
        } else {
            price = fairValue * (1 - charge);
            if (price < 0) {
                price = 0;
            }
        }
        console.log(`Excute at price: ${price.toLocaleString()} - fairValue: ${fairValue.toLocaleString()} - charge: ${charge}`);
        client.placeSpotOrder(
            group,
            mangoAccount,
            group.mangoCache,
            marketContext.spotMarket,
            payer,
            side,
            price,
            size,
            'ioc',
        );
    } else {
        console.log(`1 & 2. Nothing`);
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
    process.exit();
}

function startHedge() {
    if (control.isRunning) {
        hedging().finally(startHedge);
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

startHedge();
