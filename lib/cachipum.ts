/**
 * Lógica del juego Cachipum (Piedra, Papel, Tijera)
 */

export type CachipumChoice = 'piedra' | 'papel' | 'tijera';

export interface CachipumRoundResult {
  round: number;
  choices: Map<string, CachipumChoice>; // userId -> choice
  winners: string[]; // userIds de los ganadores de esta ronda
}

/**
 * Determina el ganador entre dos opciones
 * @returns 1 si choice1 gana, -1 si choice2 gana, 0 si empate
 */
export function compareCachipumChoices(choice1: CachipumChoice, choice2: CachipumChoice): number {
  if (choice1 === choice2) return 0;
  
  // Piedra gana a tijera
  if (choice1 === 'piedra' && choice2 === 'tijera') return 1;
  if (choice1 === 'tijera' && choice2 === 'piedra') return -1;
  
  // Tijera gana a papel
  if (choice1 === 'tijera' && choice2 === 'papel') return 1;
  if (choice1 === 'papel' && choice2 === 'tijera') return -1;
  
  // Papel gana a piedra
  if (choice1 === 'papel' && choice2 === 'piedra') return 1;
  if (choice1 === 'piedra' && choice2 === 'papel') return -1;
  
  return 0;
}

/**
 * Determina los ganadores de una ronda con múltiples participantes
 * @param choices Map de userId -> choice para esta ronda
 * @returns Array de userIds ganadores (puede haber empate)
 */
export function determineRoundWinners(choices: Map<string, CachipumChoice>): string[] {
  if (choices.size === 0) return [];
  if (choices.size === 1) return Array.from(choices.keys());
  
  const userIds = Array.from(choices.keys());
  const winners: string[] = [];
  const wins = new Map<string, number>(); // userId -> número de victorias
  
  // Inicializar contador de victorias
  userIds.forEach(userId => wins.set(userId, 0));
  
  // Comparar todas las combinaciones
  for (let i = 0; i < userIds.length; i++) {
    for (let j = i + 1; j < userIds.length; j++) {
      const userId1 = userIds[i];
      const userId2 = userIds[j];
      const choice1 = choices.get(userId1)!;
      const choice2 = choices.get(userId2)!;
      
      const result = compareCachipumChoices(choice1, choice2);
      if (result > 0) {
        wins.set(userId1, (wins.get(userId1) || 0) + 1);
      } else if (result < 0) {
        wins.set(userId2, (wins.get(userId2) || 0) + 1);
      }
    }
  }
  
  // Encontrar el máximo de victorias
  const winValues = Array.from(wins.values());
  if (winValues.length === 0) {
    // Si no hay victorias (todos empataron), todos son ganadores (empate)
    return userIds;
  }
  
  const maxWins = Math.max(...winValues);
  
  // Si todos tienen 0 victorias (empate), todos son ganadores
  if (maxWins === 0) {
    return userIds;
  }
  
  // Agregar todos los que tienen el máximo de victorias
  wins.forEach((winsCount, userId) => {
    if (winsCount === maxWins) {
      winners.push(userId);
    }
  });
  
  return winners;
}

/**
 * Determina el ganador final del cachipum
 * Gana quien gane la primera ronda
 * Si hay empate en la primera ronda, se usa la segunda, y así sucesivamente
 * @param roundResults Resultados de las 3 rondas
 * @returns userId del ganador, o null si hay empate en todas las rondas
 */
export function determineCachipumWinner(roundResults: CachipumRoundResult[]): string | null {
  // Ordenar por número de ronda
  const sortedResults = [...roundResults].sort((a, b) => a.round - b.round);
  
  // Buscar la primera ronda con un solo ganador
  for (const result of sortedResults) {
    if (result.winners.length === 1) {
      return result.winners[0];
    }
  }
  
  // Si todas las rondas tienen empate, usar la primera ronda (o null si hay múltiples ganadores)
  if (sortedResults.length > 0 && sortedResults[0].winners.length > 0) {
    // Si hay múltiples ganadores en todas las rondas, devolver el primero alfabéticamente
    return sortedResults[0].winners.sort()[0];
  }
  
  return null;
}

/**
 * Obtiene el emoji para una opción de cachipum
 */
export function getCachipumEmoji(choice: CachipumChoice): string {
  switch (choice) {
    case 'piedra': return '✊';
    case 'papel': return '✋';
    case 'tijera': return '✌️';
  }
}

/**
 * Obtiene el nombre en español de una opción
 */
export function getCachipumLabel(choice: CachipumChoice): string {
  switch (choice) {
    case 'piedra': return 'Piedra';
    case 'papel': return 'Papel';
    case 'tijera': return 'Tijera';
  }
}
