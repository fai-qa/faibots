// A small DOM, enough for React 19 to render the relay row and dispatch keyboard events.
// The renderer tests run in Vitest's node environment, which has no document.

const HTML = 'http://www.w3.org/1999/xhtml'
const SVG = 'http://www.w3.org/2000/svg'

type Listener = (event: Event) => void

class StyleMap {
  [key: string]: unknown
  setProperty(name: string, value: string): void {
    this[name] = value
  }
  getPropertyValue(name: string): string {
    const value = this[name]
    return typeof value === 'string' ? value : ''
  }
  removeProperty(name: string): void {
    delete this[name]
  }
}

class NodeBase {
  static ELEMENT_NODE = 1
  static TEXT_NODE = 3
  static COMMENT_NODE = 8
  static DOCUMENT_NODE = 9
  nodeType = 1
  nodeName = 'DIV'
  namespaceURI: string = HTML
  parentNode: NodeBase | null = null
  childNodes: NodeBase[] = []
  ownerDocument: DocumentNode | null = null
  nodeValue: string | null = null
  attributes = new Map<string, string>()
  style = new StyleMap()
  className = ''
  listeners = new Map<string, Set<Listener>>()
  isConnected = false

  get textContent(): string {
    if (this.nodeType === 3 || this.nodeType === 8) return this.nodeValue ?? ''
    return this.childNodes.map((child) => child.textContent).join('')
  }
  set textContent(value: string) {
    if (this.nodeType === 3 || this.nodeType === 8) {
      this.nodeValue = value
      return
    }
    this.childNodes = []
    if (value) {
      const text = new NodeBase()
      text.nodeType = 3
      text.nodeName = '#text'
      text.nodeValue = value
      text.ownerDocument = this.ownerDocument
      text.parentNode = this
      this.childNodes.push(text)
    }
  }
  get firstChild(): NodeBase | null {
    return this.childNodes[0] ?? null
  }
  get lastChild(): NodeBase | null {
    return this.childNodes[this.childNodes.length - 1] ?? null
  }
  get nextSibling(): NodeBase | null {
    const kids = this.parentNode?.childNodes
    if (!kids) return null
    const index = kids.indexOf(this)
    return index >= 0 ? kids[index + 1] ?? null : null
  }
  get tagName(): string {
    return this.nodeName
  }
  get id(): string {
    return this.attributes.get('id') ?? ''
  }
  set id(value: string) {
    this.setAttribute('id', value)
  }
  get classList() {
    const node = this
    return {
      add: (...names: string[]) => {
        const current = new Set(node.className.split(/\s+/).filter(Boolean))
        for (const name of names) current.add(name)
        node.className = [...current].join(' ')
      },
      remove: (...names: string[]) => {
        const drop = new Set(names)
        node.className = node.className.split(/\s+/).filter((name) => name && !drop.has(name)).join(' ')
      },
      contains: (name: string) => node.className.split(/\s+/).includes(name)
    }
  }
  setAttribute(name: string, value: unknown): void {
    const text = String(value)
    this.attributes.set(name, text)
    if (name === 'class') this.className = text
  }
  getAttribute(name: string): string | null {
    if (name === 'class') return this.className || null
    return this.attributes.get(name) ?? null
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name)
    if (name === 'class') this.className = ''
  }
  hasAttribute(name: string): boolean {
    return name === 'class' ? this.className.length > 0 : this.attributes.has(name)
  }
  appendChild(child: NodeBase): NodeBase {
    child.parentNode?.removeChild(child)
    child.parentNode = this
    child.connect(this.isConnected || this.nodeName === '#document')
    this.childNodes.push(child)
    return child
  }
  insertBefore(child: NodeBase, before: NodeBase | null): NodeBase {
    if (!before) return this.appendChild(child)
    child.parentNode?.removeChild(child)
    const index = this.childNodes.indexOf(before)
    child.parentNode = this
    child.connect(this.isConnected)
    if (index < 0) this.childNodes.push(child)
    else this.childNodes.splice(index, 0, child)
    return child
  }
  removeChild(child: NodeBase): NodeBase {
    const index = this.childNodes.indexOf(child)
    if (index >= 0) this.childNodes.splice(index, 1)
    child.parentNode = null
    child.connect(false)
    return child
  }
  contains(node: NodeBase | null): boolean {
    let current = node
    while (current) {
      if (current === this) return true
      current = current.parentNode
    }
    return false
  }
  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }
  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener)
  }
  dispatchEvent(event: Event & { target?: NodeBase; currentTarget?: NodeBase }): boolean {
    const path: NodeBase[] = []
    let current: NodeBase | null = this
    while (current) {
      path.push(current)
      current = current.parentNode
    }
    Object.defineProperty(event, 'target', { value: this, configurable: true })
    for (const node of path) {
      Object.defineProperty(event, 'currentTarget', { value: node, configurable: true })
      for (const listener of node.listeners.get(event.type) ?? []) listener(event)
      if ((event as Event & { cancelBubble?: boolean }).cancelBubble) break
    }
    return !event.defaultPrevented
  }
  getRootNode(): NodeBase {
    return this.ownerDocument ?? this
  }
  focus(): void {
    this.ownerDocument?.setActive(this)
  }
  blur(): void {
    if (this.ownerDocument?.active === this) this.ownerDocument.setActive(null)
  }
  querySelector(selector: string): NodeBase | null {
    return this.querySelectorAll(selector)[0] ?? null
  }
  querySelectorAll(selector: string): NodeBase[] {
    const found: NodeBase[] = []
    const visit = (node: NodeBase) => {
      if (matches(node, selector)) found.push(node)
      for (const child of node.childNodes) visit(child)
    }
    for (const child of this.childNodes) visit(child)
    return found
  }
  get innerHTML(): string {
    return this.childNodes.map((child) => serialize(child)).join('')
  }
  set innerHTML(value: string) {
    this.childNodes = []
    if (value) {
      const text = new NodeBase()
      text.nodeType = 3
      text.nodeName = '#text'
      text.nodeValue = value
      text.textContent = value
      this.appendChild(text)
    }
  }
  private connect(connected: boolean): void {
    this.isConnected = connected
    for (const child of this.childNodes) child.connect(connected)
  }
}

