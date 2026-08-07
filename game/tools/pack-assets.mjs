#!/usr/bin/env node
// pack-assets.mjs — turn the 3d-assets manifest into ONE inlinable vendor file.
//
// The sharky.gg /play route hosts a SINGLE HTML file and separate asset files
// do not execute from storage (publishing.md "Hosting"), so every GLB has to
// ride inside the page as a data: URI. This writes
// <skill>/assets/vendor/speedway-assets.js, which the game pulls in through
// the build's /*__VENDOR:speedway-assets__*/ placeholder.
//
//   node tools/pack-assets.mjs [--cwd <dir>] [--max-texture 512] [--budget 9000000]
//
// Emits window.__SPEEDWAY_ASSETS__ = { "<asset-id>": { url, role, kind,
// orientation } }. With no manifest (or no downloaded GLBs) it emits an empty
// object — the game then renders its primitive fallbacks, which is the
// documented behaviour, not a silent substitution.

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const argv = process.argv.slice(2)
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? dflt : argv[i + 1]
}

const cwd = path.resolve(flag('cwd', process.cwd()))
const skillRoot = path.resolve(cwd, '..')
const outFile = path.join(skillRoot, 'assets', 'vendor', 'speedway-assets.js')
// gotcha 1e: the platform sim refuses pages over 12,000,000 bytes. Base64
// inflates by 4/3 and the page also carries three.js + the runtime, so the
// packer keeps the encoded payload well under that.
const BUDGET = Number(flag('budget', 9_000_000))
const MAX_TEXTURE = Number(flag('max-texture', 512))

const GLB_MAGIC = 0x46546c67 // 'glTF'
const CHUNK_JSON = 0x4e4f534a
const CHUNK_BIN = 0x004e4942

function parseGlb(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (dv.getUint32(0, true) !== GLB_MAGIC) throw new Error('not a GLB')
  const total = dv.getUint32(8, true)
  let off = 12
  let json = null
  let bin = null
  while (off + 8 <= total) {
    const len = dv.getUint32(off, true)
    const type = dv.getUint32(off + 4, true)
    const body = buf.subarray(off + 8, off + 8 + len)
    if (type === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(body))
    else if (type === CHUNK_BIN) bin = body
    off += 8 + len + ((4 - (len % 4)) % 4)
  }
  if (!json) throw new Error('GLB has no JSON chunk')
  return { json, bin: bin ?? Buffer.alloc(0) }
}

function writeGlb(json, bin) {
  const pad = (b, fill) => {
    const rem = (4 - (b.length % 4)) % 4
    return rem === 0 ? b : Buffer.concat([b, Buffer.alloc(rem, fill)])
  }
  const jsonChunk = pad(Buffer.from(JSON.stringify(json), 'utf8'), 0x20)
  const binChunk = pad(Buffer.from(bin), 0x00)
  const header = Buffer.alloc(12)
  header.writeUInt32LE(GLB_MAGIC, 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + jsonChunk.length + (binChunk.length ? 8 + binChunk.length : 0), 8)
  const parts = [header]
  const jHead = Buffer.alloc(8)
  jHead.writeUInt32LE(jsonChunk.length, 0)
  jHead.writeUInt32LE(CHUNK_JSON, 4)
  parts.push(jHead, jsonChunk)
  if (binChunk.length) {
    const bHead = Buffer.alloc(8)
    bHead.writeUInt32LE(binChunk.length, 0)
    bHead.writeUInt32LE(CHUNK_BIN, 4)
    parts.push(bHead, binChunk)
  }
  return Buffer.concat(parts)
}

// Texture downscaling is the single biggest lever on a Tripo GLB (a 2048px
// baked atlas dwarfs the mesh). sharp is optional: without it the GLB ships
// as delivered and the packer says so rather than pretending it shrank.
let sharp = null
try {
  ({ default: sharp } = await import('sharp'))
} catch {
  sharp = null
}

