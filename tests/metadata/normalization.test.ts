import { describe, expect, it } from 'vitest'
import {
  editionsEqual,
  normalizeTitle,
  parseTitle,
  sequelNumbersEqual,
  titleSimilarity,
  titlesEqual,
  variantsEqual
} from '@core/metadata/normalization'

describe('normalización de títulos', () => {
  it('ignora mayúsculas, acentos y ancho Unicode al comparar', () => {
    expect(normalizeTitle('  Pokémon   ÉDITION ')).toBe('pokemon edition')
    expect(titlesEqual('Pokémon Édition', 'Pokemon Edition')).toBe(true)
    expect(titlesEqual('Ｆｉｎａｌ Ｆａｎｔａｓｙ', 'Final Fantasy')).toBe(true)
    expect(normalizeTitle('The Legend of Heroes: Trails in the Sky')).toBe(
      'the legend of heroes trails in the sky'
    )
  })

  it('conserva números de secuela arábigos y romanos', () => {
    expect(parseTitle('Example Quest 2').sequelNumbers).toEqual([2])
    expect(parseTitle('Example Quest II').sequelNumbers).toEqual([2])
    expect(parseTitle('Example Quest 2: Lost Shores').sequelNumbers).toEqual([2])
    expect(parseTitle('Final Fantasy VII Remake').sequelNumbers).toEqual([7])
    expect(parseTitle('Cyberpunk 2077').sequelNumbers).toEqual([])
  })

  it('detecta ediciones sin borrar el resto del título', () => {
    const deluxe = parseTitle('Example Quest: Deluxe Edition')
    expect(deluxe.editions).toEqual(['deluxe'])
    expect(deluxe.core).toBe('example quest')
    expect(deluxe.normalized).toBe('example quest deluxe edition')

    const spanish = parseTitle('Example Quest Edición Definitiva')
    expect(spanish.editions).toEqual(['definitive'])
    expect(spanish.core).toBe('example quest')

    const goty = parseTitle('Example Quest Game of the Year Edition')
    expect(goty.editions).toEqual(['goty'])
    expect(goty.core).toBe('example quest')
  })

  it('distingue remake y remaster de una edición', () => {
    const remake = parseTitle('Example Quest Remake')
    const remaster = parseTitle('Example Quest Remastered')
    expect(remake.variants).toEqual(['remake'])
    expect(remaster.variants).toEqual(['remaster'])
    expect(remake.editions).toEqual([])
    expect(variantsEqual(remake, remaster)).toBe(false)
    expect(editionsEqual(remake, remaster)).toBe(true)
  })

  it('conserva subtítulos y números en el núcleo', () => {
    const parsed = parseTitle('Example Quest 2: Lost Shores — Deluxe Edition')
    expect(parsed.core).toBe('example quest 2 lost shores')
    expect(parsed.sequelNumbers).toEqual([2])
    expect(parsed.editions).toEqual(['deluxe'])
  })

  it('compara secuelas y remakes sin confundirlos', () => {
    const base = parseTitle('Example Quest')
    const sequel = parseTitle('Example Quest 2')
    const remake = parseTitle('Example Quest Remake')
    expect(sequelNumbersEqual(base, sequel)).toBe(false)
    expect(sequelNumbersEqual(sequel, sequel)).toBe(true)
    expect(variantsEqual(base, remake)).toBe(false)
    expect(titleSimilarity('Example Quest', 'Example Quest')).toBe(1)
    expect(titleSimilarity('Example Quest', 'Example Quest 2')).toBeGreaterThan(0.6)
    expect(titleSimilarity('Example Quest', 'Example Quest 2')).toBeLessThan(1)
    expect(titleSimilarity('Example Quest', 'Totally Different Game')).toBeLessThan(0.55)
  })

  it('mantiene el título original para mostrar', () => {
    const parsed = parseTitle('  Example Quest: ¡Edición Especial! ')
    expect(parsed.raw).toBe('  Example Quest: ¡Edición Especial! ')
    expect(parsed.normalized).toBe('example quest edicion especial')
  })
})
