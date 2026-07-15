// Regenerate assets/bridge.js from the platform repo's agent-kernel.
// Run from the platform repo so the kernel sources resolve.
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// default: the agent-kernel checkout this skill lives next to (skill sits at
// <repo>/skills/sharky-online/scripts/ → three levels up is the repo root)
const KERNEL_LOADER = process.env.KERNEL_LOADER ||
  resolve(import.meta.dir, '../../../packages/agent-kernel/src/runtime/sdk-loader.ts')
const { getProcessedBridge, getSdkVersion } = await import(KERNEL_LOADER)
const bridge: string = getProcessedBridge('delta-bridge')
const header = `// Sharky platform bridge (vendored build artifact)\n// namespace: delta-bridge · kernel sdkVersion: ${getSdkVersion()} · generated: ${new Date().toISOString().slice(0, 10)}\n// Regenerate: bun skills/sharky-online/scripts/regen-bridge.ts\n`
writeFileSync(resolve(import.meta.dir, '../assets/bridge.js'), header + bridge)
console.log('bridge.js regenerated:', bridge.length, 'bytes, sdkVersion', getSdkVersion())
