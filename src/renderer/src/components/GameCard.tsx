import type { CatalogGame } from '@shared/domain'
import { ArtworkVisual } from './ArtworkVisual'
import { StatusChip } from './StatusChip'
import { formatBytes } from '../lib/format'
import { installStatus, packageIssue, steamStatus } from '../lib/status'

export function GameCard(props: {
  game: CatalogGame
  autoFocus?: boolean
  onOpen: (gameId: string) => void
}): React.JSX.Element {
  const { game } = props
  const displayTitle = game.metadata?.title ?? game.identity.title ?? game.name
  const status = installStatus(game)
  const steam = steamStatus(game)
  const issue = packageIssue(game)
  const subtitleParts: string[] = []
  if (game.metadata?.releaseYear) subtitleParts.push(String(game.metadata.releaseYear))
  else if (game.identity.releaseYear) subtitleParts.push(String(game.identity.releaseYear))
  if (game.edition) subtitleParts.push(game.edition)
  subtitleParts.push(`v${game.installedVersion ?? game.currentVersion}`)
  const subtitle = subtitleParts.join(' · ')
  const size = formatBytes(game.packageSize)

  return (
    <button
      type="button"
      className="game-card"
      data-focusable
      data-focus-id={`game-${game.id}`}
      data-autofocus={props.autoFocus ? true : undefined}
      aria-label={`${displayTitle}, ${status.label}${steam ? `, ${steam.label}` : ''}`}
      onClick={() => props.onOpen(game.id)}
    >
      <span className="game-card__art">
        <ArtworkVisual
          title={displayTitle}
          kind="portrait"
          src={game.artwork.portrait?.previewUrl}
          className="game-card__image"
        />
        <span className="game-card__shade" aria-hidden="true" />
        <span className="game-card__badges">
          <StatusChip label={status.label} tone={status.tone} />
          {!game.packageAvailable && status.label !== 'Paquete ausente' ? (
            <StatusChip label="Paquete ausente" tone="danger" />
          ) : null}
          {steam ? <StatusChip label={steam.label} tone={steam.tone} /> : null}
        </span>
        {game.metadata?.isMock ? (
          <span className="game-card__demo">Datos de demostración</span>
        ) : null}
      </span>
      <span className="game-card__meta">
        <span className="game-card__title">{displayTitle}</span>
        <span className="game-card__subtitle">
          {subtitle}
          {size ? ` · ${size}` : ''}
        </span>
        {issue ? <span className="game-card__issue">{issue}</span> : null}
      </span>
    </button>
  )
}
