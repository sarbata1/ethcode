import { type ExtensionContext, window, workspace, type InputBoxOptions } from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
import * as toml from 'toml'
import { logger } from '../lib'
import { type CompiledJSONOutput, type IFunctionQP } from '../types'

/**
 * Centralized Foundry configuration parser
 * Reads foundry.toml from the current workspace and extracts configuration
 */
const parseFoundryConfig = async (): Promise<{ outDir: string; config: any } | null> => {
  try {
    if (!workspace.workspaceFolders || workspace.workspaceFolders.length === 0) {
      return null
    }

    const workspacePath = workspace.workspaceFolders[0].uri.fsPath
    const foundryConfigPath = path.join(workspacePath, 'foundry.toml')
    
    if (!fs.existsSync(foundryConfigPath)) {
      return null
    }

    const configFile = fs.readFileSync(foundryConfigPath, 'utf8')
    
    // Try to parse with the TOML library first
    let foundryConfig: any
    try {
      foundryConfig = toml.parse(configFile)
    } catch (tomlError) {
      // If TOML parsing fails, try a simple regex-based approach for just the output directory
      logger.log(`TOML parsing failed, using fallback parser: ${tomlError}`)
      foundryConfig = parseFoundryConfigFallback(configFile)
    }
    
    // Extract output directory with proper precedence
    let outDir = 'out' // default Foundry output directory
    
    if (foundryConfig.profile && foundryConfig.profile.default && foundryConfig.profile.default.out) {
      outDir = foundryConfig.profile.default.out
    } else if (foundryConfig.out) {
      outDir = foundryConfig.out
    }
    
    logger.log(`Foundry configuration loaded: output directory = ${outDir}`)
    
    return {
      outDir,
      config: foundryConfig
    }
  } catch (error) {
    logger.error(`Error parsing foundry.toml: ${error}`)
    return null
  }
}

/**
 * Fallback parser for foundry.toml when TOML library fails
 * Uses regex to extract just the output directory
 */