class DocumentNode extends NodeBase {
  nodeType = 9
  nodeName = '#document'
  documentElement: NodeBase
  head: NodeBase
  body: NodeBase
  active: NodeBase | null = null
  defaultView: { getComputedStyle: () => StyleMap; document: DocumentNode } | null = null

  constructor() {
    super()
    this.ownerDocument = this
    this.documentElement = this.createElement('html')
    this.head = this.createElement('head')
    this.body = this.createElement('body')
    super.appendChild(this.documentElement)
    this.documentElement.appendChild(this.head)
    this.documentElement.appendChild(this.body)
    this.isConnected = true
    this.documentElement.isConnected = true
    this.head.isConnected = true
    this.body.isConnected = true
  }
  createElement(tag: string): NodeBase {
    return this.createElementNS(HTML, tag)
  }
  createElementNS(namespace: string, tag: string): NodeBase {
    const node = new NodeBase()
    node.namespaceURI = namespace
    node.nodeName = namespace === SVG ? tag : tag.toUpperCase()
    node.ownerDocument = this
    return node
  }
  createTextNode(text: string): NodeBase {
    const node = new NodeBase()
    node.nodeType = 3
    node.nodeName = '#text'
    node.nodeValue = text
    node.ownerDocument = this
    return node
  }
  createComment(text: string): NodeBase {
    const node = this.createTextNode(text)
    node.nodeType = 8
    node.nodeName = '#comment'
    return node
  }
  get activeElement(): NodeBase | null {
    return this.active ?? this.body
  }
  setActive(node: NodeBase | null): void {
    this.active = node
  }
  getElementById(id: string): NodeBase | null {
    return this.querySelector(`[id="${id}"]`)
  }
}

function matches(node: NodeBase, selector: string): boolean {
  if (selector.startsWith('[')) {
    const named = /\[([\w-]+)(?:="([^"]*)")?\]/.exec(selector)
    if (!named) return false
    const attr = named[1] ?? ''
    return named[2] === undefined ? node.hasAttribute(attr) : node.getAttribute(attr) === named[2]
  }
  if (selector.startsWith('.')) return node.className.split(/\s+/).includes(selector.slice(1))
  return node.nodeName.toLowerCase() === selector.toLowerCase()
}

function serialize(node: NodeBase): string {
  if (node.nodeType === 3) return node.nodeValue ?? ''
  const name = node.nodeName.toLowerCase()
  return `<${name}>${node.childNodes.map((child) => serialize(child)).join('')}</${name}>`
}

class DomEvent {
  type: string
  bubbles: boolean
  cancelable = true
  defaultPrevented = false
  cancelBubble = false
  key = ''
  button = 0
  timeStamp = 0
  isTrusted = false
  eventPhase = 0
  constructor(type: string, init?: { bubbles?: boolean; key?: string }) {
    this.type = type
    this.bubbles = init?.bubbles ?? true
    this.key = init?.key ?? ''
  }
  preventDefault(): void {
    this.defaultPrevented = true
  }
  stopPropagation(): void {
    this.cancelBubble = true
  }
}

let installed = false

/** Install the shim on the global object. Safe to call once per process. */
export function installTestDom(): DocumentNode {
  if (installed) return document as unknown as DocumentNode
  const doc = new DocumentNode()
  const windowLike = {
    document: doc,
    getComputedStyle: () => new StyleMap(),
    HTMLElement: NodeBase,
    HTMLIFrameElement: class HTMLIFrameElement {},
    Element: NodeBase,
    Node: NodeBase,
    Document: DocumentNode,
    SVGElement: NodeBase,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: (fn: FrameRequestCallback) => setTimeout(() => fn(Date.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    getSelection: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true
  }
  doc.defaultView = windowLike
  const globals = globalThis as Record<string, unknown>
  globals.document = doc
  globals.window = windowLike
  globals.HTMLElement = NodeBase
  globals.Element = NodeBase
  globals.Node = NodeBase
  globals.Document = DocumentNode
  globals.SVGElement = NodeBase
  globals.getComputedStyle = windowLike.getComputedStyle
  if (typeof globals.MouseEvent !== 'function') globals.MouseEvent = DomEvent
  if (typeof globals.KeyboardEvent !== 'function') globals.KeyboardEvent = DomEvent
  globals.IS_REACT_ACT_ENVIRONMENT = true
  installed = true
  return doc
}