async function shrinkTextures(buf, label) {
  if (!sharp) return { buf, note: 'textures untouched (sharp unavailable)' }
  let parsed
  try {
    parsed = parseGlb(buf)
  } catch (e) {
    return { buf, note: `textures untouched (${e.message})` }
  }
  const { json, bin } = parsed
  const images = json.images ?? []
  const views = json.bufferViews ?? []
  if (!images.length || !views.length) return { buf, note: 'no embedded textures' }

  // Re-pack: every bufferView is copied into a fresh binary chunk so that
  // replacing an image with a smaller blob does not strand offsets.
  const chunks = new Array(views.length)
  for (let i = 0; i < views.length; i++) {
    const v = views[i]
    const start = v.byteOffset ?? 0
    chunks[i] = Buffer.from(bin.subarray(start, start + v.byteLength))
  }

  let shrunk = 0
  for (const img of images) {
    if (img.bufferView === undefined) continue
    const src = chunks[img.bufferView]
    if (!src?.length) continue
    try {
      const meta = await sharp(src).metadata()
      if (!meta.width || (meta.width <= MAX_TEXTURE && meta.height <= MAX_TEXTURE)) continue
      const out = await sharp(src)
        .resize({ width: MAX_TEXTURE, height: MAX_TEXTURE, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82, mozjpeg: true })
        .toBuffer()
      if (out.length < src.length) {
        chunks[img.bufferView] = out
        img.mimeType = 'image/jpeg'
        shrunk++
      }
    } catch {
      /* an image sharp cannot read ships unchanged */
    }
  }
  if (!shrunk) return { buf, note: 'textures already within budget' }

  let offset = 0
  const rebuilt = []
  for (let i = 0; i < views.length; i++) {
    const c = chunks[i]
    views[i].byteOffset = offset
    views[i].byteLength = c.length
    rebuilt.push(c)
    const padLen = (4 - (c.length % 4)) % 4
    if (padLen) rebuilt.push(Buffer.alloc(padLen))
    offset += c.length + padLen
  }
  const newBin = Buffer.concat(rebuilt)
  if (json.buffers?.[0]) json.buffers[0].byteLength = newBin.length
  const out = writeGlb(json, newBin)
  return { buf: out, note: `${shrunk} texture(s) resized to ${MAX_TEXTURE}px, ${label}` }
}

const modelUrl = (asset) => asset?.model?.url ?? asset?.url ?? null

async function main() {
  const manifestFile = path.join(cwd, 'asset_manifest.json')
  let manifest = null
  try {
    manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
  } catch {
    manifest = null
  }

  const entries = {}
  const report = []
  let totalEncoded = 0

  for (const asset of manifest?.assets ?? []) {
    const rel = modelUrl(asset)
    if (!rel) continue
    // manifest urls are runtime paths like /generated-assets/<task>/model.glb
    const file = path.join(cwd, 'public', rel.replace(/^\//, ''))
    let raw
    try {
      const info = await stat(file)
      if (!info.isFile() || info.size === 0) throw new Error('empty')
      raw = await readFile(file)
    } catch {
      report.push(`  ${asset.id}: SKIPPED — no local GLB at ${path.relative(cwd, file)}`)
      continue
    }
    const { buf, note } = await shrinkTextures(raw, asset.id)
    const b64 = buf.toString('base64')
    totalEncoded += b64.length
    entries[asset.id] = {
      url: `data:model/gltf-binary;base64,${b64}`,
      role: asset.role ?? asset.gameplayRole ?? null,
      kind: asset.assetKind ?? null,
      orientation: asset.orientation ?? null,
    }
    report.push(
      `  ${asset.id}: ${(raw.length / 1024).toFixed(0)}KB -> ${(buf.length / 1024).toFixed(0)}KB glb, ` +
        `${(b64.length / 1024).toFixed(0)}KB base64 (${note})`
    )
  }

  const ids = Object.keys(entries)
  const body =
    `/* speedway-assets — generated by game/tools/pack-assets.mjs. Do not edit by hand.\n` +
    `   ${ids.length} GLB asset(s) inlined as data: URIs; ${(totalEncoded / 1024).toFixed(0)}KB encoded.\n` +
    `   Empty object = no generated GLB on disk; the game renders its primitive fallbacks. */\n` +
    `window.__SPEEDWAY_ASSETS__ = ${JSON.stringify(entries)};\n`

  await mkdir(path.dirname(outFile), { recursive: true })
  await writeFile(outFile, body, 'utf8')

  console.log(`[pack-assets] manifest: ${manifest ? path.relative(cwd, manifestFile) : 'MISSING'}`)
  if (report.length) console.log(report.join('\n'))
  console.log(`[pack-assets] wrote ${path.relative(skillRoot, outFile)} — ${ids.length} asset(s), ${(body.length / 1024).toFixed(0)}KB`)
  if (!ids.length) {
    console.log('[pack-assets] NOTE: no GLBs inlined — the game falls back to primitive geometry.')
  }
  if (totalEncoded > BUDGET) {
    console.error(`[pack-assets] ERROR: encoded payload ${(totalEncoded / 1e6).toFixed(1)}MB exceeds the ${(BUDGET / 1e6).toFixed(1)}MB budget (sim caps pages at 12MB — gotcha 1e).`)
    process.exit(1)
  }
}

await main()
