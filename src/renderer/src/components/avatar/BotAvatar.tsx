// A bot's face: our own SVG character (shape × colour, two eyes) or an uploaded image.
// The eyes react to what the bot is doing (see .fb-char rules in index.css).

import { memo, useMemo } from 'react'
import clsx from 'clsx'
import type { AvatarShape, Bot, BotAvatar as Avatar, BotColor, BotPhase } from '@shared/domain'
import { SHAPES } from './shapes'

interface CharacterProps {
  shape: AvatarShape
  color: BotColor
  size: number
  state?: BotPhase
  /** Seed for a different blink rhythm per bot. */
  seed?: string
  className?: string
  title?: string
}

export const Character = memo(function Character({ shape, color, size, state = 'idle', seed = '', className, title }: CharacterProps) {
  const def = SHAPES[shape] ?? SHAPES.blob
  const blinkDelay = useMemo(() => {
    let h = 0
    for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) % 997
    return `${-(h % 60) / 10}s`
  }, [seed])
  const cx = def.eyeX ?? 32
  const left = cx - def.eyeGap / 2
  const right = cx + def.eyeGap / 2
  const fill = `var(--hue-${color})`

  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={clsx('fb-char shrink-0 overflow-visible', className)}
      data-state={state}
      style={{ ['--blink-delay' as string]: blinkDelay }}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <g className="fb-body">
        <path
          d={def.d}
          fill={fill}
          stroke={def.round ? fill : 'var(--avatar-ring)'}
          strokeWidth={def.round ?? 1}
          strokeLinejoin="round"
        />
        <g className="fb-eyes">
          <ellipse cx={left} cy={def.eyeY} rx={4.6} ry={5.6} fill="var(--eye-white)" />
          <ellipse cx={right} cy={def.eyeY} rx={4.6} ry={5.6} fill="var(--eye-white)" />
          <g className="fb-pupils">
            <circle cx={left + 0.6} cy={def.eyeY + 0.8} r={2.6} fill="var(--eye-pupil)" />
            <circle cx={right + 0.6} cy={def.eyeY + 0.8} r={2.6} fill="var(--eye-pupil)" />
          </g>
        </g>
      </g>
    </svg>
  )
})

interface BotAvatarProps {
  bot: Pick<Bot, 'id' | 'name'> & { avatar: Avatar }
  size?: number
  state?: BotPhase
  className?: string
  /** Breathing ring for a bot waiting on you. */
  attention?: boolean
}

export function BotAvatar({ bot, size = 32, state, className, attention }: BotAvatarProps) {
  const ring = attention ? 'attention-ring rounded-full' : undefined
  if (bot.avatar.imageDataUrl) {
    return (
      <img
        src={bot.avatar.imageDataUrl}
        alt={bot.name}
        width={size}
        height={size}
        className={clsx('shrink-0 rounded-[30%] object-cover', ring, className)}
        style={{ width: size, height: size }}
        draggable={false}
      />
    )
  }
  return (
    <span className={clsx('inline-flex shrink-0', ring, className)} style={{ width: size, height: size }}>
      <Character shape={bot.avatar.shape} color={bot.avatar.color} size={size} state={state} seed={bot.id} title={bot.name} />
    </span>
  )
}

/** Overlapping faces of a group's first members. */
export function GroupAvatar({ bots, size = 32, className }: { bots: Bot[]; size?: number; className?: string }) {
  const shown = bots.slice(0, 3)
  if (shown.length === 0) {
    return <span className={clsx('inline-block shrink-0 rounded-[30%] bg-active', className)} style={{ width: size, height: size }} />
  }
  if (shown.length === 1) return <BotAvatar bot={shown[0]!} size={size} className={className} />
  const small = Math.round(size * 0.68)
  return (
    <span className={clsx('relative inline-block shrink-0', className)} style={{ width: size, height: size }}>
      {shown.map((b, i) => {
        const pos =
          shown.length === 2
            ? [
                { left: 0, top: 0 },
                { right: 0, bottom: 0 }
              ][i]
            : [
                { left: 0, top: size * 0.04 },
                { right: 0, top: 0 },
                { left: (size - small) / 2, bottom: 0 }
              ][i]
        return (
          <span key={b.id} className="absolute" style={pos}>
            <BotAvatar bot={b} size={small} />
          </span>
        )
      })}
    </span>
  )
}
