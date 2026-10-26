export type AppDialog =
  | { kind: 'install'; gameId: string }
  | { kind: 'cancel-install'; gameId: string }
  | { kind: 'clear-identity'; gameId: string }
  | { kind: 'steam-sync' }
  | { kind: 'steam-key' }
  | { kind: 'clear-steam-key' }
  | { kind: 'quit' }
