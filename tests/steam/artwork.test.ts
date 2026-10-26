import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyArtwork,
  getArtworkFileName,
  migrateManagedArtwork,
  removeManagedArtwork,
  type ArtworkItem
} from '@core/steam'
import {
  FIXTURES,
  KODI_APPID,
  cleanupTempDirectories,
  createTempSteam
} from './helpers'

afterEach(cleanupTempDirectories)

async function makeSources(tempDir: string): Promise<{ portrait: string; hero: string; logo: string; icon: string }> {
  const dir = join(tempDir, 'sources')
  await mkdir(dir, { recursive: true })
  const names = ['portrait', 'hero', 'logo', 'icon'] as const
  const result = {} as Record<(typeof names)[number], string>
  for (const name of names) {
    const target = join(dir, `${name}.png`)
    await copyFile(join(FIXTURES, 'artwork', `${name}.png`), target)
    result[name] = target
  }
  return result
}

function itemsFor(appId: number, sources: Awaited<ReturnType<typeof makeSources>>): ArtworkItem[] {
  return [
    { appId, kind: 'portrait', sourcePath: sources.portrait },
    { appId, kind: 'hero', sourcePath: sources.hero },
    { appId, kind: 'logo', sourcePath: sources.logo },
    { appId, kind: 'icon', sourcePath: sources.icon }
  ]
}

