/**
 * Configuración de formatos de batalla y offsets de intros de beats
 */

export type BattleFormat = '4x4' | '8x8' | 'minuto-libre';

export interface BattleFormatConfig {
  format: BattleFormat;
  label: string;
  description: string;
  verses?: number;
  linesPerVerse?: number;
  timePerTurnSeconds?: number;
}

export const BATTLE_FORMATS: Record<BattleFormat, BattleFormatConfig> = {
  '4x4': {
    format: '4x4',
    label: '4x4',
    description: '4 versos de 4 líneas cada uno',
    verses: 4,
    linesPerVerse: 4,
  },
  '8x8': {
    format: '8x8',
    label: '8x8',
    description: '8 versos de 8 líneas cada uno',
    verses: 8,
    linesPerVerse: 8,
  },
  'minuto-libre': {
    format: 'minuto-libre',
    label: 'Minuto Libre',
    description: '60 segundos por turno',
    timePerTurnSeconds: 60,
  },
};

/**
 * Configuración de offsets de intro por beat (en segundos)
 * Define cuándo empieza realmente el beat después de la intro
 */
export const BEAT_INTRO_OFFSETS: Record<number, number> = {
  1: 20, // beat1.mp3 - comienza al segundo 20
  2: 9,  // beat2.mp3 - comienza al segundo 9
  3: 18, // beat3.mp3 - comienza al segundo 18
  4: 3,  // beat4.mp3 - comienza al segundo 3
  // Agregar más beats según sea necesario
};

/**
 * Obtiene el offset de intro para un beat específico
 */
export function getBeatIntroOffset(beatNumber: number): number {
  return BEAT_INTRO_OFFSETS[beatNumber] ?? 0;
}

/**
 * Obtiene la configuración de un formato de batalla
 */
export function getBattleFormatConfig(format: BattleFormat): BattleFormatConfig {
  return BATTLE_FORMATS[format];
}
