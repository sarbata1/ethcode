import { type ExtensionContext, window, workspace, type InputBoxOptions } from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
import * as toml from 'toml'
import { logger } from '../lib'
import { type CompiledJSONOutput, type IFunctionQP } from '../types'
import {
  createERC4907ContractFile,
  createERC4907ContractInterface,
  createUserERC4907ContractFile,
  getDirectoriesRecursive
} from '../lib/file'
import {
  createConstructorInput,
  createFunctionInput,
  createDeployed,
  isHardhatProject,
  isFoundryProject
} from './functions'
import { ERC4907ContractUrls } from '../contracts/ERC4907/ERC4907'

const parseBatchCompiledJSON = async (context: ExtensionContext): Promise<void> => {
  if (workspace.workspaceFolders === undefined) {
    logger.error(new Error('Please open your solidity project to vscode'))
    return
  }

  logger.log('Loading all compiled jsons...')
  try {
    void context.workspaceState.update('contracts', '') // Initialize contracts storage with empty string

    const path_ = workspace.workspaceFolders[0].uri.fsPath
    const paths: string[] = await loadAllCompiledJsonOutputs(path_)
    paths.forEach((e) => {
      let name = path.parse(e).base
      name = name.substring(0, name.length - 5)

      logger.log(`Trying to parse ${name} contract output...`)

      const data = fs.readFileSync(e)
      const output: CompiledJSONOutput = getCompiledJsonObject(data)

      if (output.contractType === 0) return
      output.path = path.dirname(e)
      output.name = name

      logger.success(`Loaded ${name} contract into workspace.`)
      let contracts: any = context.workspaceState.get('contracts')

      if (contracts === undefined || contracts === '') contracts = {}

      contracts[name] = output
      void context.workspaceState.update('contracts', contracts)
    })
  } catch (e) {
    logger.log("No compiled contract found. Make sure you've compiled your contracts.")
  }
}

// Parse Combined JSON payload
const parseCompiledJSONPayload = (
  context: ExtensionContext,
  _jsonPayload: any
): void => {
  if (_jsonPayload !== undefined) {
    const output = getCompiledJsonObject(_jsonPayload)
    if (output.contractType !== 0) { void context.workspaceState.update('contract', output) }
  } else {
    logger.error(
      Error(
        'Could not load JSON file. Make sure it follows Solidity output description. Know more: https://docs.soliditylang.org/en/latest/using-the-compiler.html#compiler-input-and-output-json-description.'
      )
    )
  }
}

const getCompiledJsonObject = (_jsonPayload: any): CompiledJSONOutput => {
  const output: CompiledJSONOutput = { contractType: 0 }

  try {
    const data = JSON.parse(_jsonPayload)

    if (data.bytecode !== undefined) {
      // Hardhat format

      output.contractType = 1
      output.hardhatOutput = data
      logger.log('Loaded Hardhat compiled json outputs.')
    } else if (data.data !== undefined) {
      // Remix format

      output.contractType = 2
      output.remixOutput = data
      logger.log('Loaded Remix compiled json output.')
    } else if (data.abi !== undefined && data.evm !== undefined) {
      // Foundry format
      output.contractType = 3
      output.foundryOutput = data
      logger.log('Loaded Foundry compiled json output.')
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    logger.error(e)
  }

  return output
}

/**
 * @dev return file paths with possibility of solidity compiled output jsons
 */
const loadAllCompiledJsonOutputs: any = async (path_: string) => {
  logger.log('Loading all compiled jsons outputs...')
  let allFiles

  if (await isFoundryProject()) {
    const foundryConfigFile = await workspace.findFiles('**/foundry.toml', '**/{node_modules,lib}/**')
    if (foundryConfigFile.length > 0) {
      const file = await workspace.fs.readFile(foundryConfigFile[0])
      const foundryConfig = toml.parse(file.toString())
      
      // Handle different Foundry output directory configurations
      let outDir = 'out'
      if (foundryConfig.profile && foundryConfig.profile.default && foundryConfig.profile.default.out) {
        outDir = foundryConfig.profile.default.out
      } else if (foundryConfig.out) {
        outDir = foundryConfig.out
      }
      
      logger.log(`Foundry output directory: ${outDir}`)
      allFiles = getDirectoriesRecursive(
        path.join(path_, outDir),
        0
      )
    } else {
      // Fallback to default Foundry output directory
      allFiles = getDirectoriesRecursive(
        path.join(path_, 'out'),
        0
      )
    }
  } else if (isHardhatProject(path_)) {
    allFiles = getDirectoriesRecursive(
      path.join(path_, 'artifacts', 'contracts'),
      0
    )
  } else allFiles = getDirectoriesRecursive(path_, 0)

  const changedFiles = allFiles.filter((e: any) => {
    let fileName = path.parse(e).base
    fileName = fileName.substring(0, fileName.length - 5)
    if (!fileName.includes('.')) return true
    return false
  })

  return changedFiles
}

const selectContract: any = (context: ExtensionContext) => {
  try {
    const contracts = context.workspaceState.get('contracts') as Record<string, CompiledJSONOutput>

    if (contracts === undefined || Object.keys(contracts).length === 0) {
      logger.log('No contracts found. Please load your compiled contract.')
      return
    }

    const quickPick = window.createQuickPick<IFunctionQP>()
    if (contracts === undefined || Object.keys(contracts).length === 0) return

    quickPick.items = Object.keys(contracts).map((f) => ({
      label: f,
      functionKey: f
    }))
    quickPick.placeholder = 'Select a contract.'
    quickPick.onDidChangeSelection(() => {
      try {
        const selection = quickPick.selectedItems[0]
        if ((selection != null) && (workspace.workspaceFolders != null)) {
          const { functionKey } = selection
          quickPick.dispose()
          // get selected contract
          const name = Object.keys(contracts).filter(
            (i: string) => i === functionKey
          )
          const contract: CompiledJSONOutput = contracts[name[0]]
          void context.workspaceState.update('contract', contract)

          // Create a constructor input at the same time
          createConstructorInput(contract)
          createFunctionInput(contract)
          createDeployed(contract)

          logger.success(`Contract ${name[0]} is selected.`)
        }
      } catch (error) {
        logger.error(`Error during contract selection: ${error}`)
      }
    })
    quickPick.onDidHide(() => { quickPick.dispose() })
    quickPick.show()
  } catch (error) {
    logger.error(`Error in selectContract: ${error}`)
  }
}

const createERC4907Contract: any = async (context: ExtensionContext) => {
  const path_: any =
    workspace.workspaceFolders?.[0].uri.fsPath
  const inputOptions: InputBoxOptions = {
    ignoreFocusOut: true,
    placeHolder: 'Name your contract'
  }
  const contractName = await window.showInputBox(inputOptions)
  const dir = path.join(path_.toString(), 'contracts', contractName as string)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  const contractPath = path.join(dir, `${contractName as string}.sol`)
  const interfacepath = path.join(dir, 'IERC4907.sol')
  const ERC4907ContractPath = path.join(dir, 'ERC4907.sol')
  await createUserERC4907ContractFile(
    contractPath,
    ERC4907ContractUrls.contract,
    contractName as string
  )
  await createERC4907ContractInterface(
    interfacepath,
    ERC4907ContractUrls.interface
  )
  await createERC4907ContractFile(
    ERC4907ContractPath,
    ERC4907ContractUrls.ERC4907Contract
  )
}

export {
  parseBatchCompiledJSON,
  parseCompiledJSONPayload,
  selectContract,
  createERC4907Contract
}
