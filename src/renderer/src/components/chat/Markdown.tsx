// GFM markdown with code highlighting and coloured @mention chips.

import clsx from 'clsx'
import { Check, Copy, Image as ImageIcon } from 'lucide-react'
import { isValidElement, memo, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type {} from 'highlight.js'
import bash from 'highlight.js/lib/languages/bash'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import plaintext from 'highlight.js/lib/languages/plaintext'
import powershell from 'highlight.js/lib/languages/powershell'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import shell from 'highlight.js/lib/languages/shell'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import type { Bot } from '@shared/domain'
import { useData } from '../../store/data'
import { BotHoverCard } from './BotHoverCard'

const HIGHLIGHT_OPTIONS = {
  languages: { bash, cpp, csharp, css, diff, go, ini, java, javascript, json, markdown, plaintext, powershell, python, rust, shell, sql, typescript, xml, yaml },
  aliases: { bash: ['sh', 'zsh'], powershell: ['ps', 'ps1', 'pwsh'], typescript: ['ts', 'tsx'], javascript: ['js', 'jsx', 'mjs'], xml: ['html', 'svg'], yaml: ['yml'], ini: ['toml'] }
}

/** Turn @handle words into mention links (outside code), so the renderer can draw chips. */
function linkMentions(text: string, bots: Bot[]): string {
  if (!text.includes('@')) return text
  const byKey = new Map<string, Bot | null>()
  for (const b of bots) {
    const keys = [b.handle, b.name.toLowerCase().replace(/\s+/g, ''), b.name.toLowerCase().split(/\s+/)[0] ?? '']
    for (const k of keys) byKey.set(k, byKey.has(k) && byKey.get(k)?.id !== b.id ? null : b)
  }
  return text
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(/(^|[^\w@/[])@(\w[\w-]*\w|\w)/g, (match, pre: string, word: string) => {
            const key = word.toLowerCase()
            if (key === 'everyone' || key === 'all') return `${pre}[@${key}](mention:everyone)`
            const bot = byKey.get(key)
            return bot ? `${pre}[@${bot.handle}](mention:${bot.id})` : match
          })
    )
    .join('')
}

function urlTransform(url: string, key: string): string {
  if (url.startsWith('mention:')) return url
  // Inline images may be local data/blob URLs (never data:text/html and the like).
  if (key === 'src' && /^(data:image\/(png|jpe?g|gif|webp|avif|bmp);|blob:)/i.test(url)) return url
  return defaultUrlTransform(url)
}

function MentionChip({ id, label, onInk }: { id: string; label: ReactNode; onInk?: boolean }) {
  const bot = useData((s) => s.botMap.get(id))
  if (!bot) {
    return <span className={clsx('rounded px-0.5 font-medium', onInk ? 'bg-white/15' : 'bg-hover text-fg')}>{label}</span>
  }
  return (
    <BotHoverCard bot={bot}>
      <span
        className={clsx(
          `bot-${bot.avatar.color} cursor-default rounded px-0.5 font-medium`,
          onInk ? 'bg-white/15 text-inherit' : 'bg-bot-soft text-bot-fg'
        )}
      >
        {label}
      </span>
    </BotHoverCard>
  )
}

export function CopyButton({ getText, label = 'Copy', className }: { getText: () => string; label?: string; className?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(getText()).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1400)
        })
      }}
      className={clsx('inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-hover hover:text-fg', className)}
      aria-label={label}
      title={label}
    >
      {done ? <Check size={12} /> : <Copy size={12} />}
      <span>{done ? 'Copied' : label}</span>
    </button>
  )
}

function Pre({ children, node: _node, ...rest }: ComponentProps<'pre'> & { node?: unknown }) {
  const ref = useRef<HTMLPreElement>(null)
  const className = isValidElement(children) ? ((children.props as { className?: string }).className ?? '') : ''
  const lang = /language-([\w-]+)/.exec(className)?.[1]
  return (
    <div className="code-block my-2 overflow-hidden rounded-[10px] border border-line bg-sunken">
      <div className="flex h-7 items-center justify-between border-b border-line-soft pl-3 pr-1.5 text-2xs text-fg-3">
        <span className="font-mono">{lang ?? 'text'}</span>
        <CopyButton getText={() => ref.current?.innerText ?? ''} label="Copy code" />
      </div>
      <pre ref={ref} {...rest}>
        {children}
      </pre>
    </div>
  )
}

/**
 * Images. A remote image would be fetched the moment a bot's reply renders, with no click
 * (a tracking pixel, or a leak of what the bot read). So http(s) images show as a link you
 * open yourself; only local data: and blob: images render inline. The CSP enforces the same.
 */
function MarkdownImage({ src, alt, title }: { src?: unknown; alt?: string; title?: string }) {
  const url = typeof src === 'string' ? src : ''
  if (/^(data:image\/|blob:)/i.test(url)) return <img src={url} alt={alt ?? ''} title={title} loading="lazy" />
  if (!/^https?:\/\//i.test(url)) return alt ? <span>{alt}</span> : null
  return (
    <a href={url} target="_blank" rel="noreferrer noopener" title={url} className="inline-flex items-center gap-1 align-baseline">
      <ImageIcon size={13} className="shrink-0 self-center opacity-70" aria-hidden />
      {alt?.trim() || 'Image'}
    </a>
  )
}

function buildComponents(onInk: boolean): Components {
  return {
    img: ({ src, alt, title }) => <MarkdownImage src={src} alt={alt} title={title} />,
    a: ({ href, children, node: _node, ...rest }) => {
      if (href?.startsWith('mention:')) return <MentionChip id={href.slice('mention:'.length)} label={children} onInk={onInk} />
      return (
        <a href={href} target="_blank" rel="noreferrer noopener" {...rest}>
          {children}
        </a>
      )
    },
    pre: Pre
  }
}

const COMPONENTS = buildComponents(false)
const COMPONENTS_ON_INK = buildComponents(true)

export const Markdown = memo(function Markdown({
  text,
  streaming,
  onInk,
  className
}: {
  text: string
  streaming?: boolean
  onInk?: boolean
  className?: string
}) {
  const bots = useData((s) => s.bots)
  const source = useMemo(() => linkMentions(text, bots), [text, bots])
  return (
    <div className={clsx('prose-chat', onInk && 'prose-on-ink', streaming && 'is-streaming', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, HIGHLIGHT_OPTIONS]]}
        urlTransform={urlTransform}
        components={onInk ? COMPONENTS_ON_INK : COMPONENTS}
      >
        {source}
      </ReactMarkdown>
    </div>
  )
})