const parseFoundryConfigFallback = (configContent: string): any => {
  const config: any = {}
  
  // Look for [profile.default] section
  const profileDefaultMatch = configContent.match(/\[profile\.default\][\s\S]*?(?=\[|$)/)
  if (profileDefaultMatch) {
    const profileSection = profileDefaultMatch[0]
    
    // Extract out directory from profile.default section
    const outMatch = profileSection.match(/out\s*=\s*['"]([^'"]+)['"]/)
    if (outMatch) {
      config.profile = {
        default: {
          out: outMatch[1]
        }
      }
    }
  }
  
  // Also check for root-level out setting
  const rootOutMatch = configContent.match(/^out\s*=\s*['"]([^'"]+)['"]/m)
  if (rootOutMatch && !config.profile) {
    config.out = rootOutMatch[1]
  }
  
  return config
}
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

/**
 * Parse Foundry compiled JSON contracts specifically
 * This function is dedicated to loading Foundry compiled contracts with proper error handling
 */
const parseFoundryCompiledJSON = async (context: ExtensionContext): Promise<void> => {
  if (workspace.workspaceFolders === undefined) {
    logger.error(new Error('Please open your solidity project to vscode'))
    return
  }

  logger.log('Loading compiled contracts...')
  
  try {
    // Check if this is a Foundry project
    const isFoundry = await isFoundryProject()
    if (!isFoundry) {
      logger.error(new Error('This is not a Foundry project. Please run this command in a Foundry project directory or ensure foundry.toml exists.'))
      return
    }

    // Parse foundry.toml configuration
    const foundryConfig = await parseFoundryConfig()
    if (!foundryConfig) {
      logger.error(new Error('Foundry configuration file (foundry.toml) not found. Please ensure this is a valid Foundry project.'))
      return
    }

    const { outDir } = foundryConfig
    logger.log(`Foundry output directory: ${outDir}`)

    // Check if output directory exists
    const path_ = workspace.workspaceFolders[0].uri.fsPath
    const outPath = path.join(path_, outDir)
    
    if (!fs.existsSync(outPath)) {
      logger.error(new Error(`Foundry output directory '${outDir}' not found. Please compile your contracts first using 'forge build'`))
      return
    }

    // Initialize contracts storage
    void context.workspaceState.update('contracts', {})

    // Load all JSON files from the output directory
    const jsonFiles = getDirectoriesRecursive(outPath, 0)
    logger.log(`Found ${jsonFiles.length} total JSON files in ${outDir} directory`)
    
    const contractFiles = jsonFiles.filter((filePath: string) => {
      const fileName = path.parse(filePath).base
      const nameWithoutExt = fileName.substring(0, fileName.length - 5)
      
      // Skip files with dots in name (library files)
      if (nameWithoutExt.includes('.')) {
        logger.log(`Skipping ${fileName}: Library file (contains dots)`)
        return false
      }
      
      // Skip files that are likely not contracts (build info, cache, etc.)
      if (nameWithoutExt.length === 16 && /^[a-f0-9]{16}$/.test(nameWithoutExt)) {
        // This looks like a hash/ID file, likely not a contract
        logger.log(`Skipping ${fileName}: Hash/ID file (16-character hex)`)
        return false
      }
      
      // Skip common non-contract files
      const skipPatterns = ['build-info', 'cache', 'metadata', 'storage-layout']
      if (skipPatterns.some(pattern => fileName.toLowerCase().includes(pattern))) {
        logger.log(`Skipping ${fileName}: Non-contract file (contains ${skipPatterns.find(p => fileName.toLowerCase().includes(p))})`)
        return false
      }
      
      return true
    })

    if (contractFiles.length === 0) {
      logger.error(new Error(`No compiled contract files found in '${outDir}' directory. Please compile your contracts using 'forge build'`))
      return
    }

    logger.log(`Found ${contractFiles.length} compiled contract files (filtered from ${jsonFiles.length} total JSON files)`)

    // Parse each contract file
    let loadedContracts = 0
    for (const filePath of contractFiles) {
      try {
        const fileName = path.parse(filePath).base
        const contractName = fileName.substring(0, fileName.length - 5)

        logger.log(`Parsing Foundry contract: ${contractName}`)

        const fileData = fs.readFileSync(filePath, 'utf8')
        const jsonData = JSON.parse(fileData)

        // Validate Foundry format - check for both possible structures
        if (!jsonData.abi) {
          logger.log(`Skipping ${contractName}: Missing ABI field`)
          continue
        }
        
        // Check if this is a Foundry format (has evm field) or Hardhat format (has bytecode field)
        if (!jsonData.evm && !jsonData.bytecode) {
          logger.log(`Skipping ${contractName}: Not a valid compiled contract format (missing evm or bytecode)`)
          continue
        }

        // Determine contract type based on format
        let contractType: number
        let outputData: any
        
        if (jsonData.evm) {
          // Foundry format
          contractType = 3
          outputData = jsonData
        } else if (jsonData.bytecode) {
          // Hardhat format - convert to Foundry format for compatibility
          contractType = 3
          outputData = {
            abi: jsonData.abi,
            bytecode: {
              object: jsonData.bytecode,
              sourceMap: '',
              linkReferences: {}
            },
            deployedBytecode: {
              object: jsonData.deployedBytecode || jsonData.bytecode,
              sourceMap: '',
              linkReferences: {}
            },
            evm: {
              bytecode: {
                object: jsonData.bytecode,
                sourceMap: '',
                linkReferences: {}
              },
              deployedBytecode: {
                object: jsonData.deployedBytecode || jsonData.bytecode,
                sourceMap: '',
                linkReferences: {}
              }
            }
          }
        } else {
          logger.log(`Skipping ${contractName}: Unknown contract format`)
          continue
        }

        const output: CompiledJSONOutput = {
          contractType: contractType,
          foundryOutput: outputData,
          path: path.dirname(filePath),
          name: contractName
        }

        // Store contract in workspace state
        let contracts: any = context.workspaceState.get('contracts')
        if (!contracts) contracts = {}
        
        contracts[contractName] = output
        void context.workspaceState.update('contracts', contracts)

        const formatType = jsonData.evm ? 'Foundry' : 'Hardhat'
        logger.success(`Successfully loaded ${formatType} contract: ${contractName}`)
        loadedContracts++

      } catch (parseError) {
        logger.error(new Error(`Failed to parse contract file ${filePath}: ${parseError}`))
      }
    }

    if (loadedContracts === 0) {
      logger.error(new Error('No valid compiled contracts were loaded. Please check your compilation output.'))
    } else {
      logger.success(`Successfully loaded ${loadedContracts} compiled contracts`)
    }

  } catch (error) {
    logger.error(new Error(`Error loading Foundry contracts: ${error}`))
  }
}

/**
 * Parse Hardhat compiled JSON contracts specifically
 * This function is dedicated to loading Hardhat compiled contracts with proper error handling
 */
const parseHardhatCompiledJSON = async (context: ExtensionContext): Promise<void> => {
  if (workspace.workspaceFolders === undefined) {
    logger.error(new Error('Please open your solidity project to vscode'))
    return
  }

  logger.log('Loading Hardhat compiled contracts...')
  
  try {
    const path_ = workspace.workspaceFolders[0].uri.fsPath
    
    // Check if this is a Hardhat project
    if (!isHardhatProject(path_)) {
      logger.error(new Error('This is not a Hardhat project. Please run this command in a Hardhat project directory.'))
      return
    }

    // Check if artifacts directory exists
    const artifactsPath = path.join(path_, 'artifacts', 'contracts')
    if (!fs.existsSync(artifactsPath)) {
      logger.error(new Error("Hardhat artifacts directory not found. Please compile your contracts first using 'npx hardhat compile'"))
      return
    }

    // Initialize contracts storage
    void context.workspaceState.update('contracts', {})

    // Load all JSON files from the artifacts directory
    const jsonFiles = getDirectoriesRecursive(artifactsPath, 0)
    const contractFiles = jsonFiles.filter((filePath: string) => {
      const fileName = path.parse(filePath).base
      const nameWithoutExt = fileName.substring(0, fileName.length - 5)
      // Filter out files with dots in name (avoiding library files)
      return !nameWithoutExt.includes('.')
    })

    if (contractFiles.length === 0) {
      logger.error(new Error("No compiled contract files found in 'artifacts/contracts' directory. Please compile your contracts using 'npx hardhat compile'"))
      return
    }

    logger.log(`Found ${contractFiles.length} compiled contract files`)

    // Parse each contract file
    let loadedContracts = 0
    for (const filePath of contractFiles) {
      try {
        const fileName = path.parse(filePath).base
        const contractName = fileName.substring(0, fileName.length - 5)

        logger.log(`Parsing Hardhat contract: ${contractName}`)

        const fileData = fs.readFileSync(filePath, 'utf8')
        const jsonData = JSON.parse(fileData)

        // Validate Hardhat format
        if (!jsonData.bytecode) {
          logger.log(`Skipping ${contractName}: Not a valid Hardhat compiled contract format`)
          continue
        }

        const output: CompiledJSONOutput = {
          contractType: 1, // Hardhat format
          hardhatOutput: jsonData,
          path: path.dirname(filePath),
          name: contractName
        }

        // Store contract in workspace state
        let contracts: any = context.workspaceState.get('contracts')
        if (!contracts) contracts = {}
        
        contracts[contractName] = output
        void context.workspaceState.update('contracts', contracts)

        logger.success(`Successfully loaded Hardhat contract: ${contractName}`)
        loadedContracts++

      } catch (parseError) {
        logger.error(new Error(`Failed to parse contract file ${filePath}: ${parseError}`))
      }
    }

    if (loadedContracts === 0) {
      logger.error(new Error('No valid Hardhat contracts were loaded. Please check your compilation output.'))
    } else {
      logger.success(`Successfully loaded ${loadedContracts} Hardhat contracts`)
    }

  } catch (error) {
    logger.error(new Error(`Error loading Hardhat contracts: ${error}`))
  }
}

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
    const foundryConfig = await parseFoundryConfig()
    if (foundryConfig) {
      const { outDir } = foundryConfig
      logger.log(`Foundry output directory: ${outDir}`)
      allFiles = getDirectoriesRecursive(
        path.join(path_, outDir),
        0
      )
    } else {
      // Fallback to default Foundry output directory
      logger.log('Foundry project detected but no foundry.toml found, using default output directory')
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
  parseFoundryCompiledJSON,
  parseHardhatCompiledJSON,
  parseCompiledJSONPayload,
  selectContract,
  createERC4907Contract,
  parseFoundryConfig
}
