const ethers = require('ethers')
const pako = require('pako')
require('colors')
require('dotenv').config()

const NETWORK = process.env.NETWORK || 'goerli'
const ETH_RPC = process.env.ETH_RPC || ''

let rocketStorage, hotfixAddress
switch (NETWORK) {
  case 'goerli':
    rocketStorage = '0xd8Cd47263414aFEca62d6e2a3917d6600abDceB3'
    hotfixAddress = '0x52480c793374c6d8065824f174d8b4856bfb5106'
    break
  case 'mainnet':
    rocketStorage = '0x1d8f8f00cfa6758d7bE78336684788Fb0ee0Fa46'
    hotfixAddress = 'tba'
    console.error(`Mainnet hotfix not yet deployed`)
    process.exit(1)
    break
  default:
    console.error(`Invalid network ${process.env.NETWORK}`)
    process.exit(1)
}

const provider = new ethers.providers.JsonRpcProvider(ETH_RPC)

const errors = []

async function getContract (name) {
  const storage = new ethers.Contract(rocketStorage, [
    'function getAddress(bytes32) external view returns (address)',
    'function getString(bytes32) external view returns (string memory)',
  ], provider)

  const [address, abi] = await Promise.all([
    storage.getAddress(ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes(`contract.address${name}`))),
    storage.getString(
      ethers.utils.keccak256(ethers.utils.toUtf8Bytes(`contract.abi${name}`))),
  ])

  const abiBuffer = Buffer.from(abi, 'base64')
  const abiDecoded = pako.inflate(abiBuffer, { to: 'string' })

  return new ethers.Contract(address, JSON.parse(abiDecoded), provider)
}

async function getNodeFeeNumerator (nodeAddress) {
  const storage = new ethers.Contract(rocketStorage, [
    'function getUint(bytes32) external view returns (uint256)',
  ], provider)
  const key = ethers.utils.solidityPack(['string', 'address'],
    ['node.average.fee.numerator', nodeAddress])
  return storage.getUint(ethers.utils.keccak256(key))
}

async function calculateCorrectNumerator (node, minipoolManager) {
  const count = await minipoolManager.getNodeMinipoolCount(node)

  let numerator = ethers.BigNumber.from('0')

  for (let i = 0; i < count; i++) {
    const minipoolAddress = await minipoolManager.getNodeMinipoolAt(node, i)
    const minipool = new ethers.Contract(minipoolAddress, [
      'function getNodeFee() external view returns (uint256)',
      'function getStatus() external view returns (uint8)',
    ], provider)
    const status = await minipool.getStatus()

    // Has to be staking status
    if (status === 2) {
      numerator = numerator.add(await minipool.getNodeFee())
    }
  }

  return numerator
}

async function checkNode (index, node, nodeManager, minipoolManager) {
  const initialised = await nodeManager.getFeeDistributorInitialised(node)

  if (!initialised) {
    return
  }

  const [numerator, expectedNumerator] = await Promise.all([
    getNodeFeeNumerator(node),
    calculateCorrectNumerator(node, minipoolManager),
  ])

  if (!numerator.eq(expectedNumerator)) {
    const difference = expectedNumerator.sub(numerator)
    errors.push({
      address: node,
      error: difference.toString(),
      verified: false,
    })
  }
}

async function collectErrors () {
  const minipoolManager = await getContract('rocketMinipoolManager')
  const nodeManager = await getContract('rocketNodeManager')

  const count = await nodeManager.getNodeCount()

  console.log(`Checking ${count} nodes, this could take a while...`)

  for (let i = 0; i < count; i++) {
    const node = await nodeManager.getNodeAt(i)
    await checkNode(i, node, nodeManager, minipoolManager)

    if ((i+1) % 100 === 0) {
      console.log(`Checked ${i + 1} of ${count}`)
    }
  }

  console.log(`Found ${errors.length} errors`)
}

async function verifyErrors () {
  console.log('Verifying hotfix errors...')

  const hotfixContract = new ethers.Contract(hotfixAddress, [
    'function errorCount() view returns (uint256)',
    'function errors(uint256) view returns ((address,int256))',
  ], provider)

  const count = (await hotfixContract.errorCount()).toNumber()

  let verified = true

  if (count !== errors.length) {
    console.error(
      `❌ Incorrect number of errors: ${count}. Should be ${errors.length}.`.red)
    verified = false
  } else {
    console.log(
      `✓ Correct number of errors: ${count}`.green)
  }

  for (let i = 0; i < count; i++) {
    const [address, amount] = await hotfixContract.errors(i)

    const errorIndex = errors.findIndex(error => error.address === address)

    if (errorIndex === -1) {
      console.error(
        `❌ Unknown error in hotfix. ${address} = ${amount}`.red)
      verified = false
    } else if (errors[errorIndex].error !== amount.toString()) {
      console.error(
        `❌ Invalid error amount found. ${address} = ${amount}, should be ${errors[errorIndex].error}`.red)
      verified = false
    } else {
      errors[errorIndex].verified = true
    }
  }

  for(const error of errors) {
    if (!error.verified) {
      console.error(
        `❌ Error not found in hotfix. ${error.address} = ${error.error}`.red)
      verified = false
    }
  }

  if(verified) {
    console.log(
      `✓ Hotfix at ${hotfixAddress} is correct`.green)
  } else {
    console.error(
      `❌ Hotfix at ${hotfixAddress} is incorrect`.red)
  }
}

async function go () {
  await collectErrors()
  await verifyErrors()

  provider.destroy()
  console.log('Done')
}

go()
