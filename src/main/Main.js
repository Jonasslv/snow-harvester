const CONFIG = require('../../config/Config');
const ABI = require('../../config/abi.json');
const Web3 = require('web3');
const web3 = new Web3(new Web3.providers.HttpProvider('https://api.avax.network/ext/bc/C/rpc'));
const Util = require('./Util');

// Authenticate our wallet
if (!CONFIG.TEST_MODE) {
    web3.eth.accounts.wallet.add(CONFIG.WALLET.KEY);
    console.log(`WARNING!! Test mode is disabled. Real harvesting might begin!!`);
}

(async () => {
    const contracts = await initContracts(CONFIG.WANTS);

    // Execute once now
    loop();

    // Schedule main loop
    setInterval(loop, CONFIG.INTERVAL);

    function loop() {
        createHarvests(contracts)
            .then(addHarvestTx)
            .then(addHarvestGain)
            .then(addHarvestGas)
            .then(filterHarvestByCostVsGain)
            .then(doHarvesting)
            .then(logHarvestingResults)
            .catch(handleError);
    }

})();

async function initContracts(wantsAddresses) {
    const controllerContract = new web3.eth.Contract(ABI.CONTROLLER, CONFIG.CONTROLLER);

    const contractCache = [];
    for (const wantAddress of wantsAddresses) {
        // Simply wrapping these as arrays since the ABI specifies a single address, but cchain thinks they return address[]
        const snowglobeAddresses = [await controllerContract.methods.globes(wantAddress).call()];
        const strategyAddresses = [await controllerContract.methods.strategies(wantAddress).call()];

        if (snowglobeAddresses.some(a => !web3.utils.isAddress(a)) || strategyAddresses.some(a => !web3.utils.isAddress(a))) {
            continue;
        }

        contractCache.push({
            globes: snowglobeAddresses.map(a => new web3.eth.Contract(ABI.SNOWGLOBE, a)),
            strategies: strategyAddresses.map(a => new web3.eth.Contract(ABI.STRATEGY, a)),
        });
    }
    return contractCache;
}

function createHarvests(contracts) {
    const mapStrategyToHarvestable = async (strategyContract) => ({
        strategy: strategyContract,
        name: CONFIG.STRATEGY_NAME[strategyContract._address.toLowerCase()],
        harvestable: web3.utils.toBN(await strategyContract.methods.getHarvestable().call()),
        treasuryFee: web3.utils.toBN(await strategyContract.methods.performanceTreasuryFee().call()),
        treasuryMax: web3.utils.toBN(await strategyContract.methods.performanceTreasuryFee().call()),
    });
    const strategyContracts = contracts.map(c => c.strategies).reduce((output, strategies) => output.concat(strategies), []);
    return Promise.all(strategyContracts.map(mapStrategyToHarvestable))
        .catch(err => {
            console.error(`Error fetching information from strategy`);
            throw err;
        });
}

function addHarvestTx(harvests) {
    const addHarvestTx = async (harvest) => ({
        ...harvest,
        tx: harvest.strategy.methods.harvest(),
    });
    return Promise.all(harvests.map(addHarvestTx))
        .catch(err => {
            console.error(`Error adding harvest tx`);
            throw err;
        });
}

function addHarvestGain(harvests) {
    const addHarvestGain = async (harvest) => ({
        ...harvest,
        gainWAVAX: await convertPNGToWavax(harvest.harvestable),
        gainUSDT: await convertPNGToUSDT(harvest.harvestable),
    });
    return Promise.all(harvests.map(addHarvestGain))
        .catch(err => {
            console.error(`Error adding harvest gain`);
            throw err;
        });
}

function addHarvestGas(harvests) {
    const addHarvestGas = async (harvest) => ({
        ...harvest,
        gas: await harvest.tx.estimateGas({from: CONFIG.WALLET.ADDRESS}),
        gasPrice: await web3.eth.getGasPrice(),
    });
    return Promise.all(harvests.map(addHarvestGas))
        .catch(err => {
            console.error(`Error adding harvest gas`);
            throw err;
        });
}

