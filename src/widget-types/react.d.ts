// React 19 for widgets, trimmed (docs/WIDGETS-PLAN.md §2 "Add Widget Types"): the hooks, components and
// types widgets use, with real signatures; DOM element props are loose (any). Written for Sidestory;
// not @types/react. Names are only those React 19 exports.

declare namespace __CxReact {
  type Key = string | number | bigint;
  type ReactNode = ReactElement | string | number | bigint | boolean | null | undefined | Iterable<ReactNode> | Promise<ReactNode>;
  interface ReactElement<P = any, T = any> {
    type: T;
    props: P;
    key: string | null;
  }
  type JSXElementConstructor<P> = ((props: P) => ReactNode) | (new (props: P) => Component<any, any>);
  type ElementType<P = any> = keyof JSX.IntrinsicElements | JSXElementConstructor<P>;

  interface RefObject<T> {
    current: T;
  }
  type RefCallback<T> = (instance: T | null) => void | (() => void);
  type Ref<T> = RefCallback<T> | RefObject<T | null> | null;

  type Dispatch<A> = (value: A) => void;
  type SetStateAction<S> = S | ((prevState: S) => S);
  type DependencyList = readonly unknown[];
  type EffectCallback = () => void | (() => void);

  type CSSProperties = { [property: string]: string | number | undefined };
  type PropsWithChildren<P = unknown> = P & { children?: ReactNode };
  type FC<P = {}> = (props: P) => ReactNode;
  type FunctionComponent<P = {}> = FC<P>;
  type ComponentType<P = {}> = FC<P> | (new (props: P) => Component<P, any>);
  type ComponentProps<T> = T extends JSXElementConstructor<infer P> ? P : T extends keyof JSX.IntrinsicElements ? JSX.IntrinsicElements[T] : {};
  /** Element props are loose in these types. */
  type HTMLAttributes<T = Element> = { [attribute: string]: any };
  type SVGProps<T = SVGElement> = { [attribute: string]: any };

  // Events: the native event's fields, with React's currentTarget typing.
  type Synthetic<T, E extends Event> = Omit<E, 'target' | 'currentTarget'> & {
    nativeEvent: E;
    currentTarget: EventTarget & T;
    target: EventTarget;
    isDefaultPrevented(): boolean;
    isPropagationStopped(): boolean;
    persist(): void;
  };
  type SyntheticEvent<T = Element, E extends Event = Event> = Synthetic<T, E>;
  type ChangeEvent<T = Element> = Synthetic<T, Event> & { target: EventTarget & T };
  type FormEvent<T = Element> = Synthetic<T, Event>;
  type MouseEvent<T = Element, E extends Event = globalThis.MouseEvent> = Synthetic<T, E>;
  type PointerEvent<T = Element> = Synthetic<T, globalThis.PointerEvent>;
  type KeyboardEvent<T = Element> = Synthetic<T, globalThis.KeyboardEvent>;
  type FocusEvent<T = Element> = Synthetic<T, globalThis.FocusEvent> & { relatedTarget: (EventTarget & Element) | null };
  type WheelEvent<T = Element> = Synthetic<T, globalThis.WheelEvent>;
  type TouchEvent<T = Element> = Synthetic<T, globalThis.TouchEvent>;
  type DragEvent<T = Element> = Synthetic<T, globalThis.DragEvent>;
  type UIEvent<T = Element> = Synthetic<T, globalThis.UIEvent>;
  type AnimationEvent<T = Element> = Synthetic<T, globalThis.AnimationEvent>;
  type TransitionEvent<T = Element> = Synthetic<T, globalThis.TransitionEvent>;
  type ClipboardEvent<T = Element> = Synthetic<T, globalThis.ClipboardEvent>;
  type EventHandler<E> = (event: E) => void;
  type MouseEventHandler<T = Element> = EventHandler<MouseEvent<T>>;
  type ChangeEventHandler<T = Element> = EventHandler<ChangeEvent<T>>;
  type KeyboardEventHandler<T = Element> = EventHandler<KeyboardEvent<T>>;
  type PointerEventHandler<T = Element> = EventHandler<PointerEvent<T>>;

  // Hooks
  function useState<S>(initialState: S | (() => S)): [S, Dispatch<SetStateAction<S>>];
  function useState<S = undefined>(): [S | undefined, Dispatch<SetStateAction<S | undefined>>];
  function useReducer<S, A>(reducer: (state: S, action: A) => S, initialState: S): [S, Dispatch<A>];
  function useReducer<S, A, I>(reducer: (state: S, action: A) => S, initialArg: I, init: (arg: I) => S): [S, Dispatch<A>];
  function useRef<T>(initialValue: T): RefObject<T>;
  function useRef<T>(initialValue: T | null): RefObject<T | null>;
  function useRef<T = undefined>(): RefObject<T | undefined>;
  function useEffect(effect: EffectCallback, deps?: DependencyList): void;
  function useLayoutEffect(effect: EffectCallback, deps?: DependencyList): void;
  function useInsertionEffect(effect: EffectCallback, deps?: DependencyList): void;
  function useMemo<T>(factory: () => T, deps: DependencyList): T;
  function useCallback<T extends Function>(callback: T, deps: DependencyList): T;
  function useContext<T>(context: Context<T>): T;
  function useId(): string;
  function useTransition(): [boolean, (callback: () => void | Promise<void>) => void];
  function startTransition(callback: () => void | Promise<void>): void;
  function useDeferredValue<T>(value: T, initialValue?: T): T;
  function useSyncExternalStore<T>(subscribe: (onChange: () => void) => () => void, getSnapshot: () => T, getServerSnapshot?: () => T): T;
  function useImperativeHandle<T, R extends T>(ref: Ref<T> | undefined, init: () => R, deps?: DependencyList): void;
  function useDebugValue<T>(value: T, format?: (value: T) => any): void;
  function useEffectEvent<T extends Function>(callback: T): T;
  function useOptimistic<S, A = S>(passthrough: S, reducer?: (state: S, action: A) => S): [S, (action: A) => void];
  function useActionState<S, P = void>(action: (state: Awaited<S>, payload: P) => S | Promise<S>, initialState: Awaited<S>): [Awaited<S>, (payload: P) => void, boolean];
  function use<T>(usable: Promise<T> | Context<T>): T;

