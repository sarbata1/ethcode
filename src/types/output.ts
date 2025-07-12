import { type AbiItem } from './types'
import { logger } from '../lib'

export interface HardHatCompiledOutput {
  contractName: string
  sourceName: string
  /** The Ethereum Contract ABI. If empty, it is represented as an empty array. */
  abi: readonly AbiItem[]
  bytecode: string
  deployedBytecode: string
}

export interface RemixCompiledOutput {
  data: {
    bytecode: BytecodeObject
    deployedByteCode: BytecodeObject
  }
  /** The Ethereum Contract ABI. If empty, it is represented as an empty array. */
  abi: readonly AbiItem[]
}

export interface FoundryCompiledOutput {
  abi: readonly AbiItem[]
  bytecode: {
    object: string
    sourceMap: string
    linkReferences: Record<string, Record<string, Array<{ start: number, length: number }>>>
  }
  deployedBytecode: {
    object: string
    sourceMap: string
    linkReferences: Record<string, Record<string, Array<{ start: number, length: number }>>>
  }
  metadata: string
  ir: string
  irOptimized: string
  storageLayout: any
  evm: {
    assembly: string
    bytecode: {
      object: string
      sourceMap: string
      linkReferences: Record<string, Record<string, Array<{ start: number, length: number }>>>
    }
    deployedBytecode: {
      object: string
      sourceMap: string
      linkReferences: Record<string, Record<string, Array<{ start: number, length: number }>>>
    }
    methodIdentifiers: Record<string, string>
    gasEstimates: any
  }
  ewasm: any
}

interface GasEstimate {
  confidence: number
  maxFeePerGas: number
  maxPriorityFeePerGas: number
  price: number
}

export interface GasEstimateOutput {
  low: GasEstimate
  medium: GasEstimate
  high: GasEstimate
}

export interface CompiledJSONOutput {
  name?: string // contract name
  path?: string // local path of the contract
  contractType: number // 0: null, 1: hardhat output, 2: remix output, 3: foundry output
  hardhatOutput?: HardHatCompiledOutput
  remixOutput?: RemixCompiledOutput
  foundryOutput?: FoundryCompiledOutput
}

export const getAbi = (output: CompiledJSONOutput): any => {
  if (output.contractType === 0) return []

  if (output.contractType === 1) return output.hardhatOutput?.abi

  if (output.contractType === 2) return output.remixOutput?.abi

  if (output.contractType === 3) return output.foundryOutput?.abi

  return []
}

export const getByteCode = (
  output: CompiledJSONOutput
): string | undefined => {
  if (output.contractType === 0) return ''

  if (output.contractType === 1) {
    const bytecode = output.hardhatOutput?.bytecode
    if (!bytecode) return undefined
    // Ensure 0x prefix for Hardhat format
    return bytecode.startsWith('0x') ? bytecode : `0x${bytecode}`
  }

  if (output.contractType === 2) {
    // Remix format
    const bytecode = output.remixOutput?.data.bytecode.object
    if (!bytecode) {
      logger.log('Remix bytecode is undefined or null')
      return undefined
    }
    
    logger.log(`Original Remix bytecode: ${bytecode.substring(0, 20)}...`)
    logger.log(`Bytecode starts with 0x: ${bytecode.startsWith('0x')}`)
    
    // Ensure 0x prefix for Remix format
    const result = bytecode.startsWith('0x') ? bytecode : `0x${bytecode}`
    logger.log(`Final bytecode: ${result.substring(0, 20)}...`)
    
    return result
  }

  if (output.contractType === 3) {
    // Foundry format
    const bytecode = output.foundryOutput?.bytecode.object
    if (!bytecode) {
      logger.log('Foundry bytecode is undefined or null')
      return undefined
    }
    
    logger.log(`Original Foundry bytecode: ${bytecode.substring(0, 20)}...`)
    logger.log(`Bytecode starts with 0x: ${bytecode.startsWith('0x')}`)
    
    // Ensure 0x prefix for Foundry format
    const result = bytecode.startsWith('0x') ? bytecode : `0x${bytecode}`
    logger.log(`Final Foundry bytecode: ${result.substring(0, 20)}...`)
    
    return result
  }

  return undefined
}

export interface BytecodeObject {
  /** The bytecode as a hex string. */
  object: string
  /** Opcodes list */
  opcodes: string
  /** The source mapping as a string. See the source mapping definition. */
  sourceMap: string
  /** If given, this is an unlinked object. */
  linkReferences?: Record<string, Record<string, Array<{ start: number, length: number }>>>
}

export interface Fees {
  maxFeePerGas: bigint
  maxPriorityFeePerGas?: bigint
}

export interface FeeHistory {
  oldestBlock: number
  reward: string[][]
  baseFeePerGas: string[]
  gasUsedRatio: number[]
}
