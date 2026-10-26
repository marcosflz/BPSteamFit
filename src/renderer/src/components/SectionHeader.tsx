import type { ReactNode } from 'react'

export function SectionHeader(props: {
  eyebrow?: string
  title: string
  description?: string
  actions?: ReactNode
  titleId?: string
}): React.JSX.Element {
  return (
    <div className="section-header">
      <div className="section-header__copy">
        {props.eyebrow ? <p className="eyebrow">{props.eyebrow}</p> : null}
        <h1 id={props.titleId}>{props.title}</h1>
        {props.description ? <p className="section-header__description">{props.description}</p> : null}
      </div>
      {props.actions ? <div className="section-header__actions">{props.actions}</div> : null}
    </div>
  )
}