describe('Artwork en config/grid', () => {
  it('copia portrait, hero, logo e icon con nombres canónicos y conserva el origen', async () => {
    const temp = await createTempSteam()
    const sources = await makeSources(temp.root)
    const result = await applyArtwork(temp.root, temp.accountId, itemsFor(KODI_APPID, sources), {
      backupDir: temp.backupDir
    })
    expect(result.applied).toHaveLength(4)
    const names = [
      getArtworkFileName(KODI_APPID, 'portrait'),
      getArtworkFileName(KODI_APPID, 'hero'),
      getArtworkFileName(KODI_APPID, 'logo'),
      getArtworkFileName(KODI_APPID, 'icon')
    ]
    expect((await readdir(temp.gridDir)).sort()).toEqual([...names].sort())
    for (const name of names) {
      expect(await readFile(join(temp.gridDir, name))).toEqual(await readFile(sources.portrait))
    }
    const sourceStat = await stat(sources.portrait)
    expect(sourceStat.isFile()).toBe(true)
  })

  it('es idempotente y no crea backups si el destino ya coincide', async () => {
    const temp = await createTempSteam()
    const sources = await makeSources(temp.root)
    const first = await applyArtwork(temp.root, temp.accountId, itemsFor(KODI_APPID, sources), {
      backupDir: temp.backupDir
    })
    expect(first.applied).toHaveLength(4)
    const second = await applyArtwork(temp.root, temp.accountId, itemsFor(KODI_APPID, sources), {
      backupDir: temp.backupDir
    })
    expect(second.applied).toHaveLength(0)
    expect(second.skipped.every((item) => item.reason === 'already-applied')).toBe(true)
    const backupEntries = await readdir(temp.backupDir, { recursive: true }).catch(() => [])
    expect(backupEntries.filter((name) => String(name).endsWith('.bak'))).toHaveLength(0)
  })

  it('hace backup del artwork existente antes de reemplazarlo', async () => {
    const temp = await createTempSteam()
    const sources = await makeSources(temp.root)
    const target = join(temp.gridDir, getArtworkFileName(KODI_APPID, 'portrait'))
    await writeFile(target, Buffer.from('artwork anterior'))
    const result = await applyArtwork(temp.root, temp.accountId, [
      { appId: KODI_APPID, kind: 'portrait', sourcePath: sources.portrait }
    ], { backupDir: temp.backupDir })
    expect(result.applied[0]?.backupPath).toBeDefined()
    expect(await readFile(result.applied[0]!.backupPath!)).toEqual(Buffer.from('artwork anterior'))
    expect(await readFile(target)).toEqual(await readFile(sources.portrait))
  })

  it('normaliza .jpeg a .jpg sin prometer WebP', async () => {
    const temp = await createTempSteam()
    const sources = await makeSources(temp.root)
    const jpeg = join(temp.root, 'sources', 'portrait.jpeg')
    await copyFile(sources.portrait, jpeg)
    const result = await applyArtwork(temp.root, temp.accountId, [
      { appId: KODI_APPID, kind: 'portrait', sourcePath: jpeg }
    ])
    expect(result.applied[0]?.targetPath).toBe(
      join(temp.gridDir, getArtworkFileName(KODI_APPID, 'portrait', '.jpg'))
    )
    await expect(
      applyArtwork(temp.root, temp.accountId, [
        { appId: KODI_APPID, kind: 'portrait', sourcePath: join(temp.root, 'x.webp') }
      ])
    ).rejects.toMatchObject({ code: 'ARTWORK_INVALID' })
  })

  it('rechaza screenshot y orígenes relativos', async () => {
    const temp = await createTempSteam()
    const sources = await makeSources(temp.root)
    await expect(
      applyArtwork(temp.root, temp.accountId, [
        {
          appId: KODI_APPID,
          kind: 'screenshot' as unknown as ArtworkItem['kind'],
          sourcePath: sources.portrait
        }
      ])
    ).rejects.toMatchObject({ code: 'ARTWORK_INVALID' })
    await expect(
      applyArtwork(temp.root, temp.accountId, [
        { appId: KODI_APPID, kind: 'portrait', sourcePath: 'relativo.png' }
      ])
    ).rejects.toMatchObject({ code: 'ARTWORK_INVALID' })
  })

  it('borra solo los nombres canónicos de AppIDs gestionados', async () => {
    const temp = await createTempSteam()
    const sources = await makeSources(temp.root)
    await applyArtwork(temp.root, temp.accountId, itemsFor(KODI_APPID, sources))
    await applyArtwork(temp.root, temp.accountId, itemsFor(999_999_999, sources))
    await writeFile(join(temp.gridDir, 'notas.txt'), 'no tocar')
    await writeFile(join(temp.gridDir, '123p.png'), 'ajeno')

    const result = await removeManagedArtwork(temp.root, temp.accountId, [KODI_APPID], {
      backupDir: temp.backupDir
    })
    expect(result.removed).toHaveLength(4)
    const remaining = await readdir(temp.gridDir)
    expect(remaining).toContain('999999999p.png')
    expect(remaining).toContain('notas.txt')
    expect(remaining).toContain('123p.png')
    expect(remaining).not.toContain(getArtworkFileName(KODI_APPID, 'portrait'))
    expect(result.removed.every((item) => item.backupPath)).toBe(true)
  })

  it('con expectedHashes solo borra si el hash coincide', async () => {
    const temp = await createTempSteam()
    const sources = await makeSources(temp.root)
    const applied = await applyArtwork(temp.root, temp.accountId, [
      { appId: KODI_APPID, kind: 'portrait', sourcePath: sources.portrait }
    ])
    const target = applied.applied[0]!.targetPath
    const name = getArtworkFileName(KODI_APPID, 'portrait')
    const wrong = await removeManagedArtwork(temp.root, temp.accountId, [KODI_APPID], {
      expectedHashes: { [name]: '0'.repeat(64) }
    })
    expect(wrong.removed).toHaveLength(0)
    expect(wrong.skipped[0]?.reason).toBe('hash-distinto-al-gestionado')
    expect((await stat(target)).isFile()).toBe(true)
    const right = await removeManagedArtwork(temp.root, temp.accountId, [KODI_APPID], {
      expectedHashes: { [name]: applied.applied[0]!.sha256 }
    })
    expect(right.removed).toHaveLength(1)
  })

  it('migra artwork a un AppID nuevo sin tocar otros AppIDs', async () => {
    const temp = await createTempSteam()
    const sources = await makeSources(temp.root)
    await applyArtwork(temp.root, temp.accountId, [
      { appId: KODI_APPID, kind: 'portrait', sourcePath: sources.portrait },
      { appId: KODI_APPID, kind: 'hero', sourcePath: sources.hero }
    ])
    const migrated = await migrateManagedArtwork(temp.root, temp.accountId, KODI_APPID, 777_777_777, {
      backupDir: temp.backupDir,
      removeOld: true
    })
    expect(migrated.copied).toHaveLength(2)
    expect((await readdir(temp.gridDir)).sort()).toEqual(
      [
        getArtworkFileName(777_777_777, 'portrait'),
        getArtworkFileName(777_777_777, 'hero')
      ].sort()
    )
  })
})