  // Context, elements, components
  interface Context<T> {
    Provider: FC<{ value: T; children?: ReactNode }>;
    Consumer: FC<{ children: (value: T) => ReactNode }>;
    displayName?: string;
  }
  function createContext<T>(defaultValue: T): Context<T>;
  function createElement(type: any, props?: any, ...children: ReactNode[]): ReactElement;
  function cloneElement<P>(element: ReactElement<P>, props?: Partial<P> & { key?: Key; ref?: any }, ...children: ReactNode[]): ReactElement<P>;
  function isValidElement<P = any>(object: unknown): object is ReactElement<P>;
  function createRef<T>(): RefObject<T | null>;
  function memo<P>(component: FC<P>, arePropsEqual?: (prev: Readonly<P>, next: Readonly<P>) => boolean): FC<P>;
  function forwardRef<T, P = {}>(render: (props: P, ref: Ref<T>) => ReactNode): FC<P & { ref?: Ref<T> }>;
  function lazy<P>(load: () => Promise<{ default: ComponentType<P> }>): FC<P>;
  function cache<F extends Function>(fn: F): F;
  const Children: {
    map<T, C>(children: C | readonly C[], fn: (child: C, index: number) => T): T[];
    forEach<C>(children: C | readonly C[], fn: (child: C, index: number) => void): void;
    count(children: any): number;
    only<C>(children: C): C;
    toArray(children: ReactNode | ReactNode[]): Array<Exclude<ReactNode, boolean | null | undefined>>;
  };
  const Fragment: FC<{ children?: ReactNode; key?: Key }>;
  const StrictMode: FC<{ children?: ReactNode }>;
  const Suspense: FC<{ children?: ReactNode; fallback?: ReactNode }>;
  const Profiler: FC<{ id: string; onRender: (...args: any[]) => void; children?: ReactNode }>;
  const Activity: FC<{ mode?: 'visible' | 'hidden'; children?: ReactNode }>;
  const version: string;

  class Component<P = {}, S = {}> {
    constructor(props: P);
    readonly props: Readonly<P> & { children?: ReactNode };
    state: Readonly<S>;
    setState<K extends keyof S>(state: ((prevState: Readonly<S>, props: Readonly<P>) => Pick<S, K> | S | null) | Pick<S, K> | S | null, callback?: () => void): void;
    forceUpdate(callback?: () => void): void;
    render(): ReactNode;
    componentDidMount?(): void;
    componentDidUpdate?(prevProps: Readonly<P>, prevState: Readonly<S>): void;
    componentWillUnmount?(): void;
    componentDidCatch?(error: unknown, info: { componentStack?: string | null }): void;
  }
  class PureComponent<P = {}, S = {}> extends Component<P, S> {}
}

declare namespace JSX {
  type Element = __CxReact.ReactElement<any, any>;
  /** Components may return any ReactNode (strings, arrays, null), as in React 19. */
  type ElementType = string | __CxReact.JSXElementConstructor<any>;
  interface ElementClass {
    render(): __CxReact.ReactNode;
  }
  interface ElementAttributesProperty {
    props: {};
  }
  interface ElementChildrenAttribute {
    children: {};
  }
  interface IntrinsicAttributes {
    key?: __CxReact.Key | null;
  }
  interface IntrinsicClassAttributes<T> {
    ref?: __CxReact.Ref<T>;
  }
  /** HTML and SVG elements take any props here. */
  interface IntrinsicElements {
    [element: string]: any;
  }
}

declare module 'react' {
  export = __CxReact;
}
declare module 'react/jsx-runtime' {
  export const jsx: (type: any, props: any, key?: __CxReact.Key) => __CxReact.ReactElement;
  export const jsxs: typeof jsx;
  export const Fragment: typeof __CxReact.Fragment;
}
declare module 'react-dom' {
  export function createPortal(children: __CxReact.ReactNode, container: Element | DocumentFragment, key?: __CxReact.Key | null): __CxReact.ReactElement;
  export function flushSync<R>(fn: () => R): R;
  export function unstable_batchedUpdates<R>(fn: () => R): R;
  export function useFormStatus(): { pending: boolean; data: FormData | null; method: string | null; action: any };
  export const version: string;
}
declare module 'react-dom/client' {
  export interface Root {
    render(children: __CxReact.ReactNode): void;
    unmount(): void;
  }
  export function createRoot(container: Element | DocumentFragment, options?: object): Root;
  export function hydrateRoot(container: Element | Document, initialChildren: __CxReact.ReactNode, options?: object): Root;
  export const version: string;
}
