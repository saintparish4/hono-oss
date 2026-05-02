import { memoryStore } from '../../src/middleware/cache/adapters/memory'
import { runAdapterContract } from '../../src/middleware/cache/adapters/contract'

runAdapterContract('memory', () => memoryStore())