function filterHarvestByCostVsGain(harvests) {
    return harvests.filter(harvest => {
        console.log(`Comparing gas cost vs. treasury gain for ${harvest.strategy._address}`);
        const costAsAvax = web3.utils.toBN(harvest.gas).mul(web3.utils.toBN(harvest.gasPrice));
        const treasuryGainAsAvax = harvest.gainWAVAX.mul(harvest.treasuryFee).div(harvest.treasuryMax);
        console.log(`Gas cost: ${Util.displayBNasFloat(costAsAvax, 18).toFixed(4)} AVAX`);
        console.log(`Treasury gain: ${Util.displayBNasFloat(treasuryGainAsAvax, 18).toFixed(4)} AVAX`);
        return costAsAvax.lt(treasuryGainAsAvax);
    });
}

async function doHarvesting(harvests) {
    const nonce = await web3.eth.getTransactionCount(CONFIG.WALLET.ADDRESS);
    const executeHarvestTx = async (harvest, i) => {
        if (CONFIG.TEST_MODE) return console.log(`Would have harvested strategy ${harvest.strategy._address}. Disable CONFIG.TEST_MODE to execute`);
        console.log(`Harvesting strategy address: ${harvest.strategy._address} ...`);
        return await harvest.tx.send({ from: CONFIG.WALLET.ADDRESS, gas: harvest.gas, gasPrice: harvest.gasPrice, nonce: nonce + i });
    };
    return Promise.allSettled(harvests.map(executeHarvestTx))
        .then(results => ({ results, harvests }));
}

function logHarvestingResults({ results, harvests }) {
    for (let i = 0; i< results.length; i++) {
        const {reason, value} = results[i];
        const harvest = harvests[i];
        if (value || CONFIG.TEST_MODE) {
            // Successfully called harvest()
            if (CONFIG.TEST_MODE) console.log(`---------- Disable CONFIG.TEST_MODE to execute the following ----------`);
            else console.log(`------------------------------------------------------------`);
            console.log(`Strategy:    ${value?.to ?? harvest.strategy._address} (${harvest.name})`);
            console.log(`Reinvested:  ${Util.displayBNasFloat(harvest.harvestable, 18).toFixed(2)} PNG ($${Util.displayBNasFloat(harvest.gainUSDT, 6).toFixed(2)})`);
            console.log(`Transaction: ${value?.transactionHash ?? '[real tx hash]'}`);
        } else {
            // Failed to execute harvest()
            console.error(`Failed to harvest for strategy ${value?.to ?? harvest.strategy._address} (${harvest.name})`);
            console.error(reason);
        }
    }
}

function handleError(err) {
    console.error(err);
    setTimeout(() => process.exit(1), 1000); // Ensure stderr has time to flush buffer
}


///// Helper functions


async function convertPNGToWavax(pngQuantity) {
    // Slimmed down ABI to just include the 'getReserves' method
    const PANGOLIN_PNG_WAVAX_POOL_ADDRESS = '0xd7538cabbf8605bde1f4901b47b8d42c61de0367';
    const pangolinPNGWAVAXContract = new web3.eth.Contract(ABI.PANGOLIN_POOL, PANGOLIN_PNG_WAVAX_POOL_ADDRESS);

    // reserve0 is PNG, reserve1 is WAVAX
    const { _reserve0, _reserve1 } = await pangolinPNGWAVAXContract.methods.getReserves().call();

    const reserveIn = web3.utils.toBN(_reserve0);
    const reserveOut = web3.utils.toBN(_reserve1);

    return Util.convertViaPool(pngQuantity, reserveIn, reserveOut);
}

async function convertPNGToUSDT(pngQuantity) {
    // Slimmed down ABI to just include the 'getReserves' method
    const PANGOLIN_PNG_USDT_POOL_ADDRESS = '0xe8acf438b10a2c09f80aef3ef2858f8e758c98f9';
    const pangolinPNGUSDTContract = new web3.eth.Contract(ABI.PANGOLIN_POOL, PANGOLIN_PNG_USDT_POOL_ADDRESS);

    // reserve0 is PNG, reserve1 is USDT
    const { _reserve0, _reserve1 } = await pangolinPNGUSDTContract.methods.getReserves().call();

    const reserveIn = web3.utils.toBN(_reserve0);
    const reserveOut = web3.utils.toBN(_reserve1);

    return Util.convertViaPool(pngQuantity, reserveIn, reserveOut);
}