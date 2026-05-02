import { runAdapterContract } from '../../src/middleware/cache/adapters/contract'
import { memoryStore } from '../../src/middleware/cache/adapters/memory'

runAdapterContract('memory', () => memoryStore())
